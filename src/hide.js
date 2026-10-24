// 隱藏舊樓層＋注入摘要和記事（真正省 token 的地方）。
//
// 用 manifest 的 generate_interceptor：酒館組提示詞前會呼叫 globalThis.loversPlannerInterceptor，
// 我們從它給的訊息陣列裡拿掉已摘要的舊樓層，再用 setExtensionPrompt 放進摘要和記事。
// 聊天紀錄本身完全不動；關掉插件就恢復原狀。

import { ctx, LOG_PREFIX, MODULE, toast } from './util.js';
import { getSettings, isTracked } from './settings.js';
import { t } from './i18n.js';
import { floorStatus, getChat, getEntry, isAiMessage, isUserMessage, lastAiIndex } from './chat.js';
import { formatNotesForPrompt, getNotes, NOTE_TYPES } from './notes.js';
import { countTokens } from './llm.js';
import { enqueue, floorState, isActive, pendingCount, setHolding, waitForIdle } from './summarize.js';

/** 保留原文的 AI 樓層數（規格：最新 2 個）。 */
export const KEEP_AI = 2;

/** 酒館的 extension_prompt_types / roles（context 沒有匯出，照原始碼的數值）。 */
const PROMPT_TYPE = { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
const ROLE_SYSTEM = 0;

/** 一層 AI 回覆可以被摘要「頂替」：已摘要（且沒過期）或跳過。排隊中／摘要中的不算。 */
function isCovered(index) {
    const state = floorState(index);
    return state === 'ok' || state === 'skip';
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
    const hidden = new Set();
    const attention = [];
    let unsummarized = 0;
    if (ai.length <= KEEP_AI) return { hidden, keepFrom: 0, attention, unsummarized };

    const keepFrom = ai[ai.length - KEEP_AI - 1] + 1;
    let prevAi = -1;
    for (const f of ai) {
        if (f >= keepFrom) break;
        if (isCovered(f)) {
            hidden.add(f);
            // 這層前面的使用者發言（到上一個 AI 樓層為止）跟著隱藏。
            for (let i = prevAi + 1; i < f; i++) if (isUserMessage(chat[i])) hidden.add(i);
        } else {
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
    const cjk = (s.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
    return Math.ceil(cjk / 1.2 + (s.length - cjk) / 4);
}

function sceneLine(entry) {
    // 沒勾選要記錄的欄位不送出。
    const head = [
        isTracked('time') ? entry.time : '',
        isTracked('location') ? entry.location : '',
        isTracked('cast') ? (entry.characters ?? []).join('、') : '',
    ].filter(Boolean).join('｜');
    return head ? `［${head}］${entry.summary}` : entry.summary;
}

/** 注入的文字：被隱藏樓層的摘要（依序）＋目前的記事。 */
/**
 * 注入內容拆成幾塊（大視窗的「送出預覽」用來分別算 token）：
 * { summaries: { floors, text }, notes: { character|item|promise|todo: { count, text } } }
 */
export function injectionParts(hidden) {
    const lines = [];
    const indices = [...hidden].filter((i) => isAiMessage(getChat()[i])).sort((a, b) => a - b);
    for (const i of indices) {
        const e = getEntry(i);
        if (e?.status === 'ok' && e.summary) lines.push(sceneLine(e));
    }
    const notes = getNotes().notes;
    const byType = {};
    for (const type of NOTE_TYPES) {
        if (!isTracked(type)) continue;
        const count = [...notes.values()].filter((n) => n.type === type && n.state !== 'done').length;
        byType[type] = { count, text: count ? formatNotesForPrompt(notes, { withIds: false, types: [type], emptyText: '' }) : '' };
    }
    return { summaries: { floors: lines.length, text: lines.join('\n') }, notes: byType };
}

/** 注入的文字：被隱藏樓層的摘要（依序）＋目前的記事。 */
export function buildInjection(hidden) {
    const { summaries, notes } = injectionParts(hidden);
    const noteText = Object.values(notes).map((n) => n.text).filter(Boolean).join('\n');
    if (!summaries.text && !noteText) return '';
    const parts = [t('inject.intro')];
    if (summaries.text) parts.push(`${t('inject.summaries')}\n${summaries.text}`);
    if (noteText) parts.push(`${t('inject.notes')}\n${noteText}`);
    return parts.join('\n\n');
}

/**
 * 「現在送出的話」會注入什麼、省下多少（大視窗預覽用；token 用酒館的分詞器算）。
 * 回傳 { hiddenFloors, parts, text, tokens: { summaries, character…, total, hiddenRaw } }。
 */
export async function previewInjection() {
    const { hidden } = computeHidden();
    const parts = injectionParts(hidden);
    const text = buildInjection(hidden);
    const chat = getChat();
    const hiddenRaw = [...hidden].sort((a, b) => a - b).map((i) => chat[i]?.mes ?? '').join('\n');
    const tokens = {
        summaries: parts.summaries.text ? await countTokens(parts.summaries.text) : 0,
        total: text ? await countTokens(text) : 0,
        hiddenRaw: hiddenRaw ? await countTokens(hiddenRaw) : 0,
    };
    for (const [type, n] of Object.entries(parts.notes)) tokens[type] = n.text ? await countTokens(n.text) : 0;
    return { hiddenFloors: [...hidden].filter((i) => isAiMessage(chat[i])).length, parts, text, tokens };
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

        const text = buildInjection(hidden);
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
        });
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
