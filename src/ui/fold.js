// 大視窗的摺疊狀態（記住上次展開的，每個聊天各自記）和搜尋小工具。
// 存在瀏覽器的 localStorage：只是畫面偏好，丟了也沒關係。

import { escapeHtml as esc } from '../util.js';
import { chatKey } from '../chat.js';

const STORE = 'lovers_planner_fold';
const MAX_KEYS = 500;

// expanded：預設收起、被展開的（卡片、樓層、章、卷）；closed：預設展開、被收起的（區塊、未壓縮群組）。
let state = { chat: undefined, expanded: new Set(), closed: new Set() };

function storageKey() {
    return `${STORE}:${state.chat ?? ''}`;
}

function load() {
    const key = chatKey();
    if (state.chat === key) return;
    state = { chat: key, expanded: new Set(), closed: new Set() };
    try {
        const raw = globalThis.localStorage?.getItem(storageKey());
        if (raw) {
            const saved = JSON.parse(raw);
            state.expanded = new Set(saved.e ?? []);
            state.closed = new Set(saved.c ?? []);
        }
    } catch (e) { /* 被封鎖或壞掉就從頭開始 */ }
}

function save() {
    try {
        globalThis.localStorage?.setItem(storageKey(), JSON.stringify({
            e: [...state.expanded].slice(-MAX_KEYS),
            c: [...state.closed].slice(-MAX_KEYS),
        }));
    } catch (e) { /* 存不了就算了 */ }
}

/** 預設收起的東西（卡片、樓層、章、卷）：有沒有被展開。 */
export function isExpanded(key) {
    load();
    return state.expanded.has(key);
}

/** 預設展開的東西（分頁裡的區塊、未壓縮群組）：有沒有開著。 */
export function isSectionOpen(key) {
    load();
    return !state.closed.has(key);
}

export function toggleExpanded(key) {
    load();
    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);
    save();
}

export function setExpanded(key, open) {
    load();
    if (open) state.expanded.add(key);
    else state.expanded.delete(key);
    save();
}

export function toggleSection(key) {
    load();
    if (state.closed.has(key)) state.closed.delete(key);
    else state.closed.add(key);
    save();
}

export function setSectionOpen(key, open) {
    load();
    if (open) state.closed.delete(key);
    else state.closed.add(key);
    save();
}

// ===== 搜尋 =====

/** 搜尋字串拆成關鍵字（空白分開，全部都要出現）。 */
export function terms(query) {
    return String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

export function matches(text, query) {
    const list = terms(query);
    if (!list.length) return true;
    const s = String(text ?? '').toLowerCase();
    return list.every((x) => s.includes(x));
}

/** 跳脫 HTML，並把符合的關鍵字標亮。 */
export function hl(text, query) {
    const s = esc(text);
    const list = terms(query);
    if (!list.length) return s;
    const pattern = list.map((x) => esc(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    return s.replace(new RegExp(`(${pattern})`, 'gi'), '<mark class="lp-mark">$1</mark>');
}
