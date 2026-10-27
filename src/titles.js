// 幫舊的約定／待辦補短標題（v0.13.7，使用者要求）：一次送一批（內容）給模型，請它各寫一個 15 字內的標題。
// 新的約定／待辦摘要時模型就會寫 title，這裡只處理以前沒有標題的。

import { LOG_PREFIX } from './util.js';
import { t } from './i18n.js';
import { generateText } from './llm.js';
import { parseJsonLenient } from './json.js';
import { ApiError } from './api/custom.js';
import { notesWithoutTitle, setTitlesManual } from './notes.js';

/** 一次送幾條。 */
export const TITLE_BATCH = 40;

let state = { busy: false, done: 0, total: 0, error: null };
const listeners = new Set();

export function titleProgress() {
    return state;
}

export function onTitleProgress(fn) {
    listeners.add(fn);
}

function update(patch) {
    state = { ...state, ...patch };
    for (const fn of listeners) {
        try { fn(state); } catch (e) { console.error(e); }
    }
}

function buildPrompt(notes) {
    const list = notes.map((n) => `[${n.id}] ${n.data.content}`).join('\n');
    return t('prompt.titles', { list });
}

/** 模型回的 { id: 標題 }；格式不對就丟錯。 */
function parseTitles(raw, ids) {
    const parsed = parseJsonLenient(raw, { accept: (v) => v && typeof v === 'object' && !Array.isArray(v) });
    const obj = parsed?.value;
    if (!obj) throw new ApiError('parse', String(raw ?? '').slice(0, 120));
    const out = {};
    for (const id of ids) {
        const v = obj[id] ?? obj[`[${id}]`];
        if (typeof v === 'string' && v.trim()) out[id] = v.trim();
    }
    return out;
}

/** 補標題：一批一批來，回傳補了幾條。出錯就停下來（已經補好的保留）。 */
export async function fillTitles() {
    if (state.busy) return 0;
    const todo = notesWithoutTitle();
    update({ busy: true, done: 0, total: todo.length, error: null });
    let done = 0;
    try {
        for (let k = 0; k < todo.length; k += TITLE_BATCH) {
            const batch = todo.slice(k, k + TITLE_BATCH);
            const raw = await generateText(buildPrompt(batch), { maxTokens: Math.max(3000, batch.length * 60), purpose: 'titles' });
            done += setTitlesManual(parseTitles(raw, batch.map((n) => n.id)));
            update({ done });
        }
        update({ busy: false });
    } catch (e) {
        console.warn(LOG_PREFIX, '補標題失敗', e);
        update({ busy: false, error: e });
    }
    return done;
}
