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

/**
 * 使用者自己隱藏的訊息（/hide、訊息上的眼睛按鈕，或其他隱藏插件）：酒館一樣標成 is_system，
 * 但它本來是一般的對話。酒館真正的系統訊息（說明、旁白、註解…）會在 extra.type 寫是哪一種。
 * 這種訊息照樣算樓層，摘要也照樣送（使用者要求）；只是原文本來就不會送給角色。
 */
export function isHiddenByUser(m) {
    return Boolean(m) && Boolean(m.is_system) && (Boolean(m.is_user) || !m.extra?.type);
}

/**
 * 使用者「自己」隱藏的：被隱藏、但不是戀人手帳用酒館隱藏標的（設定 › 隱藏 › 也用酒館的隱藏，記在 stHidden）。
 * 「保留最新幾層原文」只把使用者自己隱藏的當成不算；戀人手帳自己標的照樣算，不然窗口會亂跑。
 */
export function isHiddenBySelf(m) {
    if (!isHiddenByUser(m)) return false;
    const mine = ctx()?.chatMetadata?.[MODULE]?.stHidden;
    if (!Array.isArray(mine) || !m.send_date) return true;
    return !mineSet(mine).has(m.send_date);
}

// 戀人手帳自己標的清單（可能上千筆）：轉成 Set 查，不要每次逐筆比對（v0.13.29）。清單換了就重建。
const mineSets = new WeakMap();
function mineSet(list) {
    let hit = mineSets.get(list);
    if (!hit || hit.len !== list.length) {
        hit = { len: list.length, set: new Set(list) };
        mineSets.set(list, hit);
    }
    return hit.set;
}

export function isAiMessage(m) {
    return Boolean(m) && !m.is_user && (!m.is_system || isHiddenByUser(m)) && typeof m.mes === 'string';
}

export function isUserMessage(m) {
    return Boolean(m) && m.is_user && typeof m.mes === 'string';
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
/**
 * v0.12.4 以前的算法：隱藏的訊息整個略過。那時候在有隱藏訊息的聊天裡摘要的樓層，
 * hash 是這樣算的；比對時兩種都接受，才不會因為改版全部變成「過期」。
 */
function legacyHash(index) {
    const chat = getChat();
    const ai = chat[index];
    const visible = (m) => m && !m.is_system && typeof m.mes === 'string';
    const users = [];
    for (let i = index - 1; i >= 0; i--) {
        const m = chat[i];
        if (!visible(m)) continue;
        if (!m.is_user) break;
        users.unshift(m);
    }
    return cachedHash(legacyCache, ai, users);
}

// 原文的 hash 記起來（v0.13.28）：每次判斷過期都要把整段原文（常常幾千字）重算一遍，長聊天會卡。
// 用訊息物件當 key；原文（這則和前面的使用者發言）沒變就直接用記住的。
const hashCache = new WeakMap();
const legacyCache = new WeakMap();

function cachedHash(cache, ai, users) {
    const texts = [...users.map((u) => u.mes), ai?.mes ?? ''];
    const hit = ai ? cache.get(ai) : null;
    if (hit && hit.texts.length === texts.length && hit.texts.every((x, k) => x === texts[k])) {
        hit.texts = texts; // 內容一樣但換成新字串時，下次比對就是同一個字串，很快
        return hit.hash;
    }
    const hash = hashText(texts.join('\u0000'));
    if (ai) cache.set(ai, { texts, hash });
    return hash;
}

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
    const hash = cachedHash(hashCache, ai, users);
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
 * 存起來的狀態：'none' 尚未摘要、'ok' 已摘要、'stale' 過期（原文改過）、'fail' 失敗、'skip' 👻 跳過、'side' ⭐ 小劇場（不送、不壓縮，只記回憶和約定）。
 * 「排隊中／摘要中」不存檔，由 summarize.js 另外判斷。
 */
export function floorStatus(index) {
    const e = getEntry(index);
    if (!e) return 'none';
    if (e.status === 'skip') return 'skip';
    if (e.status === 'side') return 'side';
    if (e.status === 'fail') return 'fail';
    if (e.status === 'ok') return e.hash === floorSource(index).hash || e.hash === legacyHash(index) ? 'ok' : 'stale';
    return 'none';
}
