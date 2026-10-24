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
