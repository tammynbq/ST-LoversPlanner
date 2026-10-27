// 回憶錄（使用者要求）：值得珍藏的時刻，不參與壓縮，偶爾讓角色自然想起。
//
// 來源：
//   1. 摘要時模型挑的（entry.keepsakes：[{ title, content, theater? }]，寧缺勿濫）。小劇場另外給模型看，
//      不寫進正劇摘要，有意義的才收進來（filter.theater = 'keepsake'）。
//   2. 使用者手動收藏的（chat_metadata.lovers_planner.memories.manual）。
// 使用者可以編輯（edited）、刪除（removed）。key：樓層的是「send_date#k」，手動的是 id。
//
// 想起過去：每一回生成時，大約 1/everyN 的機率挑 1～count 條「夠舊、最近沒提過」的回憶，
// 用「可以自然提起，不勉強」的方式送給角色。同一回重新生成時結果一樣（用最新的使用者發言決定）。

import { ctx, MODULE } from './util.js';
import { getSettings } from './settings.js';
import { t } from './i18n.js';
import { aiIndices, chatKey, getChat, getEntry, hashText, isUserMessage } from './chat.js';
import { aliasesOf } from './recall.js';

const MAX_TITLE = 30;
const MAX_CONTENT = 200;

export function memoriesOn() {
    return Boolean(getSettings().memories?.enabled);
}

/** 模型回報的 keepsakes 整理成固定格式（最多 2 條）。 */
export function cleanKeepsakes(raw) {
    const out = [];
    for (const x of Array.isArray(raw) ? raw : []) {
        const title = String(x?.title ?? '').trim().slice(0, MAX_TITLE);
        const content = String(x?.content ?? x?.summary ?? '').trim().slice(0, MAX_CONTENT);
        if (!content) continue;
        const theater = /theater|小劇場|小剧场|番外/i.test(String(x?.from ?? '')) || x?.theater === true;
        out.push({ title: title || content.slice(0, 12), content, ...(theater ? { theater: true } : {}) });
    }
    return out.slice(0, 2);
}

// ===== 存取 =====

function record(create) {
    const meta = ctx()?.chatMetadata;
    if (!meta) return null;
    if (!meta[MODULE] && create) meta[MODULE] = {};
    const rec = meta[MODULE];
    if (rec && !rec.memories && create) rec.memories = { manual: [], removed: [], edited: {}, surfaced: {} };
    return rec?.memories ?? null;
}

const listeners = new Set();
export function onMemoriesChange(fn) {
    listeners.add(fn);
}

