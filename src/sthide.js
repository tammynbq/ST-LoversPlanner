// 用酒館自己的「隱藏」（像 /hide）把已經摘要好的舊樓層標起來（v0.13.13，使用者要求，預設關）。
//
// 戀人手帳本來就會在送出時拿掉這些樓層（攔截器），這個選項是再加一層：
// 酒館自己算的 token、其他擴充看到的聊天都不含它們；就算哪次攔截器對不上，舊樓層也不會整串送出去。
//
// 規則：
//   該藏的＝攔截器會拿掉的那些（computeHidden：已摘要、不在最新幾層的 AI 樓層，和它們前面的使用者發言）。
//   只動自己標的（send_date 記在 chat_metadata.lovers_planner.stHidden），使用者自己隱藏的不碰。
//   自己標過、現在不該藏的（摘要過期、失敗、落到最新幾層裡）取消隱藏，原文就會照送。
//   關掉選項時，把自己標的全部取消。
// 被隱藏的樓層照樣算樓層、摘要照樣送（v0.12.5 起）。

import { ctx, LOG_PREFIX, MODULE } from './util.js';
import { getSettings } from './settings.js';
import { getChat, saveChatSoon } from './chat.js';
import { computeHidden } from './hide.js';
import { isActive } from './summarize.js';

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

function keyOf(m, i) {
    return m?.send_date ?? `#${i}`;
}

/** 畫面上的訊息也標一下（酒館用 is_system 屬性顯示「已隱藏」的樣子）。 */
function markDom(i, hidden) {
    document.querySelector(`#chat .mes[mesid="${i}"]`)?.setAttribute('is_system', String(hidden));
}

/** 目前戀人手帳標了幾則。 */
export function stHiddenCount() {
    return (record(false)?.stHidden ?? []).length;
}

/**
 * 同步一次。回傳 { hid, shown }（這次新標的、這次取消的）。
 * 選項關著時：把自己標的全部取消。
 */
export function syncStHide() {
    const rec = record(false);
    const mine = new Set(rec?.stHidden ?? []);
    const on = Boolean(getSettings().hide?.stHide) && isActive();
    if (!on && !mine.size) return { hid: 0, shown: 0 };
    const chat = getChat();
    const want = on ? computeHidden().hidden : new Set();
    let hid = 0;
    let shown = 0;
    const where = new Map();
    chat.forEach((m, i) => where.set(keyOf(m, i), i));
    // 取消：自己標的、現在不該藏的（或訊息不見了）。
    for (const key of [...mine]) {
        const i = where.get(key);
        if (i === undefined) {
            mine.delete(key);
            continue;
        }
        if (want.has(i)) continue;
        if (chat[i].is_system) {
            chat[i].is_system = false;
            markDom(i, false);
            shown++;
        }
        mine.delete(key);
    }
    // 標起來：該藏、還沒藏的（已經藏著的不是我們標的，不記，之後也不會去取消）。
    for (const i of want) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        m.is_system = true;
        markDom(i, true);
        mine.add(keyOf(m, i));
        hid++;
    }
    if (hid || shown || (rec && (rec.stHidden ?? []).length !== mine.size)) {
        const r = record(true);
        r.stHidden = [...mine];
        saveMeta();
        saveChatSoon();
    }
    if (hid || shown) console.debug(LOG_PREFIX, `酒館隱藏：標 ${hid}、取消 ${shown}`);
    return { hid, shown };
}

let timer = null;
/** 摘要、壓縮變了之後，稍等一下再同步（同一輪的很多變化合併成一次）。 */
export function scheduleStHide() {
    clearTimeout(timer);
    timer = setTimeout(() => {
        try { syncStHide(); } catch (e) { console.warn(LOG_PREFIX, e); }
    }, 800);
}
