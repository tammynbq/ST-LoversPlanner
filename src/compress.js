// L2／L3 分層壓縮：已經被隱藏的舊樓層，每 N 層連續的摘要壓成一章（L2），每 M 章壓成一卷（L3）。
//
// 存在 chat_metadata.lovers_planner：
//   chapters: [{ id, members: [send_date…], memberIdx: [index…], memberAts: [entry.at…],
//                time, location, summary, status: 'ok'|'fail', error?, at, manual? }]
//   volumes:  [{ id, chapterIds: [id…], chapterAts: [chapter.at…], time, location, summary, status, error?, at, manual? }]
// 用 send_date 認樓層（刪掉訊息後索引會位移）；memberIdx 只是找不到時的提示。
// 成員的摘要被改過（entry.at 變了）、不再是「已摘要」或訊息不見了，那一章就是「過期」；
// 過期的章不注入，改回注入那幾層的單層摘要。卷也一樣。

import { ctx, LOG_PREFIX, MODULE, toast } from './util.js';
import { getSettings } from './settings.js';
import { currentLocale, t } from './i18n.js';
import { getTemplate } from './prompts.js';
import { ApiError } from './api/custom.js';
import { generateText } from './llm.js';
import { errorText } from './errors.js';
import { getChat, getEntry, isAiMessage } from './chat.js';
import { sceneLine } from './lines.js';
import { enqueueCompress, floorState, isActive, setAfterSummaryHook, setCompressHandler } from './summarize.js';
import { computeHidden } from './hide.js';

function record(create) {
    const meta = ctx()?.chatMetadata;
    if (!meta) return null;
    if (!meta[MODULE] && create) meta[MODULE] = {};
    return meta[MODULE] ?? null;
}

