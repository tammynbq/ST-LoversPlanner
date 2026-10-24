// 聊天資料：找 AI 樓層、讀寫每層的摘要（存在 chat[i].extra 裡）、判斷狀態。

import { ctx, LOG_PREFIX, MODULE } from './util.js';

export function getChat() {
    return ctx()?.chat ?? [];
}

/** 目前聊天的識別碼，用來確認非同步工作回來時聊天沒有換掉。 */
export function chatKey() {
    const c = ctx();
    return c?.getCurrentChatId?.() ?? c?.chatId ?? null;
}

export function isAiMessage(m) {
    return Boolean(m) && !m.is_user && !m.is_system && typeof m.mes === 'string';
}

export function isUserMessage(m) {
    return Boolean(m) && m.is_user && !m.is_system && typeof m.mes === 'string';
}

/** 所有 AI 樓層的索引，由舊到新。 */
export function aiIndices() {
    const out = [];
    getChat().forEach((m, i) => { if (isAiMessage(m)) out.push(i); });
    return out;
}

/** 最新一個 AI 樓層的索引；沒有就回傳 -1。 */
export function lastAiIndex() {
    const chat = getChat();
    for (let i = chat.length - 1; i >= 0; i--) {
        if (isAiMessage(chat[i])) return i;
    }
    return -1;
}

export function hashText(text) {
    // FNV-1a 32 位元：只用來判斷原文有沒有變，不需要密碼學強度。
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 一層 AI 回覆對應的原文：它前面的使用者發言（往前找到上一個 AI 回覆為止）＋這則回覆。
 * hash 一律包含使用者發言，這樣切換「包含使用者發言」時不會讓所有摘要都變成過期。
 */
export function floorSource(index) {
    const chat = getChat();
    const ai = chat[index];
    const users = [];
    for (let i = index - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m) continue;
        if (isAiMessage(m)) break;
        if (isUserMessage(m)) users.unshift(m);
    }
    const hash = hashText([...users.map((u) => u.mes), ai?.mes ?? ''].join('\u0000'));
    return { ai, users, hash };
}

export function getEntry(index) {
    const e = getChat()[index]?.extra?.[MODULE];
    return e && typeof e === 'object' ? e : null;
}

export function setEntry(index, entry) {
    const m = getChat()[index];
    if (!m) return;
    if (!m.extra || typeof m.extra !== 'object') m.extra = {};
    if (entry) m.extra[MODULE] = entry;
    else delete m.extra[MODULE];
    // 酒館把 extra 分開存在每個 swipe 裡；同步到目前的 swipe，切走再切回來摘要才還在。
    const info = Array.isArray(m.swipe_info) ? m.swipe_info[m.swipe_id] : null;
    if (info && typeof info === 'object') {
        if (!info.extra || typeof info.extra !== 'object') info.extra = {};
        if (entry) info.extra[MODULE] = structuredClone(entry);
        else delete info.extra[MODULE];
    }
}

let saveTimer = null;

/** 改了訊息上的資料後存檔（TauriTavern 的 saveMetadata 不會順便存訊息，一定要 saveChat）。 */
export function saveChatSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        try {
            await ctx()?.saveChat?.();
        } catch (e) {
            console.error(LOG_PREFIX, '存檔失敗', e);
        }
    }, 400);
}

/**
 * 存起來的狀態：'none' 尚未摘要、'ok' 已摘要、'stale' 過期（原文改過）、'fail' 失敗、'skip' 跳過。
 * 「排隊中／摘要中」不存檔，由 summarize.js 另外判斷。
 */
export function floorStatus(index) {
    const e = getEntry(index);
    if (!e) return 'none';
    if (e.status === 'skip') return 'skip';
    if (e.status === 'fail') return 'fail';
    if (e.status === 'ok') return e.hash === floorSource(index).hash ? 'ok' : 'stale';
    return 'none';
}
