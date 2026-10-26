// 摘要時跳過的內容（使用者要求）：思維鏈、狀態欄／小劇場、HTML 和程式碼區塊、自訂標籤；
// 也可以反過來「只看正文標籤」裡的內容。只影響送去摘要的文字，聊天本身和送給角色的原文都不動。
//
// 註：酒館自己的「推理」折疊框存在 extra.reasoning，本來就不在 mes 裡，不會被摘要。
//
// 「參考」（filter.ref，v0.13.0 使用者要求）：標籤不當正文摘要，但把裡面「時間：…」「地點：…」這幾行
// （欄位名稱在 filter.refKeys）抽出來另外附給模型，用來判斷日期、時間、地點。狀態欄常常是日期最準的地方。

import { getSettings, saveSettings } from './settings.js';

const THINKING = ['think', 'thinking', 'thought', 'thoughts', 'reasoning', 'reflection', '思考', '思維鏈', '思维链', '思維', '思维', '內心', '内心'];
const STATUS = ['status', 'statusbar', 'status_bar', 'state', '狀態欄', '状态栏', '狀態', '状态'];
/** 小劇場（番外）：預設不當正劇摘要，但有意義的可以收進回憶錄（filter.theater）。 */
export const THEATER = ['theater', 'theatre', '小劇場', '小剧场', '番外'];
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

function theaterTags(rules) {
    return [...THEATER, ...parseTagList(rules.theaterTags)];
}

/** 小劇場的內容（「只收進回憶錄」時另外給模型看）。沒有就回傳 ''。 */
export function extractTheater(text, rules = getSettings().filter) {
    if (!rules || (rules.theater ?? 'keepsake') !== 'keepsake') return '';
    const parts = [];
    const src = String(text ?? '');
    for (const name of theaterTags(rules)) {
        const n = escapeRe(name);
        for (const m of src.matchAll(new RegExp(`<\\s*${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\s*\\/\\s*${n}\\s*>`, 'gi'))) parts.push(m[1]);
    }
    return parts.map((x) => dropHtml(x).replace(/\n{3,}/g, '\n\n').trim()).filter(Boolean).join('\n\n');
}

/** 「時間：…」「- location: …」這種一行一個欄位的格式：[key, value] 或 null。 */
function keyValue(line) {
    const m = line.match(/^\s*[-*•·]?\s*\[?\s*([^\s:：|｜\]\[]{1,16})\s*\]?\s*[:：]\s*(.*)$/);
    return m ? [m[1], m[2].trim()] : null;
}

