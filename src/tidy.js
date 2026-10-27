// 🩺 整理人物（v0.13.16，使用者要求）：人物的狀態寫成一大段、備註和經歷裡寫了發生過的事（和摘要、回憶錄重複）。
// 檢查時列出欄位太長的人物；按「請模型整理」會把欄位縮短，備註／經歷裡「發生過的事」拿掉：
// 回憶錄裡已經有的直接刪，沒有的搬進回憶錄（使用者決定；出處算這個人物最後被更新的那一層，回憶錄才有大概的時間）。每個人物一次呼叫。
// 來自人設的欄位（cardFields）不算：它們不送給角色，長一點沒關係。

import { ctx, LOG_PREFIX } from './util.js';
import { t } from './i18n.js';
import { generateText } from './llm.js';
import { parseJsonLenient } from './json.js';
import { ApiError } from './api/custom.js';
import { getNotes, noteTitle, updateNoteManual } from './notes.js';
import { charFields } from './settings.js';
import { estimateTokens } from './hide.js';
import { addMemory, listMemories } from './memories.js';

/** 每個欄位超過多少 token 算太長（中文大約 1.2 字一個 token：狀態、衣著、備註約 40 字）。 */
export const FIELD_LIMITS = { status: 35, outfit: 35, note: 35, appearance: 55, history: 100 };

/** 回憶錄最多給模型看幾條（比對「已經有了沒」用）。 */
const MAX_MEMORIES = 80;

/** 這個人物哪些欄位太長（不算來自人設的）。 */
export function longFields(note) {
    if (note?.type !== 'character') return [];
    const card = new Set(note.cardFields ?? []);
    const on = new Set(charFields());
    return Object.keys(FIELD_LIMITS).filter((f) => on.has(f) && !card.has(f) && note.data?.[f] && estimateTokens(note.data[f]) > FIELD_LIMITS[f]);
}

function buildPrompt(note, fields) {
    const c = ctx();
    const lines = fields.map((f) => `${f}: ${note.data[f]}`).join('\n');
    const mem = listMemories().slice(-MAX_MEMORIES).map((m) => `- ${m.title}：${m.content}`).join('\n');
    return t('prompt.tidy', {
        char: c?.name2 ?? '{{char}}',
        user: c?.name1 ?? '{{user}}',
        name: noteTitle(note),
        fields: lines,
        memories: mem || t('prompt.tidy.noMemories'),
        keys: fields.join(', '),
    });
}

/** 模型回的 { fields: { 欄位: 新內容 }, memories: [{ title, content }] }。 */
export function parseTidy(raw, fields) {
    const parsed = parseJsonLenient(raw, { accept: (v) => v && typeof v === 'object' && v.fields && typeof v.fields === 'object' });
    const v = parsed?.value;
    if (!v) throw new ApiError('parse', String(raw ?? '').slice(0, 120));
    const out = {};
    for (const f of fields) if (typeof v.fields[f] === 'string') out[f] = v.fields[f].trim();
    const memories = (Array.isArray(v.memories) ? v.memories : [])
        .map((m) => ({ title: String(m?.title ?? '').trim(), content: String(m?.content ?? '').trim() }))
        .filter((m) => m.content)
        .slice(0, 5);
    return { fields: out, memories };
}

/** 和回憶錄裡已有的幾乎一樣（標題一樣，或內容互相包含）就不搬。 */
function alreadyKept(m, existing) {
    const norm = (x) => String(x ?? '').replace(/[\s\p{P}]/gu, '').toLowerCase();
    const title = norm(m.title);
    const body = norm(m.content);
    return existing.some((e) => (title && norm(e.title) === title) || (body.length >= 8 && (norm(e.content).includes(body) || body.includes(norm(e.content)))));
}

const busy = new Set();
export function tidyBusy(id) {
    return busy.has(id);
}

/** 整理一個人物。回傳 { title, changed, moved }。 */
export async function tidyCharacter(id) {
    const note = getNotes().notes.get(id);
    const fields = longFields(note);
    if (!fields.length || busy.has(id)) return { title: noteTitle(note), changed: 0, moved: 0 };
    busy.add(id);
    try {
        const raw = await generateText(buildPrompt(note, fields), { maxTokens: 2000, purpose: 'tidy' });
        const res = parseTidy(raw, fields);
        // 整理的途中記事可能又變了：用最新的那條。
        const now = getNotes().notes.get(id);
        if (!now) return { title: noteTitle(note), changed: 0, moved: 0 };
        const changed = Object.keys(res.fields).filter((f) => res.fields[f] !== (now.data[f] ?? ''));
        if (changed.length) updateNoteManual(id, { ...now.data, ...Object.fromEntries(changed.map((f) => [f, res.fields[f]])) });
        const existing = listMemories();
        let moved = 0;
        for (const m of res.memories) {
            if (alreadyKept(m, existing)) continue;
            if (addMemory({ title: m.title, content: m.content, floor: now.updatedFloor ?? now.createdFloor ?? null })) {
                existing.push(m);
                moved++;
            }
        }
        return { title: noteTitle(now), changed: changed.length, moved };
    } catch (e) {
        console.warn(LOG_PREFIX, '整理人物失敗', e);
        throw e;
    } finally {
        busy.delete(id);
    }
}
