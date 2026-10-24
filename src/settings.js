// 插件的全域設定：存在酒館的 extensionSettings 裡。

import { ctx, MODULE } from './util.js';

export const DEFAULTS = Object.freeze({
    enabled: true,
    // 'auto' = 跟著酒館的介面語言；也可以是 'zh-TW' / 'zh-CN' / 'en'。
    // 摘要和記事也用這個語言寫。
    language: 'auto',
    // 'main' = 沿用酒館目前的連線；'custom' = 自訂 OpenAI 相容 API。
    source: 'main',
    custom: { url: '', key: '', model: '' },
    summary: {
        mode: 'auto', // 'auto' | 'manual'
        includeUser: true,
        ratioMin: 5,
        ratioMax: 10,
        minTokens: 30,
        maxTokens: 300,
    },
    compress: {
        l1PerL2: 10,
        l2PerL3: 10,
        ratioMin: 30,
        ratioMax: 40,
    },
    hide: {
        markHidden: true,
    },
    // 開同角色的新聊天時的預設選擇：'none' | 'copy' | 'share'
    scope: {
        summary: 'copy',
        characters: 'share',
        items: 'copy',
        promises: 'copy',
        todos: 'none',
    },
    inject: {
        position: 'in_chat', // 'in_chat' | 'in_prompt' | 'before_prompt'
        depth: 4,
    },
    // null = 使用目前語言的預設模板；字串 = 使用者改過的內容。
    prompts: { l1: null, l2: null, l3: null, recap: null },
});

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 用預設值補齊已存的設定，保留使用者的值，丟掉型別不對的值。 */
function mergeDefaults(defaults, saved) {
    const out = {};
    for (const [key, def] of Object.entries(defaults)) {
        const val = isPlainObject(saved) ? saved[key] : undefined;
        if (isPlainObject(def)) {
            out[key] = mergeDefaults(def, val);
        } else if (val === undefined || (def !== null && val !== null && typeof val !== typeof def)) {
            out[key] = def;
        } else {
            out[key] = val;
        }
    }
    return out;
}

let fallback = null;

/** 啟動時呼叫一次：補齊設定並寫回 extensionSettings。 */
export function initSettings() {
    const c = ctx();
    if (!c) {
        fallback = mergeDefaults(DEFAULTS, null);
        return fallback;
    }
    c.extensionSettings[MODULE] = mergeDefaults(DEFAULTS, c.extensionSettings[MODULE]);
    return c.extensionSettings[MODULE];
}

export function getSettings() {
    const c = ctx();
    if (c?.extensionSettings?.[MODULE]) return c.extensionSettings[MODULE];
    return fallback ?? initSettings();
}

export function saveSettings() {
    try { ctx()?.saveSettingsDebounced?.(); } catch (e) { /* 忽略 */ }
}

export function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => (isPlainObject(o[k]) ? o[k] : (o[k] = {})), obj);
    target[last] = value;
}