function save() {
    const c = ctx();
    try {
        if (typeof c?.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
        else c?.saveMetadata?.();
    } catch (e) { /* 忽略 */ }
    for (const fn of listeners) {
        try { fn(); } catch (e) { console.error(e); }
    }
}

/** 樓層在「第幾個 AI 樓層」（用來算回憶有多舊、多久沒提）。 */
function aiOrdinal() {
    const map = new Map();
    aiIndices().forEach((i, k) => map.set(i, k));
    return map;
}

/**
 * 所有回憶，依故事順序：[{ key, source: 'floor'|'manual', floor, title, content, theater, date, time, surfaced, pinnedNext }]。
 */
/**
 * 回憶是故事裡的哪時候（使用者要求：回憶錄要看得出是哪時候的）。
 * 那一層有日期就用；沒有（沒開行事曆、粗略補建、小劇場）就往前找最近有日期的樓層，再不行往後找，標成「約」。
 * 時間（例如「第三天 晚上」）也一樣往前找。一次算好整個聊天，回傳 (index) => { date, time, dateGuessed }。
 */
function storyWhen() {
    const idx = aiIndices();
    const pos = new Map(idx.map((i, k) => [i, k]));
    const dates = idx.map((i) => {
        const e = getEntry(i);
        return e?.status === 'ok' ? String(e.date ?? '') : '';
    });
    const times = idx.map((i) => {
        const e = getEntry(i);
        return e?.status === 'ok' ? String(e.time ?? '') : '';
    });
    const prevDate = [];
    const prevTime = [];
    let d = '';
    let tm = '';
    for (let k = 0; k < idx.length; k++) {
        if (dates[k]) d = dates[k];
        if (times[k]) tm = times[k];
        prevDate[k] = d;
        prevTime[k] = tm;
    }
    const nextDate = [];
    d = '';
    for (let k = idx.length - 1; k >= 0; k--) {
        if (dates[k]) d = dates[k];
        nextDate[k] = d;
    }
    return (i) => {
        const k = pos.get(i);
        if (k === undefined) return { date: '', time: '', dateGuessed: false };
        const own = getEntry(i);
        const date = (own?.date ? String(own.date) : '') || prevDate[k] || nextDate[k] || '';
        const time = (own?.time ? String(own.time) : '') || prevTime[k] || '';
        return { date, time, dateGuessed: Boolean(date && !own?.date) };
    };
}

// 從別的聊天帶來的回憶（carry.js 提供，避免互相 import）：
// fn() → [{ origin, title, content, date, time, theater, from（來源聊天）, linked（即時共用、唯讀） }]
let baseProvider = null;
export function setMemoriesBase(fn) {
    baseProvider = fn;
}

/** 這個聊天自己的回憶在快照裡的識別（帶到別的聊天後，用來認「是不是同一條」）。 */
export function memoryOrigin(m) {
    return m.origin ?? `${chatKey() ?? ''}#${m.key}`;
}

export function listMemories() {
    const rec = record(false);
    const removed = new Set(rec?.removed ?? []);
    const edited = rec?.edited ?? {};
    const surfaced = rec?.surfaced ?? {};
    const chat = getChat();
    const out = [];
    const when = storyWhen();
    for (const i of aiIndices()) {
        const e = getEntry(i);
        if ((e?.status !== 'ok' && e?.status !== 'side') || !Array.isArray(e.keepsakes)) continue;
        e.keepsakes.forEach((m, k) => {
            const key = `${chat[i]?.send_date ?? `#${i}`}#${k}`;
            if (removed.has(key)) return;
            out.push({ ...m, ...(edited[key] ?? {}), key, source: 'floor', floor: i, ...when(i), surfaced: surfaced[key] ?? null });
        });
    }
    for (const m of rec?.manual ?? []) {
        const floor = chat.findIndex((x) => x?.send_date && x.send_date === m.sendDate);
        const w = floor >= 0 ? when(floor) : { date: '', time: '', dateGuessed: false };
        out.push({ ...m, key: m.id, source: 'manual', floor: floor >= 0 ? floor : null, ...w, ...(m.date ? { date: m.date, dateGuessed: false } : {}), surfaced: surfaced[m.id] ?? null });
    }
    // 帶來的（或即時共用的）回憶：排在這個聊天自己的前面（比較舊）；同一條（origin 一樣）只列一次。
    let carried = [];
    try { carried = baseProvider?.() ?? []; } catch (e) { console.error(e); }
    const seen = new Set(out.map((m) => memoryOrigin(m)));
    const before = [];
    for (const m of carried) {
        if (!m?.origin || !m.content || seen.has(m.origin)) continue;
        seen.add(m.origin);
        const key = `carry:${m.origin}`;
        if (removed.has(key)) continue;
        before.push({ ...m, ...(edited[key] ?? {}), key, source: 'carried', floor: null, dateGuessed: false, surfaced: surfaced[key] ?? null });
    }
    return [...before, ...out.sort((a, b) => (a.floor ?? Infinity) - (b.floor ?? Infinity))];
}

/** 手動收藏（floor：從哪一層收藏；沒有就是沒有出處的回憶）。 */
export function addMemory({ title = '', content = '', floor = null, theater = false }) {
    const text = String(content).trim().slice(0, MAX_CONTENT);
    if (!text) return null;
    const rec = record(true);
    const m = getChat()[floor];
    const item = {
        id: `mem_${Math.random().toString(36).slice(2, 8)}`,
        title: String(title).trim().slice(0, MAX_TITLE) || text.slice(0, 12),
        content: text,
        ...(m?.send_date ? { sendDate: m.send_date } : {}),
        ...(floor !== null && getEntry(floor)?.date ? { date: getEntry(floor).date } : {}),
        ...(theater ? { theater: true } : {}),
        at: Date.now(),
    };
    rec.manual = [...(rec.manual ?? []), item];
    save();
    return item;
}

export function editMemory(key, { title, content }) {
    const rec = record(true);
    const text = String(content ?? '').trim().slice(0, MAX_CONTENT);
    if (!text) return false;
    const patch = { title: String(title ?? '').trim().slice(0, MAX_TITLE) || text.slice(0, 12), content: text };
    const manual = (rec.manual ?? []).find((x) => x.id === key);
    if (manual) Object.assign(manual, patch);
    else rec.edited = { ...(rec.edited ?? {}), [key]: patch };
    save();
    return true;
}

export function removeMemory(key) {
    const rec = record(true);
    if ((rec.manual ?? []).some((x) => x.id === key)) rec.manual = rec.manual.filter((x) => x.id !== key);
    else rec.removed = [...new Set([...(rec.removed ?? []), key])];
    save();
    return true;
}

/** 下一回一定提起這條（使用者指定）。 */
export function surfaceNext(key, on = true) {
    const rec = record(true);
    rec.next = on ? key : null;
    save();
}

export function nextPinned() {
    return record(false)?.next ?? null;
}

// ===== 想起過去 =====

/** 把雜湊值再攪一次（FNV 的低位元分布不均，直接取餘數會偏）。 */
function mix(text) {
    let h = parseInt(hashText(text), 16) || 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

/** 這一回要不要想起過去：用最新一句使用者發言決定，重新生成時結果一樣。 */
function rollFor(everyN) {
    const chat = getChat();
    let last = null;
    for (let i = chat.length - 1; i >= 0; i--) if (isUserMessage(chat[i])) { last = chat[i]; break; }
    const seed = mix(`${last?.send_date ?? ''}|${last?.mes ?? ''}`);
    return { hit: seed % Math.max(1, everyN) === 0, seed };
}

/**
 * 挑這一回要提起的回憶（可能是空的）。text：最新原文（看和現在聊的內容有沒有關係）。
 * 回傳 [{ ...memory }]。不會改任何資料；送出後由 markSurfaced() 記下。
 */
export function pickReminders(text = '') {
    const s = getSettings().memories ?? {};
    if (!memoriesOn() || !s.recall) return [];
    const all = listMemories();
    if (!all.length) return [];
    const ord = aiOrdinal();
    const now = aiIndices().length;
    const pinned = nextPinned();
    if (pinned) {
        const m = all.find((x) => x.key === pinned);
        if (m) return [m];
    }
    const { hit, seed } = rollFor(Number(s.everyN) || 10);
    if (!hit) return [];
    const minAge = Math.max(0, Number(s.minAge) || 0);
    const cooldown = Math.max(0, Number(s.cooldown) || 0);
    const lower = String(text).toLowerCase();
    // 同一回（重新生成）提過的不算「剛提過」，這樣重新生成會挑到一樣的。
    const turns = record(false)?.surfacedTurn ?? {};
    const lastAt = (m) => (m.surfaced === null || turns[m.key] === seed ? null : m.surfaced);
    const scored = all.filter((m) => {
        const age = m.floor === null ? Infinity : now - (ord.get(m.floor) ?? now);
        if (age < minAge) return false;
        return lastAt(m) === null || now - lastAt(m) >= cooldown;
    }).map((m) => {
        // 和現在聊的有關（同樣的名字、地點、詞）加分；越久沒提越容易被想起。
        const words = aliasesOf(`${m.title}（${m.content.replace(/[，。、！？「」]/g, '（')}）`).filter((w) => w.length >= 2);
        const related = words.filter((w) => lower.includes(w)).length;
        const quiet = lastAt(m) === null ? 1 : Math.min(1, (now - lastAt(m)) / Math.max(1, cooldown * 3));
        // 用 seed 加一點隨機，讓每次挑的不一樣（但同一回重新生成時一樣）。
        const jitter = (mix(`${seed}|${m.key}`) % 1000) / 1000;
        return { m, score: related * 2 + quiet + jitter };
    }).sort((a, b) => b.score - a.score);
    const n = 1 + (seed % Math.max(1, Number(s.count) || 1));
    return scored.slice(0, n).map((x) => x.m);
}

/** 送出了這些回憶：記下是在第幾個 AI 樓層提的（冷卻用）；指定的「下次提起」用掉。 */
export function markSurfaced(list) {
    if (!list.length) return;
    const rec = record(true);
    const now = aiIndices().length;
    const { seed } = rollFor(Number(getSettings().memories?.everyN) || 10);
    rec.surfaced = { ...(rec.surfaced ?? {}) };
    rec.surfacedTurn = { ...(rec.surfacedTurn ?? {}) };
    for (const m of list) {
        // 同一回重新生成時，維持第一次提起的樓層數，不要越記越後面。
        if (rec.surfacedTurn[m.key] !== seed) rec.surfaced[m.key] = now;
        rec.surfacedTurn[m.key] = seed;
    }
    if (rec.next && list.some((m) => m.key === rec.next)) rec.next = null;
    save();
}

/** 注入用的文字。 */
export function remindersText(list) {
    if (!list.length) return '';
    const lines = list.map((m) => {
        const when = [m.date, m.time].filter(Boolean).join(' ');
        return `- ${when ? `${when}｜` : ''}${m.title}：${m.content}`;
    });
    return `${t('mem.inject.intro')}\n${lines.join('\n')}`;
}
