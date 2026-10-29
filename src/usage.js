// 調用紀錄（v0.13.14，使用者要求）：戀人手帳自己每次呼叫模型的紀錄。不多花任何呼叫，只是記下來。
// 不包含平常聊天本身（那是酒館的，戀人手帳看不到）。
//
// 存在 extensionSettings.lovers_planner.usage：
//   days:   { 'YYYY-MM-DD': { [模型]: { [用途]: { calls, fails, input, output, ms, est } } } }  最多留 DAYS_KEPT 天
//   recent: [{ at, purpose, model, input, output, est, ms, ok, error, chat }]                最多 RECENT_MAX 筆，新的在前
// input／output：服務商有回報實際用量就用實際的，沒有就粗估（est = true，畫面上標 ≈）。

import { getSettings, saveSettings } from './settings.js';
import { chatKey } from './chat.js';

export const PURPOSES = ['l1', 'side', 'card', 'tidy', 'catchup', 'compress', 'recap', 'check', 'titles', 'diary', 'diaryCompress', 'other'];
const DAYS_KEPT = 120;
const RECENT_MAX = 200;

/** 粗估 token（和 hide.js 的 estimateTokens 一樣；這裡另寫一份免得互相 import）。 */
export function roughTokens(text) {
    const s = String(text ?? '');
    const cjk = (s.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
    return Math.ceil(cjk / 1.2 + (s.length - cjk) / 4);
}

function store() {
    const s = getSettings();
    if (!s.usage || typeof s.usage !== 'object') s.usage = { days: {}, recent: [] };
    s.usage.days ??= {};
    s.usage.recent ??= [];
    return s.usage;
}

/** 本地日期（YYYY-MM-DD）：「今天」照使用者的時區算。 */
export function localDay(at = Date.now()) {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const listeners = new Set();
export function onUsageChange(fn) {
    listeners.add(fn);
}

/** 記一筆。 */
export function recordUsage({ purpose = 'other', model = '', input = 0, output = 0, est = false, ms = 0, ok = true, error = '' }) {
    const u = store();
    const at = Date.now();
    const day = localDay(at);
    const p = PURPOSES.includes(purpose) ? purpose : 'other';
    const m = String(model || '?').slice(0, 80);
    const slot = ((u.days[day] ??= {})[m] ??= {})[p] ??= { calls: 0, fails: 0, input: 0, output: 0, ms: 0, est: false };
    slot.calls++;
    if (!ok) slot.fails++;
    slot.input += Math.max(0, Math.round(input));
    slot.output += Math.max(0, Math.round(output));
    slot.ms += Math.max(0, Math.round(ms));
    if (est) slot.est = true;
    u.recent.unshift({ at, purpose: p, model: m, input: Math.round(input), output: Math.round(output), est, ms: Math.round(ms), ok, ...(error ? { error: String(error).slice(0, 120) } : {}), chat: chatKey() ?? '' });
    if (u.recent.length > RECENT_MAX) u.recent.length = RECENT_MAX;
    // 太舊的天數拿掉。
    const keys = Object.keys(u.days).sort();
    if (keys.length > DAYS_KEPT) for (const k of keys.slice(0, keys.length - DAYS_KEPT)) delete u.days[k];
    saveSettings();
    for (const fn of listeners) {
        try { fn(); } catch (e) { console.error(e); }
    }
}

/**
 * 統計：sinceDay（含）以後。回傳 { total, byModel: [{ model, ... }], byPurpose: [{ purpose, ... }] }，
 * 每一項是 { calls, fails, input, output, ms, est }，依 input+output 由多到少。
 */
export function usageSummary(sinceDay) {
    const u = store();
    const zero = () => ({ calls: 0, fails: 0, input: 0, output: 0, ms: 0, est: false });
    const add = (a, b) => {
        a.calls += b.calls; a.fails += b.fails; a.input += b.input; a.output += b.output; a.ms += b.ms;
        if (b.est) a.est = true;
    };
    const total = zero();
    const models = new Map();
    const purposes = new Map();
    for (const [day, byModel] of Object.entries(u.days)) {
        if (sinceDay && day < sinceDay) continue;
        for (const [model, byPurpose] of Object.entries(byModel)) {
            for (const [purpose, v] of Object.entries(byPurpose)) {
                add(total, v);
                if (!models.has(model)) models.set(model, zero());
                add(models.get(model), v);
                if (!purposes.has(purpose)) purposes.set(purpose, zero());
                add(purposes.get(purpose), v);
            }
        }
    }
    const sort = (list) => list.sort((a, b) => (b.input + b.output) - (a.input + a.output));
    return {
        total,
        byModel: sort([...models].map(([model, v]) => ({ model, ...v }))),
        byPurpose: sort([...purposes].map(([purpose, v]) => ({ purpose, ...v }))),
    };
}

export function recentUsage(n = 20) {
    return store().recent.slice(0, n);
}

export function clearUsage() {
    getSettings().usage = { days: {}, recent: [] };
    saveSettings();
    for (const fn of listeners) {
        try { fn(); } catch (e) { console.error(e); }
    }
}
