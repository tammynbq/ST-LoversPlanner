// 「這一回送了什麼」（v0.13.30，使用者要求：想看每一則 AI 回覆生成時，向量和關鍵字召回了什麼）。
// 攔截器組好注入後記一張收據，等酒館存好那則回覆（MESSAGE_RECEIVED）再貼到那則訊息上。
// 存在 message.extra.lovers_planner_sent，和摘要一樣同步到目前的 swipe（每個 swipe 各記各的）。
// 記的是送出那一刻的樣子（標題、原因、相似度），之後改了記事也不會跟著變。

import { ctx, LOG_PREFIX, MODULE } from './util.js';
import { getChat, saveChatSoon } from './chat.js';
import { getNotes, noteTitle } from './notes.js';

export const SENT_KEY = `${MODULE}_sent`;
const LINE_MAX = 80;

let pending = null;
// 送出後一直沒等到回覆（例如 API 出錯）的收據，過一陣子就不貼了，免得貼到別的訊息上。
const PENDING_TTL_MS = 15 * 60 * 1000;
const listeners = new Set();

/** 這些生成不會變成一則 AI 回覆，不記。 */
const SKIP_TYPES = new Set(['quiet', 'impersonate']);

const cut = (s) => {
    const x = String(s ?? '').replace(/\s+/g, ' ').trim();
    return x.length > LINE_MAX ? `${x.slice(0, LINE_MAX)}…` : x;
};

/**
 * 攔截器做完時呼叫。selection 是 selectRelevant 的結果（可能是 null），
 * reminders 是這回想起的回憶，pinnedKey 是「下次提起」指定的那一條。
 */
export function recordSend({ type, selection, reminders = [], pinnedKey = null, injectedTokens = 0, hiddenTokens = 0 }) {
    if (SKIP_TYPES.has(type)) return;
    const notes = getNotes().notes;
    const chat = getChat();
    const filtered = Boolean(selection?.filtered);
    pending = {
        v: 1,
        at: Date.now(),
        type: type || 'normal',
        filtered,
        notesTotal: selection?.total ?? notes.size,
        notesSent: filtered ? selection.notes.size : (selection?.total ?? notes.size),
        notes: filtered ? [...selection.notes].map(([id, x]) => {
            const n = notes.get(id);
            return { title: n ? cut(noteTitle(n)) : id, type: n?.type ?? '', reason: x.reason, ...(typeof x.score === 'number' ? { score: Math.round(x.score * 100) } : {}) };
        }) : [],
        floors: (selection?.memories ?? []).map((m) => ({
            date: chat[m.index]?.send_date ?? null,
            floor: m.index,
            line: cut(m.line),
            reason: m.reason,
            ...(m.reason === 'vector' && typeof m.score === 'number' ? { score: Math.round(m.score * 100) } : {}),
        })),
        reminders: reminders.map((m) => ({ title: cut(m.title), reason: m.key === pinnedKey ? 'pinned' : 'random' })),
        vector: selection?.vector ?? 'off',
        error: selection?.error || '',
        fetched: selection?.fetched ?? 0,
        injectedTokens,
        hiddenTokens,
    };
}

/** 這則訊息（目前的 swipe）生成時送了什麼；沒有記錄就回傳 null。 */
export function receiptOf(index) {
    const m = getChat()[index];
    const r = m?.extra?.[SENT_KEY];
    if (!r || typeof r !== 'object') return null;
    // 酒館開新 swipe 時可能沿用上一個 swipe 的 extra，對不上的不算。
    if (Number.isInteger(r.swipe) && Number.isInteger(m.swipe_id) && r.swipe !== m.swipe_id) return null;
    return r;
}

/** 召回的舊樓層現在是第幾層（刪過訊息會位移，用 send_date 找回來）。 */
export function floorOf(item) {
    const chat = getChat();
    if (item.date) {
        if (chat[item.floor]?.send_date === item.date) return item.floor;
        const i = chat.findIndex((m) => m?.send_date === item.date);
        if (i >= 0) return i;
    }
    return chat[item.floor] ? item.floor : null;
}

export function onSentChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function attach(id) {
    const r = pending && Date.now() - pending.at < PENDING_TTL_MS ? pending : null;
    pending = null;
    const index = Number(id);
    const m = getChat()[index];
    if (!r || !m || m.is_user) return;
    const receipt = { ...r, swipe: Number.isInteger(m.swipe_id) ? m.swipe_id : 0 };
    if (!m.extra || typeof m.extra !== 'object') m.extra = {};
    m.extra[SENT_KEY] = receipt;
    const info = Array.isArray(m.swipe_info) ? m.swipe_info[m.swipe_id] : null;
    if (info && typeof info === 'object') {
        if (!info.extra || typeof info.extra !== 'object') info.extra = {};
        info.extra[SENT_KEY] = structuredClone(receipt);
    }
    saveChatSoon();
    for (const fn of listeners) {
        try { fn(index); } catch (e) { console.error(LOG_PREFIX, e); }
    }
}

export function initSent() {
    const c = ctx();
    if (!c?.eventSource || !c.eventTypes) return;
    const ev = c.eventTypes;
    c.eventSource.on(ev.MESSAGE_RECEIVED, (id) => {
        try { attach(id); } catch (e) { console.error(LOG_PREFIX, '記錄送出內容失敗', e); }
    });
    c.eventSource.on(ev.CHAT_CHANGED, () => { pending = null; });
}
