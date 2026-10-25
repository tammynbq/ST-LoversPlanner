// 摘要時跳過的內容（使用者要求）：思維鏈、狀態欄／小劇場、HTML 和程式碼區塊、自訂標籤；
// 也可以反過來「只看正文標籤」裡的內容。只影響送去摘要的文字，聊天本身和送給角色的原文都不動。
//
// 註：酒館自己的「推理」折疊框存在 extra.reasoning，本來就不在 mes 裡，不會被摘要。

import { getSettings, saveSettings } from './settings.js';

const THINKING = ['think', 'thinking', 'thought', 'thoughts', 'reasoning', 'reflection', '思考', '思維鏈', '思维链', '思維', '思维', '內心', '内心'];
const STATUS = ['status', 'statusbar', 'status_bar', 'state', 'theater', 'theatre', '狀態欄', '状态栏', '狀態', '状态', '小劇場', '小剧场'];
const HTML_BLOCKS = ['details', 'style', 'script', 'table', 'svg'];

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 「a, b、c」→ ['a', 'b', 'c']（允許角括號，例如 <status>）。 */
export function parseTagList(text) {
    return String(text ?? '').split(/[\s,，、;；]+/).map((x) => x.replace(/^<\/?|>$/g, '').trim()).filter(Boolean);
}

/** 拿掉 <name …>…</name>（不分大小寫，可以跨行）。 */
function dropTag(text, name, { prefilled = false } = {}) {
    const n = escapeRe(name);
    let out = text.replace(new RegExp(`<\\s*${n}(?:\\s[^>]*)?>[\\s\\S]*?<\\s*\\/\\s*${n}\\s*>`, 'gi'), '');
    // 思維鏈只有結尾沒有開頭（開頭被預填掉了）：結尾之前的全部都是它。
    if (!prefilled) return out;
    const close = new RegExp(`<\\s*\\/\\s*${n}\\s*>`, 'i');
    const open = new RegExp(`<\\s*${n}(?:\\s[^>]*)?>`, 'i');
    const m = out.match(close);
    if (m && !open.test(out.slice(0, m.index))) out = out.slice(m.index + m[0].length);
    return out;
}

/** 只留下這些標籤裡的內容（訊息裡都沒有這些標籤時，原樣返回）。 */
function onlyTags(text, names) {
    const parts = [];
    for (const name of names) {
        const n = escapeRe(name);
        const re = new RegExp(`<\\s*${n}(?:\\s[^>]*)?>([\\s\\S]*?)(?:<\\s*\\/\\s*${n}\\s*>|$)`, 'gi');
        for (const m of text.matchAll(re)) parts.push(m[1]);
    }
    return parts.length ? parts.join('\n') : text;
}

/** 程式碼區塊和 HTML 排版：區塊整個拿掉，其他標籤拿掉但保留裡面的字。 */
function dropHtml(text, keep = new Set()) {
    let out = text.replace(/```[\s\S]*?(?:```|$)/g, '');
    out = out.replace(/<!--[\s\S]*?-->/g, '');
    for (const name of HTML_BLOCKS) if (!keep.has(name)) out = dropTag(out, name);
    out = out.replace(/<br\s*\/?>/gi, '\n');
    // 剩下的 HTML 標籤（div、span、p、font…）只拿掉標籤本身。
    return out.replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, '');
}

/** 送去摘要之前整理一則訊息。rules 預設用目前的設定（測試框會傳入草稿）。 */
export function cleanForSummary(text, rules = getSettings().filter) {
    let out = String(text ?? '');
    if (!rules) return out;
    const only = parseTagList(rules.only);
    if (only.length) out = onlyTags(out, only);
    // keep：使用者選了「讀」的標籤，內建的清單也不拿掉。
    const keep = new Set(parseTagList(rules.keep).map((x) => x.toLowerCase()));
    const kept = (name) => !keep.has(name.toLowerCase());
    if (rules.thinking) for (const name of THINKING.filter(kept)) out = dropTag(out, name, { prefilled: true });
    for (const name of [...(rules.status ? STATUS : []), ...parseTagList(rules.tags)].filter(kept)) out = dropTag(out, name);
    if (rules.html) out = dropHtml(out, keep);
    return out.replace(/\n{3,}/g, '\n\n').trim();
}

// ===== 掃描訊息裡的標籤，讓使用者逐一選「讀／不讀／只讀」 =====

/** 排版用的行內標籤，不列出來（拿掉標籤、保留文字就好）。 */
const INLINE = new Set(['b', 'i', 'u', 's', 'em', 'strong', 'small', 'big', 'sup', 'sub', 'br', 'hr', 'span', 'div', 'p', 'font', 'img', 'a', 'center', 'ruby', 'rt', 'rp', 'mark', 'q', 'del', 'ins', 'code', 'pre', 'li', 'ul', 'ol', 'tr', 'td', 'th', 'tbody', 'thead', 'summary', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'section', 'article', 'header', 'footer', 'label', 'button', 'input']);

/** 找出訊息裡用到的標籤：[{ name, count, sample }]（依出現順序）。 */
export function scanTags(messages) {
    const found = new Map();
    const re = /<\s*([A-Za-z\u3400-\u9fff\uf900-\ufaff][\w\u3400-\u9fff\uf900-\ufaff:-]*)(?:\s[^<>]*)?>/g;
    for (const text of messages) {
        const src = String(text ?? '');
        for (const m of src.matchAll(re)) {
            const name = m[1];
            const key = name.toLowerCase();
            if (INLINE.has(key)) continue;
            if (!found.has(key)) {
                // 範例：標籤裡面的前 40 個字。
                const close = src.slice(m.index + m[0].length).search(new RegExp(`<\\s*\\/\\s*${escapeRe(name)}\\s*>`, 'i'));
                const inner = src.slice(m.index + m[0].length, close >= 0 ? m.index + m[0].length + close : undefined);
                found.set(key, { name, count: 0, sample: inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) });
            }
            found.get(key).count++;
        }
    }
    return [...found.values()];
}

/** 這個標籤目前怎麼處理：{ mode: 'read'|'skip'|'only', builtin: 'thinking'|'status'|'html'|null }。 */
export function tagMode(name, rules = getSettings().filter) {
    const key = name.toLowerCase();
    const has = (list) => parseTagList(list).some((x) => x.toLowerCase() === key);
    const builtin = THINKING.includes(key) ? 'thinking' : STATUS.includes(key) ? 'status' : HTML_BLOCKS.includes(key) ? 'html' : null;
    if (has(rules.only)) return { mode: 'only', builtin };
    if (has(rules.tags)) return { mode: 'skip', builtin };
    const builtinOn = builtin && rules[builtin] && !has(rules.keep);
    return { mode: builtinOn ? 'skip' : 'read', builtin };
}

/** 設定某個標籤要讀、不讀，或只讀它。改的是 filter.tags／only／keep 三個清單。 */
export function setTagMode(name, mode) {
    const rules = getSettings().filter;
    const key = name.toLowerCase();
    const without = (list) => parseTagList(list).filter((x) => x.toLowerCase() !== key);
    const tags = without(rules.tags);
    const only = without(rules.only);
    const keep = without(rules.keep);
    const { builtin } = tagMode(name, { ...rules, tags: '', only: '', keep: '' });
    const builtinOn = Boolean(builtin && rules[builtin]);
    if (mode === 'skip' && !builtinOn) tags.push(name);
    if (mode === 'read' && builtinOn) keep.push(name);
    if (mode === 'only') only.push(name);
    rules.tags = tags.join(', ');
    rules.only = only.join(', ');
    rules.keep = keep.join(', ');
    saveSettings();
}
