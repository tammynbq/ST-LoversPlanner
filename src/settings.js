// 插件的全域設定：存在酒館的 extensionSettings 裡。

import { ctx, MODULE } from './util.js';

export const VECTOR_URL = 'https://api.siliconflow.cn/v1';
export const VECTOR_MODEL = 'BAAI/bge-m3';

export const DEFAULTS = Object.freeze({
    enabled: true,
    // 'auto' = 跟著酒館的介面語言；也可以是 'zh-TW' / 'zh-CN' / 'en'。
    // 摘要和記事也用這個語言寫。
    language: 'auto',
    // 'main' = 沿用酒館目前的連線；'custom' = 自訂 OpenAI 相容 API。
    source: 'main',
    custom: { url: '', key: '', model: '' },
    summary: {
        // 'after' 每回正文結束後自動 | 'manual' 手動 | 'before' 開始下回前自動（使用者送出下一句時摘要上一層）
        mode: 'before',
        includeUser: true,
        ratioMin: 3,
        ratioMax: 6,
        minTokens: 30,
        maxTokens: 150,
    },
    // 摘要時跳過的內容（只影響送去摘要的文字）。tags：自訂要跳過的標籤；only：只看這些標籤裡的內容。
    filter: { thinking: true, status: true, html: true, tags: '', only: '' },
    compress: {
        auto: true, // 到期就自動壓縮
        l1PerL2: 10,
        l2PerL3: 10,
        ratioMin: 30,
        ratioMax: 40,
    },
    // 要記錄哪些：沒勾的不會要求模型摘要、不顯示、也不注入（已經記下的資料保留）。
    track: {
        time: true,
        location: true,
        cast: true, // 這一層出場的人物
        character: true,
        item: true,
        promise: true,
        todo: true,
    },
    hide: {
        markHidden: true,
    },
    // 角色還沒有自己的「共同設定」時用的初始值：'none' | 'copy' | 'share'（見 scope.js）
    scope: {
        summary: 'copy',
        characters: 'share',
        items: 'copy',
        promises: 'copy',
        todos: 'none',
    },
    // 只送相關的記事＋回憶召回（第 6 步）。
    recall: {
        notes: true, // 只送相關的人物／物件／約定／待辦（關掉＝全部都送）
        recentFloors: 3, // 最近幾個 AI 樓層出場、變動過的記事也送
        memory: true, // 從已壓縮成章的舊樓層裡，挑相關的單層摘要一起送
        memoryTopK: 3,
        noteTopK: 5, // 向量最多再補幾條記事
        threshold: 45, // 向量相似度門檻（%）
        // 預填硅基流動和推薦模型（使用者要求），只要自己填 Key。
        vector: { enabled: false, url: VECTOR_URL, key: '', model: VECTOR_MODEL },
    },
    // 帶到新聊天的摘要：'condense' 請模型濃縮成一段 | 'raw' 原樣帶過去。recapLength：濃縮成大約幾個字。
    carry: { recapMode: 'condense', recapLength: 400 },
    // 擴充更新後自動重新整理頁面（等生成、摘要做完）。
    update: { autoReload: true },
    inject: {
        // 'before_recent' 放在保留原文的最新幾層前面（推薦）| 'in_chat' 聊天中依深度 | 'in_prompt' | 'before_prompt'
        position: 'before_recent',
        depth: 4,
    },
    // null = 使用目前語言的預設模板；字串 = 使用者改過的內容。
    prompts: { l1: null, l2: null, l3: null, recap: null, catchup: null },
    // 每張角色卡自己的資料，key 是角色卡頭像檔名：{ [avatar]: { scope } }
    characters: {},
    // 設定格式的版本，用來做一次性的轉換。
    settingsVersion: 4,
});

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 用預設值補齊已存的設定，保留使用者的值，丟掉型別不對的值。 */
function mergeDefaults(defaults, saved) {
    const out = {};
    for (const [key, def] of Object.entries(defaults)) {
        const val = isPlainObject(saved) ? saved[key] : undefined;
        if (isPlainObject(def) && Object.keys(def).length === 0) {
            // 空物件的預設值代表「任意 key 的對照表」，整個保留。
            out[key] = isPlainObject(val) ? val : {};
        } else if (isPlainObject(def)) {
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

export const NOTE_TYPE_KEYS = ['character', 'item', 'promise', 'todo'];

/** 某一項有沒有勾選要記錄（time／location／cast／character／item／promise／todo）。 */
export function isTracked(key) {
    return getSettings().track?.[key] !== false;
}

/** 有勾選的記事類型。 */
export function trackedNoteTypes() {
    return NOTE_TYPE_KEYS.filter(isTracked);
}

/** 啟動時呼叫一次：補齊設定並寫回 extensionSettings。 */
export function initSettings() {
    const c = ctx();
    if (!c) {
        fallback = mergeDefaults(DEFAULTS, null);
        return fallback;
    }
    const saved = c.extensionSettings[MODULE];
    const s = mergeDefaults(DEFAULTS, saved);
    // v1 → v2：摘要預設長度調短（使用者回報太長）。還是舊預設值的才換，自己改過的不動。
    if (saved && !(saved.settingsVersion >= 2)) {
        const sum = s.summary;
        if (sum.ratioMin === 5 && sum.ratioMax === 10 && sum.maxTokens === 300) {
            Object.assign(sum, { ratioMin: DEFAULTS.summary.ratioMin, ratioMax: DEFAULTS.summary.ratioMax, maxTokens: DEFAULTS.summary.maxTokens });
        }
    }
    // v2 → v3：新增「放在最新原文前面」並設為預設。還是舊預設（聊天中、深度 4）的才換。
    if (saved && !(saved.settingsVersion >= 3)) {
        if (s.inject.position === 'in_chat' && s.inject.depth === 4) s.inject.position = 'before_recent';
    }
    // v3 → v4：向量模型預填硅基流動。v0.6.0 存下的是空白，網址和模型都還沒填的才補上。
    if (saved && !(saved.settingsVersion >= 4)) {
        const v = s.recall.vector;
        if (!v.url && !v.model) Object.assign(v, { url: VECTOR_URL, model: VECTOR_MODEL });
    }
    s.settingsVersion = DEFAULTS.settingsVersion;
    // 舊版的 'auto' 就是現在的 'before'。
    if (s.summary.mode === 'auto') s.summary.mode = 'before';
    if (!['after', 'manual', 'before'].includes(s.summary.mode)) s.summary.mode = DEFAULTS.summary.mode;
    c.extensionSettings[MODULE] = s;
    return s;
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
