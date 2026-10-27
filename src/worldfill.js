// 🌍 從世界書填寫（v0.13.19，使用者要求）：和 📇 從人設填寫一樣，只是讀世界書裡的人物條目來填配角。
// 讀哪些世界書：角色卡綁定的（data.extensions.world）、角色卡內嵌的（character_book）、這個聊天綁定的（chat_metadata.world_info）。
// 使用者先從清單勾要填的條目（名字對得上已經記下的人物的會先勾好），每 BATCH 條一次呼叫，
// 模型判斷是不是人物、整理成欄位；不是人物的條目跳過。填好的欄位標「人設」：不送給角色
// （世界書條目被觸發時酒館本來就會送），摘要時給模型參考，故事裡改了才更新。

import { ctx, LOG_PREFIX } from './util.js';
import { t } from './i18n.js';
import { charFields } from './settings.js';
import { generateText } from './llm.js';
import { parseJsonLenient } from './json.js';
import { ApiError } from './api/custom.js';
import { charFieldRules } from './l1rules.js';
import { fillCharactersFromWorld, getNotes } from './notes.js';

/** 一次送幾條給模型。 */
export const WORLD_BATCH = 8;
/** 每條最多送多少字。 */
const MAX_ENTRY = 3000;
/** 「會一直變」的欄位不從設定填。 */
const SKIP = new Set(['status', 'outfit']);

function sub(text) {
    const c = ctx();
    const s = String(text ?? '').trim();
    try {
        return typeof c?.substituteParams === 'function' ? c.substituteParams(s) : s;
    } catch {
        return s;
    }
}

/** 讀一本世界書：先用 context 的 loadWorldInfo，沒有就直接問酒館後端。 */
async function loadBook(name) {
    const c = ctx();
    if (typeof c?.loadWorldInfo === 'function') return c.loadWorldInfo(name);
    const res = await fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: { ...(c?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' }) },
        body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

function toEntry(book, uid, e) {
    const content = sub(e?.content).slice(0, MAX_ENTRY);
    if (!content || e?.disable || e?.enabled === false) return null;
    const keys = [...(Array.isArray(e.key) ? e.key : Array.isArray(e.keys) ? e.keys : [])].map((k) => String(k).trim()).filter(Boolean);
    const title = String(e.comment ?? e.name ?? '').trim() || keys[0] || `#${uid}`;
    return { id: `${book}::${uid}`, book, title, keys, content };
}

/** 這個聊天看得到的世界書條目：[{ id, book, title, keys, content, known }]。 */
export async function listWorldEntries() {
    const c = ctx();
    const ch = c?.characters?.[c?.characterId];
    const out = [];
    const books = [...new Set([ch?.data?.extensions?.world, c?.chatMetadata?.world_info].filter(Boolean))];
    for (const name of books) {
        try {
            const data = await loadBook(name);
            for (const [uid, e] of Object.entries(data?.entries ?? {})) {
                const x = toEntry(name, uid, e);
                if (x) out.push(x);
            }
        } catch (e) {
            console.warn(LOG_PREFIX, `讀世界書「${name}」失敗`, e);
        }
    }
    // 角色卡內嵌的世界書（沒有匯入成獨立世界書時）。
    const embedded = ch?.data?.character_book;
    if (embedded?.entries && !books.includes(embedded.name)) {
        const label = embedded.name || t('world.embedded');
        (Array.isArray(embedded.entries) ? embedded.entries : Object.values(embedded.entries)).forEach((e, k) => {
            const x = toEntry(label, e?.id ?? k, e);
            if (x) out.push(x);
        });
    }
    // 名字對得上已經記下的人物：先勾好。
    const names = [...getNotes().notes.values()].filter((n) => n.type === 'character')
        .flatMap((n) => [n.data.name, ...String(n.data.alias ?? '').split(/[、,，/／;；]+/)])
        .map((x) => String(x ?? '').trim().toLowerCase()).filter((x) => x.length >= 2);
    return out.map((x) => {
        const hay = [x.title, ...x.keys].map((k) => k.toLowerCase());
        return { ...x, known: hay.some((k) => names.some((n) => k === n || k.includes(n) || n.includes(k))) };
    });
}

export function worldFillFields() {
    return charFields().filter((f) => !SKIP.has(f));
}

export function buildWorldPrompt(entries) {
    const c = ctx();
    const vars = { char: c?.name2 ?? '{{char}}', user: c?.name1 ?? '{{user}}' };
    const fields = worldFillFields();
    const list = entries.map((x) => `[${x.id}] ${x.title}${x.keys.length ? `（${x.keys.join('、')}）` : ''}\n${x.content}`).join('\n\n');
    return t('prompt.world', {
        ...vars,
        fields: charFieldRules(fields, vars),
        entries: list,
        example: `{ "entry": "…", ${fields.map((f) => `"${f}": "…"`).join(', ')} }`,
    });
}

/** 模型回的 { characters: [{ entry, name, ...欄位 }] }：只留這一批的條目、有名字的。 */
export function parseWorld(raw, ids) {
    const parsed = parseJsonLenient(raw, { accept: (v) => v && typeof v === 'object' && Array.isArray(v.characters) });
    const list = parsed?.value?.characters;
    if (!Array.isArray(list)) throw new ApiError('parse', String(raw ?? '').slice(0, 120));
    const allowed = new Set(worldFillFields());
    const out = [];
    for (const x of list) {
        if (!x || typeof x !== 'object' || (x.entry && !ids.includes(String(x.entry)))) continue;
        const data = Object.fromEntries(Object.entries(x).filter(([f, v]) => allowed.has(f) && typeof v === 'string' && v.trim()));
        if (data.name) out.push({ data });
    }
    return out;
}

let state = { busy: false, done: 0, total: 0 };
export function worldFillState() {
    return state;
}

/** 填寫這些條目：回傳 { added, updated }；出錯就停（已經填好的保留）並丟錯（帶著目前的結果）。 */
export async function fillFromWorld(entries, onProgress = () => {}) {
    if (state.busy) return null;
    state = { busy: true, done: 0, total: entries.length };
    const sum = { added: 0, updated: 0 };
    onProgress();
    try {
        for (let k = 0; k < entries.length; k += WORLD_BATCH) {
            const batch = entries.slice(k, k + WORLD_BATCH);
            const raw = await generateText(buildWorldPrompt(batch), { maxTokens: Math.max(3000, batch.length * 500), purpose: 'card' });
            const r = fillCharactersFromWorld(parseWorld(raw, batch.map((x) => x.id)));
            sum.added += r.added;
            sum.updated += r.updated;
            state = { ...state, done: Math.min(entries.length, k + batch.length) };
            onProgress();
        }
        return sum;
    } catch (e) {
        console.warn(LOG_PREFIX, '從世界書填寫失敗', e);
        e.partial = sum;
        throw e;
    } finally {
        state = { ...state, busy: false };
        onProgress();
    }
}