function saveMeta() {
    const c = ctx();
    try {
        if (typeof c?.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
        else c?.saveMetadata?.();
    } catch (e) { /* 忽略 */ }
}

export function getChapters() {
    const list = record(false)?.chapters;
    return Array.isArray(list) ? list : [];
}

export function getVolumes() {
    const list = record(false)?.volumes;
    return Array.isArray(list) ? list : [];
}

function newId(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 依 send_date 找回樓層索引；同一個 send_date 有好幾則時，選離提示最近的。 */
function indexFinder() {
    const bySend = new Map();
    getChat().forEach((m, i) => {
        if (!isAiMessage(m)) return;
        const key = m.send_date ?? `#${i}`;
        if (!bySend.has(key)) bySend.set(key, []);
        bySend.get(key).push(i);
    });
    return (sendDate, hint) => {
        const list = bySend.get(sendDate ?? `#${hint}`);
        if (!list?.length) return -1;
        return list.reduce((best, i) => (Math.abs(i - hint) < Math.abs(best - hint) ? i : best), list[0]);
    };
}

function sendDateOf(index) {
    return getChat()[index]?.send_date ?? `#${index}`;
}

/**
 * 整理出目前的章和卷（含狀態和編號），以及哪些樓層已經被「有效的章」涵蓋。
 * 回傳 { chapters: [{ data, indices, state, number }], volumes: [{ data, chapters, state, number }],
 *        covered: Set<樓層>, claimed: Set<樓層>, coveredChapters: Set<章 id>, claimedChapters: Set<章 id> }
 */
export function structure() {
    const find = indexFinder();
    const chapters = getChapters().map((data) => {
        const indices = (data.members ?? []).map((sd, k) => find(sd, data.memberIdx?.[k] ?? 0));
        let state = data.status === 'fail' ? 'fail' : 'ok';
        if (state === 'ok') {
            const broken = indices.some((i, k) => i < 0 || floorState(i) !== 'ok' || getEntry(i)?.at !== data.memberAts?.[k]);
            if (broken) state = 'stale';
        }
        return { data, indices, state, number: 0 };
    }).sort((a, b) => (Math.min(...a.indices.filter((i) => i >= 0), Infinity)) - (Math.min(...b.indices.filter((i) => i >= 0), Infinity)));
    chapters.forEach((c, k) => { c.number = k + 1; });
    const byId = new Map(chapters.map((c) => [c.data.id, c]));

    const volumes = getVolumes().map((data) => {
        const list = (data.chapterIds ?? []).map((id) => byId.get(id));
        let state = data.status === 'fail' ? 'fail' : 'ok';
        if (state === 'ok') {
            const broken = list.some((c, k) => !c || c.state !== 'ok' || c.data.at !== data.chapterAts?.[k]);
            if (broken) state = 'stale';
        }
        return { data, chapters: list.filter(Boolean), state, number: 0 };
    }).sort((a, b) => (a.chapters[0]?.number ?? Infinity) - (b.chapters[0]?.number ?? Infinity));
    volumes.forEach((v, k) => { v.number = k + 1; });

    const covered = new Set();
    const claimed = new Set();
    for (const c of chapters) {
        for (const i of c.indices) {
            if (i < 0) continue;
            claimed.add(i);
            if (c.state === 'ok') covered.add(i);
        }
    }
    const coveredChapters = new Set();
    const claimedChapters = new Set();
    for (const v of volumes) {
        for (const c of v.chapters) {
            claimedChapters.add(c.data.id);
            if (v.state === 'ok') coveredChapters.add(c.data.id);
        }
    }
    return { chapters, volumes, covered, claimed, coveredChapters, claimedChapters };
}

/** 到期要壓成一章的樓層：從最舊的未壓縮樓層開始，連續 N 層已摘要（跳過的不算、遇到沒摘要好的就停）。 */
export function dueChapterFloors(st = structure()) {
    const n = Number(getSettings().compress.l1PerL2) || 10;
    const { keepFrom } = computeHidden();
    const chat = getChat();
    const picked = [];
    for (let i = 0; i < keepFrom; i++) {
        if (!isAiMessage(chat[i]) || st.claimed.has(i)) continue;
        const state = floorState(i);
        if (state === 'skip') continue;
        if (state !== 'ok') return null;
        picked.push(i);
        if (picked.length === n) return picked;
    }
    return null;
}

/** 到期要壓成一卷的章：從最舊的未入卷章開始，連續 M 章有效。 */
export function dueVolumeChapters(st = structure()) {
    const m = Number(getSettings().compress.l2PerL3) || 10;
    const picked = [];
    for (const c of st.chapters) {
        if (st.claimedChapters.has(c.data.id)) continue;
        if (c.state !== 'ok') return null;
        picked.push(c);
        if (picked.length === m) return picked;
    }
    return null;
}

function rangeOf(values) {
    // 值本身可能已經是「A → B」（例如章的時間），只取最前面和最後面。
    const parts = values.flatMap((v) => String(v ?? '').split('→')).map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return '';
    const first = parts[0];
    const last = parts[parts.length - 1];
    return first === last ? first : `${first} → ${last}`;
}

function placesOf(values) {
    const set = [];
    for (const v of values) {
        for (const part of String(v ?? '').split('→').map((x) => x.trim()).filter(Boolean)) {
            if (!set.includes(part)) set.push(part);
        }
    }
    return set.length > 4 ? `${set[0]} … ${set[set.length - 1]}` : set.join('、');
}

/** 壓縮後的目標字數：原文字數 × 壓縮比例（上下限平均）。 */
function targetLength(text) {
    const c = getSettings().compress;
    const ratio = (Number(c.ratioMin) + Number(c.ratioMax)) / 200 || 0.35;
    const zh = currentLocale().startsWith('zh');
    const units = zh ? text.replace(/\s/g, '').length : text.split(/\s+/).filter(Boolean).length;
    return Math.max(20, Math.round((units * ratio) / 10) * 10);
}

/** 壓縮模型的回覆：要的是純文字；包在 ```、或回了 {"summary": …} 也接受。 */
export function parsePlain(raw) {
    let text = String(raw ?? '').trim().replace(/^```\w*\s*/, '').replace(/\s*```$/, '').trim();
    if (text.startsWith('{')) {
        try {
            const obj = JSON.parse(text);
            if (typeof obj?.summary === 'string') text = obj.summary.trim();
        } catch (e) { /* 當純文字 */ }
    }
    if (!text) throw new ApiError('empty');
    return text;
}

function fill(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

async function callModel(templateKey, varName, text) {
    const c = ctx();
    const length = targetLength(text);
    const prompt = fill(getTemplate(templateKey), { [varName]: text, length, char: c?.name2 ?? '', user: c?.name1 ?? '' });
    const raw = await generateText(prompt, { maxTokens: Math.max(1500, length * 3) });
    return parsePlain(raw);
}

function upsert(listName, item) {
    const rec = record(true);
    if (!rec) return;
    const list = Array.isArray(rec[listName]) ? rec[listName] : [];
    const k = list.findIndex((x) => x.id === item.id);
    if (k >= 0) list[k] = item;
    else list.push(item);
    rec[listName] = list;
    saveMeta();
}

/** 把這幾層壓成一章（existing：重新壓縮既有的那一章）。 */
async function compressChapter(indices, existing = null) {
    const entries = indices.map((i) => getEntry(i));
    const text = entries.map((e) => sceneLine(e)).join('\n');
    const base = {
        id: existing?.id ?? newId('ch'),
        members: indices.map(sendDateOf),
        memberIdx: [...indices],
        memberAts: entries.map((e) => e.at),
        time: rangeOf(entries.map((e) => e.time)),
        location: placesOf(entries.map((e) => e.location)),
    };
    try {
        const summary = await callModel('l2', 'summaries', text);
        upsert('chapters', { ...base, summary, status: 'ok', at: Date.now() });
        return true;
    } catch (e) {
        console.warn(LOG_PREFIX, '壓縮成章失敗', e);
        if (existing) upsert('chapters', { ...existing, status: 'fail', error: errorText(e), at: Date.now() });
        else toast(t('compress.failed', { error: errorText(e) }), 'error');
        return false;
    }
}

/** 把這幾章壓成一卷。 */
async function compressVolume(chapters, existing = null) {
    const text = chapters.map((c) => sceneLine({ ...c.data, characters: [] }, t('chapter.label', { n: c.number }))).join('\n');
    const base = {
        id: existing?.id ?? newId('vol'),
        chapterIds: chapters.map((c) => c.data.id),
        chapterAts: chapters.map((c) => c.data.at),
        time: rangeOf(chapters.map((c) => c.data.time)),
        location: placesOf(chapters.map((c) => c.data.location)),
    };
    try {
        const summary = await callModel('l3', 'chapters', text);
        upsert('volumes', { ...base, summary, status: 'ok', at: Date.now() });
        return true;
    } catch (e) {
        console.warn(LOG_PREFIX, '壓縮成卷失敗', e);
        if (existing) upsert('volumes', { ...existing, status: 'fail', error: errorText(e), at: Date.now() });
        else toast(t('compress.failed', { error: errorText(e) }), 'error');
        return false;
    }
}

/**
 * 佇列裡的壓縮工作（summarize.js 呼叫）。
 * target：章／卷的 id → 用目前還在、還有效的成員重新壓縮；null → 把所有到期的壓完。
 */
export async function runCompression(target) {
    if (!isActive()) return;
    if (target) {
        const st = structure();
        const ch = st.chapters.find((c) => c.data.id === target);
        if (ch) {
            const alive = ch.indices.filter((i) => i >= 0 && floorState(i) === 'ok');
            if (alive.length) await compressChapter(alive, ch.data);
            else deleteChapter(target);
            return;
        }
        const vol = st.volumes.find((v) => v.data.id === target);
        if (vol) {
            const alive = vol.chapters.filter((c) => c.state === 'ok');
            if (alive.length) await compressVolume(alive, vol.data);
            else deleteVolume(target);
        }
        return;
    }
    // 一次最多壓 20 次，避免意外的無限迴圈。
    for (let k = 0; k < 20; k++) {
        const st = structure();
        const floors = dueChapterFloors(st);
        if (floors) {
            if (!(await compressChapter(floors))) return;
            continue;
        }
        const chapters = dueVolumeChapters(st);
        if (chapters) {
            if (!(await compressVolume(chapters))) return;
            continue;
        }
        return;
    }
}

/** 有沒有到期要壓縮的。 */
export function compressionDue() {
    const st = structure();
    return Boolean(dueChapterFloors(st) || dueVolumeChapters(st));
}

export function editChapter(id, summary) {
    const ch = getChapters().find((c) => c.id === id);
    const text = String(summary ?? '').trim();
    if (!ch || !text) return false;
    upsert('chapters', { ...ch, summary: text, status: 'ok', error: undefined, manual: true, at: Date.now() });
    return true;
}

export function editVolume(id, summary) {
    const vol = getVolumes().find((v) => v.id === id);
    const text = String(summary ?? '').trim();
    if (!vol || !text) return false;
    upsert('volumes', { ...vol, summary: text, status: 'ok', error: undefined, manual: true, at: Date.now() });
    return true;
}

export function deleteChapter(id) {
    const rec = record(false);
    if (!rec?.chapters) return;
    rec.chapters = rec.chapters.filter((c) => c.id !== id);
    saveMeta();
}

export function deleteVolume(id) {
    const rec = record(false);
    if (!rec?.volumes) return;
    rec.volumes = rec.volumes.filter((v) => v.id !== id);
    saveMeta();
}

export function initCompression() {
    setCompressHandler(runCompression);
    // 每摘要好一層就檢查一次：有到期的就排一個壓縮工作。
    setAfterSummaryHook(() => {
        if (getSettings().compress.auto && isActive() && compressionDue()) enqueueCompress();
    });
}
