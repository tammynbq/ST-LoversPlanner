// 隱藏舊樓層＋注入摘要和記事（真正省 token 的地方）。
//
// 用 manifest 的 generate_interceptor：酒館組提示詞前會呼叫 globalThis.loversPlannerInterceptor，
// 我們從它給的訊息陣列裡拿掉已摘要的舊樓層，再用 setExtensionPrompt 放進摘要和記事。
// 聊天紀錄本身完全不動；關掉插件就恢復原狀。

import { ctx, LOG_PREFIX, MODULE } from './util.js';
import { getSettings, isTracked } from './settings.js';
import { t } from './i18n.js';
import { floorStatus, getChat, getEntry, isAiMessage, isUserMessage } from './chat.js';
import { formatNotesForPrompt, getNotes } from './notes.js';
import { floorState, isActive } from './summarize.js';

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
export function buildInjection(hidden) {
    const lines = [];
    const indices = [...hidden].filter((i) => isAiMessage(getChat()[i])).sort((a, b) => a - b);
    for (const i of indices) {
        const e = getEntry(i);
        if (e?.status === 'ok' && e.summary) lines.push(sceneLine(e));
    }
    const notes = getNotes().notes;
    const hasNotes = [...notes.values()].some((n) => n.state !== 'done' && isTracked(n.type));
    if (!lines.length && !hasNotes) return '';
    const parts = [t('inject.intro')];
    if (lines.length) parts.push(`${t('inject.summaries')}\n${lines.join('\n')}`);
    if (hasNotes) parts.push(`${t('inject.notes')}\n${formatNotesForPrompt(notes, { withIds: false })}`);
    return parts.join('\n\n');
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
 * 酒館給攔截器的訊息是複本，`index` 是它在「非系統訊息」裡的位置。
 * 對回真正的聊天索引；對不上就回傳 null（寧可不隱藏，也不要藏錯）。
 */
function mapToChat(coreChat) {
    const chat = getChat();
    const eligible = [];
    chat.forEach((m, i) => {
        if (m && (!m.is_system || Array.isArray(m.extra?.tool_invocations))) eligible.push(i);
    });
    const out = [];
    for (const item of coreChat) {
        const ci = eligible[item?.index];
        const m = chat[ci];
        if (!m || Boolean(m.is_user) !== Boolean(item.is_user) || m.send_date !== item.send_date || m.name !== item.name) return null;
        out.push(ci);
    }
    return out;
}

let lastStats = null;

/** 最近一次送出時的統計：{ hiddenFloors, hiddenTokens, injectedTokens, unsummarized }。 */
export function getLastStats() {
    return lastStats;
}

const attentionListeners = new Set();

/** 生成時發現有失敗／過期、沒辦法隱藏的樓層時通知（用來跳彈窗）。 */
export function onAttentionNeeded(fn) {
    attentionListeners.add(fn);
}

export async function interceptor(coreChat, contextSize, abort, type) {
    try {
        if (!isActive()) {
            clearInjection();
            return;
        }
        const chat = getChat();
        // swipe 時酒館已經把正在重新生成的那層拿掉了，我們也不把它算進「最新 2 層」。
        const limit = type === 'swipe' ? chat.length - 1 : chat.length;
        const { hidden, keepFrom, attention, unsummarized } = computeHidden(limit);
        const map = mapToChat(coreChat);
        if (!map) {
            console.warn(LOG_PREFIX, '對不上聊天索引，這次不隱藏也不注入');
            clearInjection();
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

        lastStats = {
            hiddenFloors: [...hidden].filter((i) => isAiMessage(chat[i])).length,
            hiddenTokens,
            injectedTokens: estimateTokens(text),
            unsummarized,
        };
        if (attention.length && type !== 'quiet') {
            for (const fn of attentionListeners) {
                try { fn(attention); } catch (e) { console.error(LOG_PREFIX, e); }
            }
        }
    } catch (e) {
        console.error(LOG_PREFIX, '攔截器出錯，這次不隱藏也不注入', e);
        clearInjection();
    }
}

export function initHiding() {
    globalThis.loversPlannerInterceptor = interceptor;
}
