// 隱藏舊樓層＋注入摘要和記事（真正省 token 的地方）。
//
// 用 manifest 的 generate_interceptor：酒館組提示詞前會呼叫 globalThis.loversPlannerInterceptor，
// 我們從它給的訊息陣列裡拿掉已摘要的舊樓層，再用 setExtensionPrompt 放進摘要和記事。
// 聊天紀錄本身完全不動；關掉插件就恢復原狀。

import { ctx, LOG_PREFIX, MODULE, toast } from './util.js';
import { getSettings, isTracked } from './settings.js';
import { t } from './i18n.js';
import { floorStatus, getChat, getEntry, isAiMessage, isHiddenBySelf, isUserMessage, lastAiIndex } from './chat.js';
import { formatNotesForPrompt, getNotes, NOTE_TYPES } from './notes.js';
import { countTokens } from './llm.js';
import { sceneLine } from './lines.js';
import { enqueue, enqueueCompress, floorState, isActive, pendingCount, setHolding, waitForIdle } from './summarize.js';
import { compressionDue, digestLabel, structure } from './compress.js';
import { selectRelevant } from './recall.js';
import { recapLines } from './carry.js';
import { calendarInjection } from './calendar.js';
import { markSurfaced, nextPinned, pickReminders, remindersText } from './memories.js';
import { recordSend } from './sent.js';
import { cleanForSummary } from './filter.js';

/** 保留原文的 AI 樓層數（規格：最新 2 個）。 */
export const KEEP_AI = 2;