/** 一段內容裡的每一行（「時間：A｜地點：B」這種擠在同一行的也拆開）。 */
function linesOf(text) {
    return String(text ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ').split(/\n|[｜|]/).map((x) => x.trim()).filter(Boolean);
}

/**
 * 「參考」標籤裡要抽的那幾行（例如 time: 2025/03/05 晚上、地點：海邊）。沒有就回傳 ''。
 * 每個值最多 80 字，同樣的只留一次。
 */
export function extractRef(text, rules = getSettings().filter) {
    const tags = parseTagList(rules?.ref);
    if (!tags.length) return '';
    const keys = new Set(parseTagList(rules.refKeys).map((x) => x.toLowerCase()));
    if (!keys.size) return '';
    const src = String(text ?? '');
    const out = [];
    for (const name of tags) {
        const n = escapeRe(name);
        for (const m of src.matchAll(new RegExp(`<\\s*${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\s*\\/\\s*${n}\\s*>`, 'gi'))) {
            for (const line of linesOf(m[1])) {
                const kv = keyValue(line);
                if (!kv || !kv[1] || !keys.has(kv[0].toLowerCase())) continue;
                const item = `${kv[0]}: ${kv[1].slice(0, 80)}`;
                if (!out.includes(item)) out.push(item);
            }
        }
    }
    return out.slice(0, 12).join('\n');
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
    // 小劇場：'story' 當正文一起摘要；'keepsake'（只收進回憶錄）和 'skip' 都從正文拿掉。
    const theaterOff = (rules.theater ?? 'keepsake') !== 'story';
    for (const name of [...(rules.status ? STATUS : []), ...(theaterOff ? theaterTags(rules) : []), ...parseTagList(rules.tags)].filter(kept)) out = dropTag(out, name);
    // 「參考」的標籤也不當正文（內容另外用 extractRef 抽）。
    for (const name of parseTagList(rules.ref)) out = dropTag(out, name);
    if (rules.html) out = dropHtml(out, keep);
    return out.replace(/\n{3,}/g, '\n\n').trim();
}

// ===== 掃描訊息裡的標籤，讓使用者逐一選「讀／不讀／只讀」 =====

/** 排版用的行內標籤，不列出來（拿掉標籤、保留文字就好）。 */
const INLINE = new Set(['b', 'i', 'u', 's', 'em', 'strong', 'small', 'big', 'sup', 'sub', 'br', 'hr', 'span', 'div', 'p', 'font', 'img', 'a', 'center', 'ruby', 'rt', 'rp', 'mark', 'q', 'del', 'ins', 'code', 'pre', 'li', 'ul', 'ol', 'tr', 'td', 'th', 'tbody', 'thead', 'summary', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'section', 'article', 'header', 'footer', 'label', 'button', 'input']);

/** 粗估 token（和 hide.js 的 estimateTokens 一樣；這裡另寫一份免得互相 import）。 */
function roughTokens(s) {
    const cjk = (s.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
    return Math.ceil(cjk / 1.2 + (s.length - cjk) / 4);
}

/**
 * 找出訊息裡用到的標籤：[{ name, count, floors, tokens, first, last, sample }]（依出現順序）。
 * messages：字串，或 { index, text }（first／last 是出現過的最舊、最新樓層）。
 * tokens：標籤裡面的內容大約多少 token（沒有結尾的不算）。
 */
export function scanTags(messages) {
    const found = new Map();
    const re = /<\s*([A-Za-z\u3400-\u9fff\uf900-\ufaff][\w\u3400-\u9fff\uf900-\ufaff:-]*)(?:\s[^<>]*)?>/g;
    const closers = new Map();
    for (const item of messages) {
        const src = String((typeof item === 'object' && item !== null ? item.text : item) ?? '');
        const index = typeof item === 'object' && item !== null ? item.index : null;
        const seen = new Set();
        for (const m of src.matchAll(re)) {
            const name = m[1];
            const key = name.toLowerCase();
            if (INLINE.has(key)) continue;
            if (!closers.has(key)) closers.set(key, new RegExp(`<\\s*\\/\\s*${escapeRe(name)}\\s*>`, 'gi'));
            const close = closers.get(key);
            const start = m.index + m[0].length;
            close.lastIndex = start;
            const end = close.exec(src)?.index ?? -1;
            const inner = end >= 0 ? src.slice(start, end) : '';
            if (!found.has(key)) {
                // 範例：標籤裡面的前 40 個字。
                const head = end >= 0 ? inner : src.slice(start, start + 200);
                found.set(key, {
                    name, count: 0, floors: 0, tokens: 0, first: index, last: index, sample: head.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40),
                    full: '', fullAt: null, dated: 0, placed: 0, lines: 0, kvLines: 0, keyCount: new Map(),
                });
            }
            const x = found.get(key);
            x.count++;
            x.tokens += inner ? roughTokens(inner) : 0;
            if (inner) {
                // 判斷類型用：有幾行是「欄位：值」、出現哪些欄位、有沒有日期／時間／地點。
                const lines = linesOf(inner);
                x.lines += lines.length;
                for (const line of lines) {
                    const kv = keyValue(line);
                    if (!kv) continue;
                    x.kvLines++;
                    x.keyCount.set(kv[0], (x.keyCount.get(kv[0]) ?? 0) + 1);
                }
                if (DATE_RE.test(inner) || lines.some((l) => WHEN_KEYS.has(keyValue(l)?.[0]?.toLowerCase()))) x.dated++;
                if (lines.some((l) => WHERE_KEYS.has(keyValue(l)?.[0]?.toLowerCase()))) x.placed++;
                // 完整內容：留最新（樓層最大）的一則，最多 1500 字。
                if (index === null || x.fullAt === null || index >= x.fullAt) {
                    x.full = inner.trim().slice(0, 1500);
                    x.fullAt = index;
                }
            }
            if (!seen.has(key)) {
                seen.add(key);
                x.floors++;
                if (index !== null) {
                    x.first = x.first === null ? index : Math.min(x.first, index);
                    x.last = x.last === null ? index : Math.max(x.last, index);
                }
            }
        }
    }
    return [...found.values()].map((x) => {
        const keys = [...x.keyCount.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
        const { keyCount, fullAt, lines, kvLines, ...rest } = x;
        return { ...rest, keys: keys.slice(0, 12), kind: guessKind(rest.name, keys, lines, kvLines, x.count, x.tokens) };
    });
}

const DATE_RE = /\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*[日號号]|星期[一二三四五六日天]|週[一二三四五六日]|周[一二三四五六日]/;
const WHEN_KEYS = new Set(['time', 'date', 'datetime', 'day', '時間', '时间', '日期', '時段', '时段', '日子']);
const WHERE_KEYS = new Set(['location', 'place', 'loc', 'where', '地點', '地点', '場所', '场所', '位置']);
const STYLE_KEYS = new Set(['color', 'font-size', 'background', 'padding', 'margin', 'display', 'border', 'width', 'text-align', 'font-weight', 'line-height']);
const IMAGE_KEYS = new Set(['角度', '人物数量', '人物數量', '构图', '構圖', '镜头', '鏡頭', 'prompt', 'negative', '画面', '畫面']);
const PLAN_KEYS = new Set(['字數', '字数', '結構', '结构', '語氣', '语气', '節奏', '节奏', '大綱', '大纲']);

/** 用規則猜這個標籤是什麼（只是給使用者參考）：status／style／image／thinking／theater／story／other。 */
function guessKind(name, keys, lines, kvLines, count, tokens) {
    const key = name.toLowerCase();
    const has = (set, n = 1) => keys.filter((k) => set.has(k.toLowerCase())).length >= n;
    if (THINKING.includes(key)) return 'thinking';
    if (THEATER.includes(key)) return 'theater';
    if (has(STYLE_KEYS, 2)) return 'style';
    if (/image|img|pic|draw/.test(key) || has(IMAGE_KEYS, 2)) return 'image';
    if (has(PLAN_KEYS)) return 'thinking';
    if (STATUS.includes(key) || (lines >= 2 && kvLines / lines >= 0.5) || has(WHEN_KEYS) || has(WHERE_KEYS)) return 'status';
    if (count && tokens / count >= 60) return 'story';
    return 'other';
}

/** 這個標籤目前怎麼處理：{ mode: 'read'|'skip'|'only', builtin: 'thinking'|'status'|'html'|null }。 */
export function tagMode(name, rules = getSettings().filter) {
    const key = name.toLowerCase();
    const has = (list) => parseTagList(list).some((x) => x.toLowerCase() === key);
    const isTheater = THEATER.includes(key) || parseTagList(rules.theaterTags).some((x) => x.toLowerCase() === key);
    const builtin = THINKING.includes(key) ? 'thinking' : STATUS.includes(key) ? 'status' : isTheater ? 'theater' : HTML_BLOCKS.includes(key) ? 'html' : null;
    if (has(rules.only)) return { mode: 'only', builtin };
    if (has(rules.ref)) return { mode: 'ref', builtin };
    if (has(rules.tags)) return { mode: 'skip', builtin };
    const on = builtin === 'theater' ? (rules.theater ?? 'keepsake') !== 'story' : rules[builtin];
    const builtinOn = builtin && on && !has(rules.keep);
    return { mode: builtinOn ? 'skip' : 'read', builtin };
}

/** 設定某個標籤要讀、不讀、只讀它，或只當參考。改的是 filter.tags／only／keep／ref 四個清單。 */
export function setTagMode(name, mode) {
    const rules = getSettings().filter;
    const key = name.toLowerCase();
    const without = (list) => parseTagList(list).filter((x) => x.toLowerCase() !== key);
    const tags = without(rules.tags);
    const only = without(rules.only);
    const keep = without(rules.keep);
    const ref = without(rules.ref);
    const { builtin } = tagMode(name, { ...rules, tags: '', only: '', keep: '', ref: '' });
    const builtinOn = Boolean(builtin && (builtin === 'theater' ? (rules.theater ?? 'keepsake') !== 'story' : rules[builtin]));
    if (mode === 'skip' && !builtinOn) tags.push(name);
    if (mode === 'read' && builtinOn) keep.push(name);
    if (mode === 'only') only.push(name);
    if (mode === 'ref') ref.push(name);
    rules.ref = ref.join(', ');
    rules.tags = tags.join(', ');
    rules.only = only.join(', ');
    rules.keep = keep.join(', ');
    saveSettings();
}
