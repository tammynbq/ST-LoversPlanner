// 插件的全域設定：存在酒館的 extensionSettings 裡。

import { ctx, MODULE } from './util.js';
import { VERSION } from './version.js';

export const VECTOR_URL = 'https://api.siliconflow.cn/v1';
export const VECTOR_MODEL = 'BAAI/bge-m3';

export const DEFAULTS = Object.freeze({
    enabled: true,
    // 'auto' = 跟著酒館的介面語言；也可以是 'zh-TW' / 'zh-CN' / 'en'。
    // 摘要和記事也用這個語言寫。
    language: 'auto',
    // 'main' = 沿用酒館目前的連線；'custom' = 自訂 OpenAI 相容 API。
    source: 'main',
    // timeout：呼叫模型最多等幾秒（30～600）。
    custom: { url: '', key: '', model: '', timeout: 120 },
    // 每次呼叫模型都放在最前面的系統提示詞（v0.13.4）：adultNote 成人虛構故事的說明；preface 使用者自訂的前言。
    model: { adultNote: true, preface: '' },
    // 補建前先找出可能是番外／小劇場／IF 線的樓層，讓使用者決定要不要跳過（v0.13.5，使用者要求）。
    catchup: { askExtras: true, extraWords: '番外, 小劇場, 小剧场, IF線, IF线, IF世界線, IF世界线, 平行世界, 特別篇, 特别篇' },
    summary: {
        // 'after' 每回正文結束後自動 | 'manual' 手動 | 'before' 開始下回前自動（使用者送出下一句時摘要上一層）
        mode: 'before',
        includeUser: true,
        ratioMin: 3,
        ratioMax: 6,
        minTokens: 30,
        maxTokens: 150,
    },
    // 摘要時跳過的內容（只影響送去摘要的文字）。tags：自訂要跳過的標籤；only：只看這些標籤裡的內容；
    // keep：內建清單裡、但使用者選了「要讀」的標籤。
    filter: {
        thinking: true, status: true, html: true, tags: '', only: '', keep: '', theater: 'keepsake', theaterTags: '',
        // 只當參考的標籤，以及要從裡面抽出來的欄位名稱（v0.13.0）。
        ref: '', refKeys: 'time, date, 時間, 日期, 時段, location, 地點, 时间, 时段, 地点',
    },
    // 分層壓縮（2026-10-25 依真實聊天紀錄的測試改，見 SPEC 2.3）：
    // L2 每 l1PerL2 層一章（只看比例）；L3 每 l2PerL3 章一卷；L4 以上每 higherPer 個一組，沒有層數上限。
    // capL3／capL4／capL5／capMore：各層的長度上限（tokens），越高層越短，越舊的越粗。
    compress: {
        auto: true, // 到期就自動壓縮
        l1PerL2: 10,
        l2PerL3: 5,
        higherPer: 5,
        ratioMin: 30,
        ratioMax: 40,
        capL3: 200,
        capL4: 400,
        capL5: 500,
        capMore: 600,
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
        // 人物資料要記哪些欄位（名字一定記）。
        fields: {
            alias: true, identity: true, age: true, birthday: true, relUser: true, relChar: true, appearance: true, outfit: true,
            status: true, personality: true, likes: true, dislikes: true, habits: true, history: true, note: true,
        },
    },
    // 行事曆：故事裡的日期＋行程、生理期（{{user}} 的）、親熱的日子、紀念日。
    // start：故事開始日（模型完全沒線索時從這天算）；ahead：送給角色「接下來幾天」的事。
    calendar: {
        enabled: true,
        track: { plan: true, period: true, intimacy: true, anniversary: true },
        start: '',
        inject: true,
        ahead: 7,
        // 生理期推算（v0.13.2，使用者要求，預設關）：用記到的週期算「下次大約哪幾天」；ovulation：也推算排卵期。
        predict: false,
        ovulation: false,
    },
    // 回憶錄：auto＝摘要時讓模型挑值得珍藏的時刻；recall＝偶爾讓角色想起。
    // everyN：平均每幾回想起一次（隨機）；count：一次最多幾條；minAge：至少多少個 AI 樓層以前的才算回憶；
    // cooldown：提過的回憶，過幾個 AI 樓層才會再被挑到。
    memories: { enabled: true, auto: true, recall: true, everyN: 10, count: 2, minAge: 20, cooldown: 30 },
    hide: {
        markHidden: true,
        // 也用酒館自己的「隱藏」（像 /hide）標起已摘要的舊樓層（v0.13.13，預設關）。
        stHide: false,
    },
    // 畫面（v0.13.16 起）：hideSkip 摘要分頁隱藏 👻 跳過的樓層；
    // theme 外觀（v0.13.22，使用者要求）：'tavern' 跟隨酒館主題 | 'techo' 日系手帳；themeBlocks 聊天裡的摘要區塊也套用。
    // （以前 ui 不在預設值裡，重新整理後 hideSkip 會被 mergeDefaults 丟掉。）
    // seenVersion（v0.13.30）：看過哪一版的更新通知；新安裝時直接設成目前版本，不跳通知。
    ui: { hideSkip: false, theme: 'tavern', themeBlocks: false, seenVersion: '' },
    // 角色還沒有自己的「共同設定」時用的初始值：'none' | 'copy' | 'share'（見 scope.js）
    scope: {
        summary: 'copy',
        characters: 'share',
        items: 'copy',
        promises: 'copy',
        todos: 'none',
        // 回憶錄（v0.13.20，使用者要求）：複製帶走＝新聊天有一份；即時共用＝讀來源聊天最新的回憶（唯讀）。
        memories: 'copy',
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
    // 好幾組 API（v0.13.35，使用者要求）：custom 是原本那組；profiles 是另外存的 [{ id, name, url, key, model }]。
    // routes：每種工作用哪一組（'inherit' 跟預設／'main'／'custom'／profile id）；fallback：失敗時改用哪一組（空的＝不改用）。
    customName: '',
    profiles: [],
    routes: { l1: 'inherit', compress: 'inherit', catchup: 'inherit', diary: 'inherit', diaryCompress: 'inherit', other: 'inherit' },
    fallback: '',
    prompts: { l1: null, l2: null, l3: null, recap: null, catchup: null, audit: null, diary: null, diaryConcise: null, diaryCompress: null },
    // 日記（v0.13.34）：style 'natural' 自然（像回憶，預設）| 'concise' 精簡（像紀錄）。
    diary: { style: 'natural' },
    // 每張角色卡自己的資料，key 是角色卡頭像檔名：{ [avatar]: { scope } }
    characters: {},
    // 設定格式的版本，用來做一次性的轉換。
    settingsVersion: 5,
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

/** 人物資料的欄位（名字以外都可以關掉）。和 notes.js 的 NOTE_FIELDS.character 同步。 */
export const CHARACTER_FIELDS = ['name', 'alias', 'identity', 'age', 'birthday', 'relUser', 'relChar', 'appearance', 'outfit', 'status',
    'personality', 'likes', 'dislikes', 'habits', 'history', 'note'];

/** 有勾選要記錄的人物欄位（track.fields.x 是 false 就不記）。 */
export function charFields() {
    const off = getSettings().track?.fields ?? {};
    return CHARACTER_FIELDS.filter((f) => f === 'name' || off[f] !== false);
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
    // v4 → v5：L3 改成每 5 章一卷（測試結果）。還是舊預設 10 的才換。
    if (saved && !(saved.settingsVersion >= 5)) {
        if (s.compress.l2PerL3 === 10) s.compress.l2PerL3 = DEFAULTS.compress.l2PerL3;
    }
    // 新安裝的不用看「更新了什麼」。
    if (!saved) s.ui.seenVersion = VERSION;
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