/** 酒館的 extension_prompt_types / roles（context 沒有匯出，照原始碼的數值）。 */
const PROMPT_TYPE = { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
const ROLE_SYSTEM = 0;

/**
 * 一層 AI 回覆可以被摘要「頂替」：已摘要（且沒過期）或跳過。排隊中／摘要中的不算。
 * 粗略補建的樓層沒有單層摘要，只有它所在的章有效時才算（章過期就照送原文）。
 */
function isCovered(index, st) {
    // 跳過、小劇場：排隊讀小劇場的時候也不送原文。
    const stored = floorStatus(index);
    if (stored === 'skip' || stored === 'side') return true;
    const state = floorState(index);
    if (state !== 'ok') return false;
    if (!getEntry(index)?.coarse) return true;
    return st().covered.has(index);
}

/**
 * 算出要隱藏哪些樓層。只看 [0, limit) 範圍（swipe 時不含正在重新生成的那一層）。
 * 回傳 { hidden: Set<index>, keepFrom, attention: index[], unsummarized }：
 *   keepFrom：從這裡開始一律保留原文（最新 2 個 AI 樓層，以及它們前面的使用者發言）。
 *   attention：保留範圍之外、因為失敗或過期而沒辦法隱藏的樓層（要跳彈窗）。
 *   unsummarized：保留範圍之外、還沒摘要（或正在摘要）所以照送原文的樓層數。
 */
export function computeHidden(limit = getChat().length) {
    const chat = getChat();
    const ai = [];
    for (let i = 0; i < limit; i++) if (isAiMessage(chat[i])) ai.push(i);
    // 「保留最新 2 層原文」只算沒被使用者隱藏的（隱藏的原文本來就不會送）。
    const visible = ai.filter((i) => !isHiddenBySelf(chat[i]));
    const hidden = new Set();
    const attention = [];
    let unsummarized = 0;
    let cached = null;
    const st = () => (cached ??= structure());
    const keepFrom = visible.length > KEEP_AI ? visible[visible.length - KEEP_AI - 1] + 1 : 0;
    // 使用者自己隱藏、而且已經摘要的樓層：就算在最新幾層裡，也要送它的摘要。
    for (const f of ai) if (f >= keepFrom && isHiddenBySelf(chat[f]) && isCovered(f, st)) hidden.add(f);
    if (visible.length <= KEEP_AI) return { hidden, keepFrom: 0, attention, unsummarized };

    let prevAi = -1;
    for (const f of ai) {
        if (f >= keepFrom) break;
        if (isCovered(f, st)) {
            hidden.add(f);
            // 這層前面的使用者發言（到上一個 AI 樓層為止）跟著隱藏。
            for (let i = prevAi + 1; i < f; i++) if (isUserMessage(chat[i])) hidden.add(i);
        } else if (!isHiddenBySelf(chat[f])) {
            // 使用者自己隱藏的原文本來就不會送，沒摘要也不用提醒。
            const s = floorStatus(f);
            if (s === 'fail' || s === 'stale') attention.push(f);
            else unsummarized++;
        }
        prevAi = f;
    }
    return { hidden, keepFrom, attention, unsummarized };
}

/** 粗估 token 數（只用來顯示「大約省了多少」，不需要精準）。 */
export function estimateTokens(text) {
    const s = String(text ?? '');
    // 長的原文記住結果（v0.13.28：每次送出都要數上千則被隱藏的原文，長聊天會慢）。
    // 用字串本身當 key：瀏覽器會把字串的 hash 記在字串上，同一段原文第二次查幾乎不花時間。
    const long = s.length > 200;
    if (long && tokenCache.has(s)) return tokenCache.get(s);
    const cjk = (s.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
    const n = Math.ceil(cjk / 1.2 + (s.length - cjk) / 4);
    if (long) {
        if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.delete(tokenCache.keys().next().value);
        tokenCache.set(s, n);
    }
    return n;
}
const TOKEN_CACHE_MAX = 6000;
const tokenCache = new Map();


/**
 * 注入內容拆成幾塊（大視窗的「送出預覽」用來分別算 token）：
 * { summaries: { floors, chapters, volumes, text, parts: { volumes, chapters, floors } },
 *   memories: { count, text },
 *   notes: { character|item|promise|todo: { count, total, text } } }
 * 前情摘要依故事順序排：有效的卷 → 沒進卷（或卷過期）的有效章 → 沒被有效章涵蓋的單層摘要。
 * selection：recall.js 挑出來的記事和回憶；沒給（或沒在挑）就送全部進行中的記事。
 */
export function injectionParts(hidden, selection = null) {
    const st = structure();
    const rows = []; // { at: 最早的樓層, line, kind }
    for (const v of st.volumes) {
        // 只送最上層有效的：被有效的更高一層涵蓋的卷就不送了。
        if (v.state !== 'ok' || st.coveredVolumes.has(v.data.id)) continue;
        const first = Math.min(...v.chapters.flatMap((c) => c.indices).filter((i) => i >= 0));
        rows.push({ at: first, kind: 'volumes', line: sceneLine({ ...v.data, characters: [] }, digestLabel(v.level, v.number)) });
    }
    for (const c of st.chapters) {
        if (c.state !== 'ok' || st.coveredChapters.has(c.data.id)) continue;
        const first = Math.min(...c.indices.filter((i) => i >= 0));
        rows.push({ at: first, kind: 'chapters', line: sceneLine({ ...c.data, characters: [] }, t('chapter.label', { n: c.number })) });
    }
    const indices = [...hidden].filter((i) => isAiMessage(getChat()[i]) && !st.covered.has(i));
    for (const i of indices) {
        const e = getEntry(i);
        if (e?.status === 'ok' && e.summary) rows.push({ at: i, kind: 'floors', line: sceneLine(e) });
    }
    rows.sort((a, b) => a.at - b.at);
    // 前情提要（從別的聊天帶來的、或即時共用的）放在最前面。
    const recap = recapLines();
    rows.unshift(...recap.map((line) => ({ at: -1, kind: 'recap', line })));
    const lines = rows.map((r) => r.line);
    const byKind = (kind) => rows.filter((r) => r.kind === kind).map((r) => r.line).join('\n');
    const notes = getNotes().notes;
    const only = selection?.filtered ? new Set(selection.notes.keys()) : null;
    const byType = {};
    for (const type of NOTE_TYPES) {
        if (!isTracked(type)) continue;
        const list = [...notes.values()].filter((n) => n.type === type && n.state !== 'done');
        const count = only ? list.filter((n) => only.has(n.id)).length : list.length;
        byType[type] = { count, total: list.length, text: count ? formatNotesForPrompt(notes, { withIds: false, types: [type], only, emptyText: '', skipCard: true }) : '' };
    }
    const memories = selection?.memories ?? [];
    const calendar = calendarInjection();
    const reminders = selection?.reminders ?? [];
    return {
        calendar: { text: calendar },
        reminders: { count: reminders.length, text: remindersText(reminders) },
        summaries: {
            floors: rows.filter((r) => r.kind === 'floors').length,
            chapters: rows.filter((r) => r.kind === 'chapters').length,
            volumes: rows.filter((r) => r.kind === 'volumes').length,
            recap: recap.length,
            text: lines.join('\n'),
            parts: { recap: byKind('recap'), volumes: byKind('volumes'), chapters: byKind('chapters'), floors: byKind('floors') },
        },
        memories: { count: memories.length, text: memories.map((m) => m.line).join('\n') },
        notes: byType,
    };
}

/** 注入的文字：前情摘要（依序）＋相關回憶＋記事。 */
export function buildInjection(hidden, selection = null) {
    return textOf(injectionParts(hidden, selection));
}

function textOf({ summaries, memories, notes, calendar, reminders }) {
    const noteText = Object.values(notes).map((n) => n.text).filter(Boolean).join('\n');
    if (!summaries.text && !memories.text && !noteText && !calendar?.text && !reminders?.text) return '';
    const parts = [t('inject.intro')];
    if (summaries.text) parts.push(`${t('inject.summaries')}\n${summaries.text}`);
    if (memories.text) parts.push(`${t('inject.memories')}\n${memories.text}`);
    if (noteText) parts.push(`${t('inject.notes')}\n${noteText}`);
    if (reminders?.text) parts.push(`${t('inject.reminders')}\n${reminders.text}`);
    if (calendar?.text) parts.push(`${t('inject.calendar')}\n${calendar.text}`);
    return parts.join('\n\n');
}

/**
 * 「現在送出的話」會注入什麼、省下多少（大視窗預覽用；token 用酒館的分詞器算）。
 * 回傳 { hiddenFloors, parts, selection, text, tokens: { summaries, memories, character…, total, hiddenRaw } }。
 */
export async function previewInjection() {
    const { hidden, keepFrom } = computeHidden();
    const selection = await selectRelevant({ keepFrom, preview: true });
    const parts = injectionParts(hidden, selection);
    const text = textOf(parts);
    const chat = getChat();
    // 使用者自己隱藏的原文本來就不會送，不算進「省下的」。
    const hiddenRaw = [...hidden].filter((i) => !isHiddenBySelf(chat[i])).sort((a, b) => a - b).map((i) => chat[i]?.mes ?? '').join('\n');
    const sp = parts.summaries.parts;
    const count = async (x) => (x ? await countTokens(x) : 0);
    const tokens = {
        summaries: await count(parts.summaries.text),
        recap: await count(sp.recap),
        volumes: await count(sp.volumes),
        chapters: await count(sp.chapters),
        floors: await count(sp.floors),
        memories: await count(parts.memories.text),
        calendar: await count(parts.calendar.text),
        total: await count(text),
        hiddenRaw: await count(hiddenRaw),
    };
    for (const [type, n] of Object.entries(parts.notes)) tokens[type] = await count(n.text);
    return { hiddenFloors: [...hidden].filter((i) => isAiMessage(chat[i])).length, parts, selection, text, tokens };
}

function setInjection(text, position, depth) {
    try {
        ctx()?.setExtensionPrompt?.(MODULE, text, position, depth, false, ROLE_SYSTEM);
    } catch (e) {
        console.warn(LOG_PREFIX, '設定注入失敗', e);
    }
}

export function clearInjection() {
    setInjection('', PROMPT_TYPE.IN_CHAT, 0);
}

/**
 * 酒館給攔截器的訊息是複本，而且順序和聊天一樣、只是少了一些（系統訊息、工具呼叫等，
 * 各版本過濾的規則不同，TauriTavern 還會拿掉舊的工具回合）。
 * 所以不靠 `index`，而是沿著聊天往下找「送出時間、說話者、是不是使用者」都一樣的那則。
 * 有任何一則找不到就回傳 null（寧可不隱藏，也不要藏錯）。
 */
export function mapToChat(coreChat) {
    const chat = getChat();
    const same = (m, item) => m
        && Boolean(m.is_user) === Boolean(item.is_user)
        && (m.name ?? '') === (item.name ?? '')
        && (m.send_date ?? null) === (item.send_date ?? null);
    const out = [];
    let j = 0;
    for (const item of coreChat) {
        while (j < chat.length && !same(chat[j], item)) j++;
        if (j >= chat.length) return null;
        out.push(j);
        j++;
    }
    return out;
}

let lastStats = null;
const statsListeners = new Set();

/**
 * 最近一次生成時的結果：
 * { reason: null | 'inactive' | 'mismatch' | 'error' | 'cancelled', hiddenFloors, hiddenTokens, injectedTokens, unsummarized }。
 * reason 不是 null 時表示這次沒有隱藏（原因寫在 reason）。
 */
export function getLastStats() {
    return lastStats;
}

/** 每次攔截器跑完都會通知（大視窗用來更新標題列）。 */
export function onStatsChange(fn) {
    statsListeners.add(fn);
}

function setStats(stats) {
    lastStats = { hiddenFloors: 0, hiddenTokens: 0, injectedTokens: 0, unsummarized: 0, reason: null, ...stats };
    for (const fn of statsListeners) {
        try { fn(lastStats); } catch (e) { console.error(LOG_PREFIX, e); }
    }
}

/**
 * 有失敗／過期的樓層時，讓使用者決定怎麼辦（由 ui/attention.js 提供）。
 * 回傳 Promise<'continue' | 'cancel'>。
 */
let attentionHandler = null;

export function setAttentionHandler(fn) {
    attentionHandler = fn;
}

/** 不需要等摘要、也不跳彈窗的生成類型。 */
const NO_HOLD_TYPES = new Set(['quiet', 'impersonate']);

/**
 * 生成前先把摘要準備好（使用者要求：沒摘要好就先暫停生成）：
 *   1.「開始下回前自動摘要」模式下，上一個 AI 樓層還沒摘要的話，現在就摘要。
 *   2. 等排隊中、摘要中的都完成。
 *   3. 還有失敗或過期的樓層，就跳彈窗讓使用者處理，選完才繼續（或取消這次生成）。
 * 回傳 false 表示使用者取消了這次生成。
 */
async function prepareSummaries(type) {
    if (NO_HOLD_TYPES.has(type)) return true;
    const s = getSettings();
    const normalSend = !type || type === 'normal';
    const latest = lastAiIndex();
    setHolding(true);
    try {
        if (normalSend && s.summary.mode === 'before' && latest >= 0 && floorState(latest) === 'none') {
            enqueue(latest, { front: true });
        }
        if (pendingCount()) {
            toast(t('hold.waiting'), 'info');
            await waitForIdle();
        }
        // 有到期的章／卷就先壓縮好（失敗也不擋生成，下次再試）。
        if (s.compress.auto && compressionDue()) {
            enqueueCompress();
            await waitForIdle();
        }
        const limit = type === 'swipe' ? getChat().length - 1 : getChat().length;
        const { attention } = computeHidden(limit);
        // 剛剛在「開始下回前」自動摘要失敗的那一層也要問。
        if (normalSend && s.summary.mode === 'before' && latest >= 0 && ['fail', 'stale'].includes(floorState(latest)) && !attention.includes(latest)) {
            attention.push(latest);
        }
        if (attention.length && attentionHandler) {
            const choice = await attentionHandler(attention);
            if (choice === 'cancel') return false;
        }
        return true;
    } finally {
        setHolding(false);
    }
}

export async function interceptor(coreChat, contextSize, abort, type) {
    try {
        if (!isActive()) {
            clearInjection();
            return;
        }
        if (!(await prepareSummaries(type))) {
            setStats({ reason: 'cancelled' });
            abort(true);
            return;
        }

        const chat = getChat();
        // swipe 時酒館已經把正在重新生成的那層拿掉了，我們也不把它算進「最新 2 層」。
        const limit = type === 'swipe' ? chat.length - 1 : chat.length;
        const { hidden, keepFrom, unsummarized } = computeHidden(limit);
        const map = mapToChat(coreChat);
        if (!map) {
            console.warn(LOG_PREFIX, '對不上聊天索引，這次不隱藏也不注入', { coreChat: coreChat.length, chat: chat.length });
            clearInjection();
            setStats({ reason: 'mismatch', unsummarized });
            return;
        }

        // 挑出相關的記事和回憶（向量出錯會自動改用關鍵字，不會擋住生成）。
        let selection = null;
        try {
            selection = await selectRelevant({ keepFrom, limit });
        } catch (e) {
            console.warn(LOG_PREFIX, '挑選相關記事失敗，這次送全部記事', e);
        }
        // 回憶錄：偶爾讓角色想起過去（背景的 quiet 生成不算）。
        let reminders = [];
        if (!NO_HOLD_TYPES.has(type)) {
            try {
                const recent = chat.slice(Math.max(0, keepFrom), limit).map((m) => cleanForSummary(m?.mes ?? '')).join('\n');
                reminders = pickReminders(recent);
            } catch (e) {
                console.warn(LOG_PREFIX, '挑回憶失敗', e);
            }
        }
        if (reminders.length) selection = { ...(selection ?? { filtered: false, notes: new Map(), memories: [] }), reminders };
        const text = buildInjection(hidden, selection);
        const s = getSettings();
        let position = PROMPT_TYPE.IN_CHAT;
        let depth = Number(s.inject.depth) || 0;
        if (s.inject.position === 'before_recent') {
            // 放在保留原文的那幾層前面：摘要在前、最新原文在後。
            depth = map.filter((ci) => ci >= keepFrom && !hidden.has(ci)).length;
        } else if (s.inject.position === 'in_prompt') {
            position = PROMPT_TYPE.IN_PROMPT;
        } else if (s.inject.position === 'before_prompt') {
            position = PROMPT_TYPE.BEFORE_PROMPT;
        }
        setInjection(text, position, depth);

        // 注入設好之後才拿掉訊息：中途出錯的話，不會出現「藏了原文卻沒有摘要」。
        let hiddenTokens = 0;
        for (let k = coreChat.length - 1; k >= 0; k--) {
            if (hidden.has(map[k])) {
                hiddenTokens += estimateTokens(coreChat[k].mes);
                coreChat.splice(k, 1);
            }
        }

        setStats({
            hiddenFloors: [...hidden].filter((i) => isAiMessage(chat[i])).length,
            hiddenTokens,
            injectedTokens: estimateTokens(text),
            unsummarized,
            notesSent: selection?.filtered ? selection.notes.size : null,
            notesTotal: selection?.total ?? 0,
            memories: selection?.memories.length ?? 0,
            vector: selection?.vector ?? 'off',
            reminders: reminders.length,
        });
        recordSend({ type, selection, reminders, pinnedKey: reminders.length ? nextPinned() : null, injectedTokens: lastStats.injectedTokens, hiddenTokens });
        markSurfaced(reminders);
        console.debug(LOG_PREFIX, '攔截器完成', lastStats);
    } catch (e) {
        console.error(LOG_PREFIX, '攔截器出錯，這次不隱藏也不注入', e);
        clearInjection();
        setStats({ reason: 'error' });
    }
}

export function initHiding() {
    globalThis.loversPlannerInterceptor = interceptor;
}
