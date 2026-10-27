// 補建舊樓層：聊了很久才開始用插件時，把摘要和記事一次補起來（使用者要求）。
//
// 「舊的粗、新的細」：
//   最近 N 層：和平常一樣一層一層摘要（單層摘要＋記事）。
//   更舊的：每 M 層連續的樓層讀一次原文，直接寫成一章（章節總結＋這一段的記事變化），
//          呼叫次數大約少七到九成。這些樓層標成「粗略」，沒有自己的單層摘要。
// 進度存在聊天裡（chat_metadata.lovers_planner.catchup）。切 App、關掉、出錯都會暫停，
// 回到這個聊天時跳通知問要不要繼續。

import { ctx, LOG_PREFIX, MODULE, toast, toastActions } from './util.js';
import { getSettings, trackedNoteTypes } from './settings.js';
import { currentLocale, t } from './i18n.js';
import { getTemplate } from './prompts.js';
import { countTokens, generateText } from './llm.js';
import { errorText } from './errors.js';
import { buildL1Parts } from './l1rules.js';
import {
    aiIndices, chatKey, floorSource, floorStatus, getChat, getEntry, isAiMessage, lastAiIndex, saveChatSoon, setEntry,
} from './chat.js';
import { formatNotesForPrompt, normalizeModelOps, replay } from './notes.js';
import {
    cancelQueue, enqueue, enqueueCoarse, isActive, parseL1, pendingCount, previousDate, setAfterSummaryHook, setCoarseHandler, sideFloor, skipFloor,
} from './summarize.js';
import { refreshDigestMeta, saveChapter, setCoarseRedo, structure } from './compress.js';
import { estimateTokens } from './hide.js';
import { cleanForSummary, extractRef, extractTheater, scanTags, tagMode } from './filter.js';
import { calendarOn, cleanEvents, normDate } from './calendar.js';
import { cleanKeepsakes, memoriesOn } from './memories.js';

/** 每次呼叫除了原文之外，提示詞本身（規則、記事清單）大約多少 token。 */
const PROMPT_OVERHEAD = 700;

