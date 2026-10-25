// 共用小工具：取得酒館 context、跳脫 HTML、顯示通知。

export const MODULE = 'lovers_planner';
export const LOG_PREFIX = '[LoversPlanner]';

export function ctx() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
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
