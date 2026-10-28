// 共用小工具：取得酒館 context、跳脫 HTML、顯示通知。

export const MODULE = 'lovers_planner';
export const LOG_PREFIX = '[LoversPlanner]';

// 酒館的 getContext() 每次都會重新組一個很大的物件，插件一次畫面更新要讀上千次（v0.13.28 使用者回報 3000 多層的聊天打開會卡）。
// 同一段同步執行裡只要一次，執行完（下一個 microtask）就丟掉，下次再重新要，不會拿到換聊天前的舊資料。
let ctxCache = null;

export function ctx() {
    if (ctxCache) return ctxCache;
    const c = globalThis.SillyTavern?.getContext?.() ?? null;
    if (c) {
        ctxCache = c;
        queueMicrotask(() => { ctxCache = null; });
    }
    return c;
}

export function isTauriTavern() {
    return Boolean(globalThis.__TAURITAVERN__);
}

/** 目前是否在群組聊天裡（群組聊天暫不支援）。 */
export function isGroupChat() {
    const c = ctx();
    return Boolean(c && c.groupId);
}

/** 目前是否有打開的角色聊天。 */
export function hasCharacterChat() {
    const c = ctx();
    return Boolean(c && !c.groupId && c.characterId !== undefined && c.characterId !== null);
}

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
}

export function toast(message, type = 'info') {
    try {
        if (globalThis.toastr?.[type]) {
            globalThis.toastr[type](message);
            return;
        }
    } catch (e) { /* 退回 console */ }
    console.log(LOG_PREFIX, message);
}

/**
 * 帶按鈕的通知（例如「復原」「繼續」）。actions：[{ label, run, primary? }]。
 * timeOut：0＝不會自己消失。沒有 toastr 時退回一般通知（沒有按鈕）。
 */
export function toastActions(message, actions, { timeOut = 15000, type = 'info' } = {}) {
    try {
        if (globalThis.toastr?.[type]) {
            const buttons = actions.map((a, k) =>
                `<button type="button" class="menu_button lp-btn${a.primary ? ' lp-primary' : ''} lp-toast-btn" data-k="${k}">${escapeHtml(a.label)}</button>`).join('');
            const html = `<div>${escapeHtml(message)}</div><div class="lp-toast-actions">${buttons}</div>`;
            const el = globalThis.toastr[type](html, '', {
                timeOut, extendedTimeOut: timeOut ? 5000 : 0, escapeHtml: false, closeButton: true, tapToDismiss: false,
            });
            const node = el?.[0] ?? el;
            node?.querySelectorAll?.('.lp-toast-btn').forEach((b) => b.addEventListener('click', (e) => {
                e.stopPropagation();
                try { actions[Number(b.dataset.k)]?.run?.(); } finally { el?.remove?.(); }
            }));
            return el;
        }
    } catch (e) { /* 退回一般通知 */ }
    toast(message, type);
    return null;
}