function chatRecord(create) {
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

/** 目前的補建進度：{ from, to, fineFrom, block, total, paused, error? } 或 null。 */
export function getCatchup() {
    return chatRecord(false)?.catchup ?? null;
}

/** 可以補建的樓層：還沒摘要的 AI 樓層（「開始下回前」模式不含最新一層，它要等定案）。 */
function candidates(from, to) {
    const last = getSettings().summary.mode === 'before' ? lastAiIndex() : -1;
    return aiIndices().filter((i) => i >= from && i <= to && i !== last && floorStatus(i) === 'none');
}

/**
 * 算出怎麼補：{ coarse: [[樓層…]…], fine: [樓層…], floors, calls, tokens }。
 * fineFrom：從這一層開始逐層細摘；更舊的每 block 層寫成一章（遇到已摘要的樓層就斷開）。
 */
export function planCatchup({ from, to, fineFrom, block }) {
    const list = candidates(from, to);
    const fine = list.filter((i) => i >= fineFrom);
    const old = new Set(list.filter((i) => i < fineFrom));
    const coarse = [];
    let cur = [];
    for (const i of aiIndices()) {
        if (i < from || i >= fineFrom) continue;
        if (!old.has(i)) {
            // 中間有已經摘要過（或跳過、失敗）的樓層：斷開，不要跨過它。
            if (cur.length) coarse.push(cur);
            cur = [];
            continue;
        }
        cur.push(i);
        if (cur.length >= block) {
            coarse.push(cur);
            cur = [];
        }
    }
    if (cur.length) coarse.push(cur);
    const chat = getChat();
    const withUser = getSettings().summary.includeUser;
    // 和實際送出的一樣：照「摘要時跳過的內容」整理過才算（注意不能直接 map(cleanForSummary)，索引會被當成規則）。
    const raw = (i) => {
        const src = floorSource(i);
        const texts = [...(withUser ? src.users.map((u) => u.mes) : []), chat[i]?.mes ?? ''];
        return estimateTokens([...texts.map((x) => cleanForSummary(x)), extractRef(chat[i]?.mes ?? '')].join('\n'));
    };
    const tokens = list.reduce((n, i) => n + raw(i), 0) + (coarse.length + fine.length) * PROMPT_OVERHEAD;
    return { coarse, fine, floors: list.length, calls: coarse.length + fine.length, tokens };
}

let tagCache = { key: '', value: [] };

/**
 * 這個範圍裡「還會送出」的標籤（照目前的設定整理過、但先不拿掉 HTML 標籤，才看得到標籤名稱），
 * 依佔的 token 由多到少：[{ name, tokens, floors, first, last, sample }]。讓使用者在補建前決定要不要跳過。
 */
export function catchupTags({ from, to }) {
    const rules = getSettings().filter;
    const chat = getChat();
    const list = candidates(from, to);
    const key = JSON.stringify([chatKey(), chat.length, from, to, list.length, rules]);
    if (tagCache.key === key) return tagCache.value;
    const loose = { ...rules, html: false };
    const messages = list.map((i) => {
        const src = floorSource(i);
        const texts = [...(getSettings().summary.includeUser ? src.users.map((u) => u.mes) : []), chat[i]?.mes ?? ''];
        return { index: i, text: texts.map((x) => cleanForSummary(x, loose)).join('\n') };
    });
    const value = scanTags(messages)
        .filter((x) => x.tokens > 0 && tagMode(x.name).mode !== 'skip')
        .sort((a, b) => b.tokens - a.tokens);
    tagCache = { key, value };
    return value;
}

/** 從第 fineCount 個（由新往舊數）候選樓層開始逐層細摘。 */
export function fineFromFor(from, to, fineCount) {
    const list = candidates(from, to);
    if (fineCount <= 0) return Infinity;
    return list.length > fineCount ? list[list.length - fineCount] : (list[0] ?? Infinity);
}

/** 照設定排進佇列：先粗略的（由舊到新），再逐層細摘的。 */
function schedule(rec) {
    const plan = planCatchup(rec);
    for (const indices of plan.coarse) enqueueCoarse(indices);
    for (const i of plan.fine) enqueue(i);
    return plan;
}

// ===== 番外／小劇場／IF 線（v0.13.5，使用者要求） =====
// 開始或繼續補建前，先掃一遍還沒補的樓層：使用者的發言、AI 回覆的開頭，或回覆裡很短的一行（像標題）
// 出現了這些字眼，就先停下來列給使用者看（附上一部分正文），決定要跳過還是照常摘要，決定完才開始。
// 決定記在 catchup.extras（send_date → 'skip'|'side'|'keep'），不會再問。

/** AI 回覆從開頭看多少字；之後只看很短的行（標題）。 */
const EXTRA_HEAD = 300;
const EXTRA_HEADING = 40;

function extraWords() {
    const s = getSettings().catchup ?? {};
    if (s.askExtras === false) return [];
    return String(s.extraWords ?? '').split(/[,，、;；\n]+/).map((x) => x.trim()).filter(Boolean);
}

/** 決定過的（send_date → 'skip'|'side'|'keep'）：存在聊天資料裡，補建結束後也還在。舊版存在 catchup.extras。 */
function decidedExtras() {
    const rec = chatRecord(false);
    return { ...(rec?.catchup?.extras ?? {}), ...(rec?.extras ?? {}) };
}

/** 還沒決定過、可能是番外的樓層：[{ index, word, user, excerpt, around }]。 */
export function findExtras(from, to) {
    return scanExtras(candidates(from, to));
}

/**
 * 重新檢查本窗口所有樓層（資料管理，v0.13.7）：已經摘要、壓縮過的也看；已經跳過或決定過的不列。
 * 每一項多一個 chapter：已經在第幾章裡（跳過後那一章要重新壓縮）。
 */
export function findExtrasAll() {
    const list = scanExtras(aiIndices().filter((i) => !['skip', 'side'].includes(floorStatus(i))));
    const st = structure();
    return list.map((x) => ({ ...x, chapter: st.chapters.find((c) => c.indices.includes(x.index))?.number ?? null }));
}

function scanExtras(indices) {
    const words = extraWords();
    if (!words.length) return [];
    const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
    const decided = decidedExtras();
    const chat = getChat();
    const out = [];
    for (const i of indices) {
        if (decided[chat[i]?.send_date ?? `#${i}`]) continue;
        const src = floorSource(i);
        const user = src.users.map((u) => cleanForSummary(u.mes)).join('\n').trim();
        const ai = cleanForSummary(chat[i]?.mes ?? '');
        const heads = ai.split('\n').map((l) => l.trim()).filter((l) => l && l.length <= EXTRA_HEADING);
        const hit = [user, ai.slice(0, EXTRA_HEAD), ...heads].map((x) => x.match(re)).find(Boolean);
        if (!hit) continue;
        // 字眼出現在回覆後面（標題行）：另外附上那附近的文字。
        const pos = ai.search(re);
        const around = pos > 150 ? ai.slice(Math.max(0, pos - 60), pos + 90) : '';
        out.push({ index: i, word: hit[0], user: user.slice(0, 150), excerpt: ai.slice(0, 600), around });
    }
    return out;
}

/** 開始／繼續前檢查：有還沒決定的番外就停下來（回傳找到幾層），沒有就回傳 0。 */
function holdForExtras(rec) {
    const n = findExtras(rec.catchup.from, rec.catchup.to).length;
    if (!n) {
        if (rec.catchup.asking) {
            rec.catchup = { ...rec.catchup, asking: false };
            saveMeta();
        }
        return 0;
    }
    rec.catchup = { ...rec.catchup, paused: true, asking: true, error: null };
    saveMeta();
    return n;
}

/**
 * 使用者決定了：choices = { index: 'skip' | 'side' | 'keep' }。跳過的標成 👻 跳過、小劇場的標成 ⭐ 小劇場並排隊讀一次
 * （和平常的一樣，之後可以取消），
 * 照常的記下來不再問；然後繼續補建。
 */
export function decideExtras(choices) {
    const rec = chatRecord(false);
    if (!rec?.catchup) return null;
    applyExtras(choices);
    rec.catchup = { ...rec.catchup, asking: false };
    saveMeta();
    return resumeCatchup();
}

/** 套用選擇（不管補建）：跳過的標成跳過、小劇場的標成小劇場，照常的記下來不再問。回傳改了幾層。 */
export function applyExtras(choices) {
    const rec = chatRecord(true);
    const chat = getChat();
    const extras = { ...(rec.extras ?? {}) };
    let skipped = 0;
    for (const [k, choice] of Object.entries(choices)) {
        const i = Number(k);
        if (!chat[i]) continue;
        const c = ['keep', 'side'].includes(choice) ? choice : 'skip';
        extras[chat[i].send_date ?? `#${i}`] = c;
        if (c === 'keep') continue;
        if (c === 'side') sideFloor(i);
        else skipFloor(i);
        skipped++;
    }
    rec.extras = extras;
    saveMeta();
    return skipped;
}

export function startCatchup({ from, to, fineCount, block }) {
    if (!isActive()) return null;
    const rec = chatRecord(true);
    const fineFrom = fineFromFor(from, to, fineCount);
    const total = candidates(from, to).length;
    if (!total) return null;
    rec.catchup = { from, to, fineFrom: Number.isFinite(fineFrom) ? fineFrom : null, block, total, paused: false, startedAt: Date.now() };
    saveMeta();
    const ask = holdForExtras(rec);
    if (ask) return { ask };
    return schedule(normalized(rec.catchup));
}

function normalized(c) {
    return { ...c, fineFrom: c.fineFrom ?? Infinity };
}

/** 還剩幾層沒補。 */
export function remaining() {
    const c = getCatchup();
    return c ? candidates(c.from, c.to).length : 0;
}

export function resumeCatchup() {
    const rec = chatRecord(false);
    if (!rec?.catchup) return null;
    rec.catchup = { ...rec.catchup, paused: false, error: null };
    saveMeta();
    const ask = holdForExtras(rec);
    if (ask) return { ask };
    return schedule(normalized(rec.catchup));
}

/** 暫停：清掉佇列，進度留著。 */
export function pauseCatchup(error = null) {
    const rec = chatRecord(false);
    if (!rec?.catchup) return;
    cancelQueue();
    rec.catchup = { ...rec.catchup, paused: true, error };
    saveMeta();
}

/** 放棄：清掉佇列和進度（已經補好的保留）。 */
export function abandonCatchup() {
    const rec = chatRecord(false);
    if (!rec?.catchup) return;
    cancelQueue();
    delete rec.catchup;
    saveMeta();
}

// ===== 把一段舊樓層寫成一章 =====

function fill(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

function lengthUnits(content, tokens, targetTokens) {
    const zh = currentLocale().startsWith('zh');
    const units = zh ? content.replace(/\s/g, '').length : content.split(/\s+/).filter(Boolean).length;
    return Math.max(20, Math.round((targetTokens * units) / Math.max(tokens, 1) / 10) * 10);
}

/** 這一段前面最近一個有時間或地點的樓層（讓模型延續）。 */
function previousText(index) {
    for (let i = index - 1; i >= 0; i--) {
        const e = isAiMessage(getChat()[i]) ? getEntry(i) : null;
        if (e?.status === 'ok' && (e.time || e.location)) {
            return `${t('prompt.previousLabel')}${[t('prompt.previousTime', { time: e.time || '—' }), t('prompt.previousLocation', { location: e.location || '—' })].join('｜')}`;
        }
    }
    return '';
}

/** 「A → B」取最後一段（用來當每層的時間、地點）。 */
function lastPart(text) {
    const parts = String(text ?? '').split(/\s*(?:→|->)\s*/).filter(Boolean);
    return parts[parts.length - 1] ?? '';
}

function firstPart(text) {
    return String(text ?? '').split(/\s*(?:→|->)\s*/).filter(Boolean)[0] ?? '';
}

async function buildPrompt(indices) {
    const s = getSettings();
    const c = ctx();
    const chat = getChat();
    const parts = [];
    for (const i of indices) {
        const src = floorSource(i);
        if (s.summary.includeUser) for (const u of src.users) parts.push(`${u.name ?? c?.name1 ?? 'User'}: ${cleanForSummary(u.mes)}`);
        parts.push(`${chat[i].name ?? c?.name2 ?? 'Character'}: ${cleanForSummary(chat[i].mes)}`);
    }
    const keep = memoriesOn() && s.memories?.auto;
    const theater = keep ? indices.map((i) => extractTheater(chat[i].mes)).filter(Boolean).join('\n\n') : '';
    // 只當參考的標籤：每層一行（第幾樓＋抽出來的日期、時間、地點）。
    const ref = indices.map((i) => {
        const lines = extractRef(chat[i].mes);
        return lines ? `#${i} ${lines.split('\n').join('；')}` : '';
    }).filter(Boolean).join('\n');
    const content = parts.join('\n\n') + (theater ? `\n\n${t('prompt.theaterLabel')}\n${theater}` : '') + (ref ? `\n\n${t('prompt.refLabel')}\n${ref}` : '');
    const tokens = await countTokens(content);
    // 一章大約是單層摘要的三到四成；單層摘要是原文的 3～6%。
    const l1 = (s.summary.ratioMin + s.summary.ratioMax) / 200;
    const l2 = (s.compress.ratioMin + s.compress.ratioMax) / 200;
    const target = Math.min(600, Math.max(80, Math.round(tokens * l1 * l2 * 2)));
    const length = lengthUnits(content, tokens, target);
    const notesBefore = replay({ upTo: indices[0] }).notes;
    const { rules, format } = buildL1Parts({ length, char: c?.name2 ?? '', user: c?.name1 ?? '', chapter: true, previousDate: previousDate(indices[0]), theater: Boolean(theater) });
    const prompt = fill(getTemplate('catchup'), {
        char: c?.name2 ?? '',
        user: c?.name1 ?? '',
        length,
        content,
        rules,
        format,
        notes: trackedNoteTypes().length ? `${t('prompt.notesLabel')}\n${formatNotesForPrompt(notesBefore)}` : '',
        previous: previousText(indices[0]),
    }).replace(/\n{3,}/g, '\n\n');
    return { prompt, notesBefore, maxTokens: Math.max(2500, target * 3 + 2000) };
}

/**
 * 把這幾層寫成一章。existing：重做既有的粗略章（沿用 id）。
 * 每層寫一個「粗略」的記錄（沒有單層摘要），這一段的記事變化記在最後一層。
 */
export async function runCoarse(indices, existing = null) {
    const chatId = chatKey();
    const msgs = indices.map((i) => getChat()[i]);
    const stillHere = () => chatKey() === chatId && indices.every((i, k) => getChat()[i] === msgs[k]);
    try {
        const built = await buildPrompt(indices);
        const parsed = parseL1(await generateText(built.prompt, { maxTokens: built.maxTokens, purpose: 'catchup' }));
        if (!stillHere()) return false;
        const last = indices[indices.length - 1];
        const prevOps = existing ? (getEntry(last)?.ops ?? []) : [];
        const ops = normalizeModelOps(parsed.ops, built.notesBefore, prevOps, { types: trackedNoteTypes() })
            .map((op) => ({ ...op, block: true }));
        const at = Date.now();
        const time = lastPart(parsed.time);
        const location = lastPart(parsed.location);
        for (const i of indices) {
            setEntry(i, {
                v: 2, status: 'ok', coarse: true, time, location, characters: parsed.characters,
                summary: '', ops: i === last ? ops : [], hash: floorSource(i).hash, at,
                // 行事曆：這一段的日期和事件記在最後一層（前面幾層延續上一個日期）。
                ...(calendarOn() && i === last ? { date: normDate(parsed.date), events: cleanEvents(parsed.events) } : {}),
                ...(memoriesOn() && getSettings().memories?.auto && i === last ? { keepsakes: cleanKeepsakes(parsed.keepsakes) } : {}),
            });
        }
        saveChapter({
            id: existing?.id ?? `ch_${Math.random().toString(36).slice(2, 8)}`,
            coarse: true,
            members: indices.map((i) => getChat()[i]?.send_date ?? `#${i}`),
            memberIdx: [...indices],
            memberAts: indices.map(() => at),
            time: parsed.time && firstPart(parsed.time) !== lastPart(parsed.time) ? `${firstPart(parsed.time)} → ${lastPart(parsed.time)}` : (parsed.time ?? ''),
            location: parsed.location ?? '',
            summary: parsed.summary,
            status: 'ok',
            at,
        });
        // 時間補上日期、地點歸納（和一般壓縮的章一樣）。
        refreshDigestMeta();
        saveChatSoon();
        return true;
    } catch (e) {
        console.warn(LOG_PREFIX, '粗略補建失敗', e);
        if (!stillHere()) return false;
        const message = errorText(e);
        if (existing) {
            saveChapter({ ...existing, status: 'fail', error: message, at: Date.now() });
        } else if (getCatchup()) {
            pauseCatchup(message);
            toast(t('catchup.paused', { error: message }), 'error');
        } else {
            toast(t('compress.failed', { error: message }), 'error');
        }
        return false;
    }
}

// ===== 進度：完成、出錯暫停、回來時問要不要繼續 =====

function afterEach(index) {
    const c = getCatchup();
    if (!c || c.paused) return;
    // 逐層細摘失敗（常常是切 App 時連線被中斷）：先暫停，回來再問。
    if (index !== null && floorStatus(index) === 'fail') {
        pauseCatchup(getEntry(index)?.error ?? '');
        toast(t('catchup.paused', { error: getEntry(index)?.error ?? '' }), 'error');
        return;
    }
    if (pendingCount() > 0) return;
    if (!remaining()) {
        delete chatRecord(false).catchup;
        saveMeta();
        toast(t('catchup.done'), 'success');
    }
}

let prompted = null;

/** 有沒做完的補建、而且現在沒在跑：跳通知問要不要繼續（每次回到這個聊天問一次）。 */
export function maybeAskResume() {
    const c = getCatchup();
    if (!c || !isActive() || pendingCount()) return;
    const left = remaining();
    if (!left) {
        delete chatRecord(false).catchup;
        saveMeta();
        return;
    }
    const key = `${chatKey()}|${c.startedAt}|${left}`;
    if (prompted === key) return;
    prompted = key;
    const done = Math.max(0, c.total - left);
    toastActions(t('catchup.ask', { done, total: c.total }), [
        {
            label: t('catchup.resume'),
            primary: true,
            run: () => {
                const r = resumeCatchup();
                if (r?.ask) toast(t('extras.toast', { n: r.ask }), 'info');
            },
        },
        { label: t('catchup.later'), run: () => pauseCatchup(c.error ?? null) },
    ], { timeOut: 0 });
}

export function initCatchup() {
    setCoarseHandler((indices) => runCoarse(indices));
    setCoarseRedo((indices, existing) => runCoarse(indices, existing));
    setAfterSummaryHook(afterEach);
    const c = ctx();
    if (c?.eventSource && c.eventTypes) {
        c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => {
            prompted = null;
            setTimeout(maybeAskResume, 500);
        });
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') setTimeout(maybeAskResume, 500);
    });
    setTimeout(maybeAskResume, 1000);
}
