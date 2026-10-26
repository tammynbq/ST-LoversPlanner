// 記事：人物、物件、約定、待辦。
//
// 記事清單不另外存一份，而是每次依序「重播」計算出來：
//   1. 每個 AI 樓層摘要時回報的變化（存在該層的 entry.ops，可以單獨標成「已撤銷」）
//   2. 使用者在大視窗手動做的修改（存在 chat_metadata.lovers_planner.manualOps，最後套用）
// 好處：swipe 換版本、刪除樓層、重做摘要、撤銷某條變化時，記事都會自動跟著正確。

import { ctx, MODULE } from './util.js';
import { t } from './i18n.js';
import { CHARACTER_FIELDS, isTracked } from './settings.js';
import { getChat, getEntry, isAiMessage, saveChatSoon } from './chat.js';
import { normDate } from './calendar.js';
import { noteDates, storyToday } from './notedates.js';

export const NOTE_TYPES = ['character', 'item', 'promise', 'todo'];

export const NOTE_FIELDS = {
    // relUser／relChar：和 {{user}}／{{char}} 的關係（v0.12.8，使用者要求的欄位；舊的 relation 見 LEGACY_FIELDS）。
    character: CHARACTER_FIELDS,
    item: ['name', 'quantity', 'holder', 'status'],
    // when：原文說的時間（「明天早上」「明年秋天」）；due：換算成哪一天（YYYY-MM-DD，要開行事曆才有故事日期）。
    // title：15 字內的短標題（v0.13.7，使用者要求；畫面上當標題，content 變成詳情）。待辦也有「和誰」。
    promise: ['content', 'title', 'with', 'when', 'due'],
    todo: ['content', 'title', 'with', 'when', 'due'],
};

const ID_PREFIX = { character: 'c', item: 'i', promise: 'p', todo: 't' };

/** 舊版的欄位：資料還在就照樣顯示、可以編輯，但不再要求模型填。 */
export const LEGACY_FIELDS = { character: ['relation'] };

/** 這條記事要顯示／編輯的欄位：目前的欄位，加上它有資料的舊欄位（接在關係後面）。 */
export function fieldsOf(note) {
    const list = [...(NOTE_FIELDS[note.type] ?? [])];
    for (const f of LEGACY_FIELDS[note.type] ?? []) {
        if (note.data?.[f]) list.splice(Math.max(1, list.indexOf('relChar') + 1), 0, f);
    }
    return list;
}

/** 欄位名稱（「和 米米 的關係」要代入名字）。 */
export function fieldLabel(type, f) {
    const c = ctx();
    return t(`field.${type}.${f}`, { user: c?.name1 || '{{user}}', char: c?.name2 || '{{char}}' });
}

/** 日期欄位（YYYY-MM-DD，輸入框用 date）。 */
export const DATE_FIELDS = new Set(['due']);

/** 數字欄位（輸入框用 number、可以用 −／＋ 調整）。 */
export const NUMBER_FIELDS = new Set(['quantity']);

/** 每種記事拿來當標題、也用來判斷「是不是同一條」的欄位。 */
const TITLE_FIELD = { character: 'name', item: 'name', promise: 'content', todo: 'content' };

const RESULTS = ['done', 'kept', 'broken', 'used', 'lost', 'gone'];
const MAX_FIELD = 200;

export function newNoteId(type) {
    return `${ID_PREFIX[type] ?? 'n'}_${Math.random().toString(36).slice(2, 8)}`;
}

export function noteTitle(note) {
    return note?.data?.[TITLE_FIELD[note.type]] ?? '';
}

/** 用來認「是不是同一條」的欄位（人物、物件是名字；約定、待辦是內容）。 */
export function keyField(type) {
    return TITLE_FIELD[type];
}

/** 畫面上顯示的標題：約定／待辦有短標題就用短標題，沒有就用內容。 */
export function displayTitle(note) {
    return (note?.type === 'promise' || note?.type === 'todo') && note.data?.title ? note.data.title : noteTitle(note);
}

const MAX_TITLE = 15;
const MAX_DETAIL = 200;

function cleanData(type, data) {
    const out = {};
    if (!data || typeof data !== 'object') return out;
    for (const f of [...(NOTE_FIELDS[type] ?? []), ...(LEGACY_FIELDS[type] ?? [])]) {
        const v = data[f];
        if (v === undefined || v === null) continue;
        const s = DATE_FIELDS.has(f) ? normDate(v) : String(v).trim().slice(0, f === 'title' ? MAX_TITLE + 5 : MAX_FIELD);
        if (s) out[f] = s;
    }
    return out;
}

function sameKey(a, b) {
    return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

/** 在目前的記事裡找同類、同標題的那條（人物不分狀態；其他只找進行中的）。 */
function findByTitle(state, type, title) {
    if (!title) return null;
    for (const n of state.values()) {
        if (n.type !== type || !sameKey(noteTitle(n), title)) continue;
        if (type === 'character' || n.state !== 'done') return n;
    }
    return null;
}

// ===== 套用一個變化 =====

/** 兩條人物／物件是不是同一個（同類、名字一樣或互相包含；別稱也算）。 */
function sameThing(a, b) {
    if (a.type !== b.type || (a.type !== 'character' && a.type !== 'item')) return false;
    const names = (n) => [noteTitle(n), ...String(n.data.alias ?? '').split(/[、,，/／;；]+/)]
        .map((x) => String(x ?? '').trim().toLowerCase()).filter(Boolean);
    const A = names(a);
    const B = names(b);
    return A.some((x) => B.some((y) => x === y || (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x)))));
}

/**
 * 刪掉一條人物／物件時，如果還有同一個人（同名的另一條，通常是合併重複記事留下的那條），
 * 把被刪那條比較新的欄位併過去（v0.13.11 修：模型一直更新已經被合併掉的那條，更新全不見了）。
 * 每個欄位比「最後一次改的時間」（fieldAt）。
 */
function absorb(state, gone) {
    const keep = [...state.values()].find((n) => sameThing(n, gone));
    if (!keep) return;
    const data = { ...keep.data };
    const fieldAt = { ...(keep.fieldAt ?? {}) };
    for (const [f, v] of Object.entries(gone.data ?? {})) {
        if (f === TITLE_FIELD[gone.type] || !v) continue;
        const theirs = gone.fieldAt?.[f] ?? 0;
        if (!data[f] || theirs > (fieldAt[f] ?? 0)) {
            data[f] = v;
            fieldAt[f] = theirs;
        }
    }
    state.set(keep.id, { ...keep, data, fieldAt });
}

/** 每個欄位最後一次改的時間（樓層的用摘要的時間，手動的用修改的時間）。 */
function stampFields(prev, data, stamp) {
    const out = { ...(prev ?? {}) };
    for (const f of Object.keys(data)) out[f] = stamp;
    return out;
}

/** 對 state（Map）套用一個變化，回傳 true 表示有效。floor 是樓層索引，手動修改是 null。stamp：時間（比較新舊用）。 */
function applyOp(state, op, floor, stamp = 0) {
    const at = floor ?? null;
    switch (op.op) {
        case 'add': {
            if (!NOTE_TYPES.includes(op.type) || !op.id || state.has(op.id)) return false;
            const data = cleanData(op.type, op.data);
            if (!data[TITLE_FIELD[op.type]]) return false;
            state.set(op.id, {
                id: op.id, type: op.type, data, fieldAt: stampFields(null, data, stamp), state: 'active', result: null,
                createdFloor: at, updatedFloor: null, closedFloor: null, manual: floor === null,
                // 手動新增的：新增當時的故事日期（樓層的看那一層的 date）。
                ...(op.made ? { made: op.made } : {}),
            });
            return true;
        }
        case 'update': {
            const note = state.get(op.id);
            if (!note) return false;
            // 手動修改（raw）可以把欄位清空；模型的空值一律忽略。
            const data = op.raw ? { ...op.data } : cleanData(note.type, op.data);
            if (!Object.keys(data).length) return false;
            const merged = { ...note.data, ...data };
            for (const f of Object.keys(merged)) if (merged[f] === '') delete merged[f];
            state.set(op.id, { ...note, data: merged, fieldAt: stampFields(note.fieldAt, data, stamp), updatedFloor: at ?? note.updatedFloor });
            return true;
        }
        case 'complete': {
            const note = state.get(op.id);
            if (!note) return false;
            const result = RESULTS.includes(op.result) ? op.result : 'done';
            if (note.type === 'character') return false; // 人物不會結束，只更新狀態
            // detail：怎麼完成的（模型寫的，50～100 字）；closedDate：手動完成時的故事日期。
            const extra = {
                closedDetail: op.detail ? String(op.detail).trim().slice(0, MAX_DETAIL) : null,
                closedDate: op.closedDate ?? null,
            };
            if (note.type === 'promise' && result === 'broken') {
                state.set(op.id, { ...note, ...extra, state: 'broken', result, closedFloor: at, closedManual: floor === null });
            } else {
                state.set(op.id, { ...note, ...extra, state: 'done', result, closedFloor: at, closedManual: floor === null });
            }
            return true;
        }
        case 'reopen': {
            const note = state.get(op.id);
            if (!note || note.state === 'active') return false;
            state.set(op.id, { ...note, state: 'active', result: null, closedFloor: null, closedManual: false, closedDetail: null, closedDate: null });
            return true;
        }
        case 'role': {
            // 指定這個人物是 {{user}} 或 {{char}}（一個角色只會有一條；null＝取消）。只有手動修改會有。
            const note = state.get(op.id);
            if (!note || note.type !== 'character') return false;
            const role = op.role === 'user' || op.role === 'char' ? op.role : null;
            if (role) for (const n of state.values()) if (n.role === role && n.id !== op.id) state.set(n.id, { ...n, role: null });
            state.set(op.id, { ...note, role });
            return true;
        }
        case 'pin': {
            // 釘選：不管有沒有被提到，每次都送給角色（只有手動修改會有）。
            const note = state.get(op.id);
            if (!note) return false;
            state.set(op.id, { ...note, pinned: Boolean(op.on) });
            return true;
        }
        case 'delete': {
            const gone = state.get(op.id);
            if (!gone) return false;
            state.delete(op.id);
            absorb(state, gone);
            return true;
        }
        default:
            return false;
    }
}

// ===== 把模型回報的變化整理成標準格式 =====

/**
 * 模型的 ops 可能格式不一、id 寫錯、或重複新增已經有的。
 * 對照「這一層之前」的記事整理一次，新增的配上 id，結果存進該層。
 * previousOps：重做這一層時，舊的那份變化。重新新增同一條時沿用舊 id，
 * 之後樓層對它的更新／完成才不會失效。
 */
export function normalizeModelOps(rawOps, stateBefore, previousOps = [], { types = NOTE_TYPES } = {}) {
    const state = new Map(stateBefore);
    const out = [];
    const oldIds = new Map();
    for (const op of Array.isArray(previousOps) ? previousOps : []) {
        if (op?.op === 'add') oldIds.set(`${op.type}\u0000${String(op.data?.[TITLE_FIELD[op.type]] ?? '').trim().toLowerCase()}`, op.id);
    }
    for (const raw of Array.isArray(rawOps) ? rawOps : []) {
        if (!raw || typeof raw !== 'object') continue;
        const kind = String(raw.op ?? '').toLowerCase();
        let op = null;
        if (kind === 'add') {
            const type = String(raw.type ?? '').toLowerCase();
            // 沒勾選要記錄的類型不收。
            if (!types.includes(type)) continue;
            const data = cleanData(type, raw.data ?? raw);
            const existing = findByTitle(state, type, data[TITLE_FIELD[type]]);
            if (existing) {
                // 已經有同一條：改成更新，不重複新增。
                delete data[TITLE_FIELD[type]];
                op = Object.keys(data).length ? { op: 'update', id: existing.id, data } : null;
            } else {
                const reuse = oldIds.get(`${type}\u0000${String(data[TITLE_FIELD[type]] ?? '').trim().toLowerCase()}`);
                op = { op: 'add', id: reuse && !state.has(reuse) ? reuse : newNoteId(type), type, data };
            }
        } else if (kind === 'update' || kind === 'complete') {
            let note = state.get(String(raw.id ?? '').replace(/^\[|\]$/g, ''));
            if (!note) {
                // 模型有時只寫名字不寫 id：用標題找找看。
                const title = raw.data?.name ?? raw.data?.content ?? raw.name ?? raw.content;
                for (const type of NOTE_TYPES) {
                    note = findByTitle(state, type, title);
                    if (note) break;
                }
            }
            if (!note || !types.includes(note.type)) continue;
            if (kind === 'update') {
                const data = cleanData(note.type, raw.data ?? {});
                // 模型常把名字一起寫進來只是為了指明是哪一條，沒改名就拿掉。
                if (sameKey(data[TITLE_FIELD[note.type]], noteTitle(note))) delete data[TITLE_FIELD[note.type]];
                op = { op: 'update', id: note.id, data };
            } else {
                const detail = String(raw.detail ?? raw.note ?? raw.how ?? '').trim();
                op = { op: 'complete', id: note.id, result: String(raw.result ?? 'done').toLowerCase(), ...(detail ? { detail: detail.slice(0, MAX_DETAIL) } : {}) };
            }
        }
        if (op && applyOp(state, op, 0)) out.push(op);
    }
    return out;
}

// ===== 重播：算出目前的記事 =====

function chatRecord(create) {
    const meta = ctx()?.chatMetadata;
    if (!meta) return null;
    if (!meta[MODULE] && create) meta[MODULE] = {};
    return meta[MODULE] ?? null;
}

function manualOps() {
    const ops = chatRecord(false)?.manualOps;
    return Array.isArray(ops) ? ops : [];
}

/** 會影響記事的樓層：已摘要和過期的（跳過、失敗的不算）。 */
function floorOps(index) {
    const e = getEntry(index);
    if (!e || e.status !== 'ok' || !Array.isArray(e.ops)) return null;
    return e.ops;
}

// 基底記事（第 7 步，carry.js 提供）：從別的聊天帶來的、或和同角色其他聊天即時共用的記事。
// 重播時先放進基底，再套用這個聊天自己的變化。基底記事有 updatedAt：
// 比它舊的變化代表「已經算進去了或被更新的蓋過了」，跳過（以最新的修改為準）。
let baseProvider = null;
let syncHook = null;

/** fn() → [{ id, type, data, state, result, pinned, updatedAt, source? }] */
export function setNotesBase(fn) {
    baseProvider = fn;
}

/** fn(result)：完整重播後呼叫（carry.js 用來把共用的記事寫回去）。 */
export function setNotesSync(fn) {
    syncHook = fn;
}

/**
 * 依序重播，回傳 { notes: Map, perFloor: Map<index, [{ op, k, valid }]>, touched: Map<id, 時間> }。
 * upTo：只重播到這個樓層之前（不含），而且不套用手動修改；用來替某一層組提示詞。
 * touched：每條記事最後一次被這個聊天改動的時間（共用時用來判斷誰比較新）。
 */
export function replay({ upTo = Infinity } = {}) {
    const state = new Map();
    const perFloor = new Map();
    const touched = new Map();
    const baseAt = new Map();
    let base = [];
    try { base = baseProvider?.() ?? []; } catch (e) { console.error(e); }
    for (const n of base) {
        if (!n?.id || !NOTE_TYPES.includes(n.type)) continue;
        state.set(n.id, {
            id: n.id, type: n.type, data: { ...n.data }, state: n.state ?? 'active', result: n.result ?? null,
            pinned: Boolean(n.pinned), role: n.role ?? null, createdFloor: null, updatedFloor: null, closedFloor: null,
            manual: false, carried: true, source: n.source ?? null,
        });
        baseAt.set(n.id, Number(n.updatedAt) || 0);
    }
    // 每條記事最後知道的類型和名字（刪掉之後，畫面上那一層的變化還認得出是哪一條）。
    const known = new Map();
    // 回傳 true 表示有效（或已經算在基底裡）。
    const apply = (op, floor, at) => {
        if (baseAt.has(op.id) && (Number(at) || 0) <= baseAt.get(op.id)) return true;
        const ok = applyOp(state, op, floor, Number(at) || 0);
        if (ok && op.id) touched.set(op.id, Math.max(touched.get(op.id) ?? 0, Number(at) || 0));
        const n = state.get(op.id);
        if (n) known.set(op.id, { type: n.type, title: displayTitle(n) });
        return ok;
    };
    const chat = getChat();
    const end = Math.min(chat.length, upTo);
    for (let i = 0; i < end; i++) {
        if (!isAiMessage(chat[i])) continue;
        const ops = floorOps(i);
        if (!ops) continue;
        const at = getEntry(i)?.at ?? 0;
        const list = [];
        ops.forEach((op, k) => {
            const valid = !op.undone && apply(op, i, at);
            list.push({ op, k, valid });
        });
        perFloor.set(i, list);
    }
    if (upTo === Infinity) {
        for (const op of manualOps()) apply(op, null, op.at);
    } else {
        // 替某一層組提示詞時：手動刪掉（含合併掉）的記事也拿掉，模型才不會一直更新它（v0.13.11 修）。
        for (const op of manualOps()) if (op.op === 'delete') apply(op, null, op.at);
    }
    return { notes: state, perFloor, touched, known };
}

let cache = null;
const listeners = new Set();

export function invalidateNotes() {
    cache = null;
}

/** 記事被手動改動（新增、編輯、完成、撤銷某層的變化…）時通知畫面重畫。 */
export function onNotesChange(fn) {
    listeners.add(fn);
}

function emitNotesChange() {
    invalidateNotes();
    for (const fn of listeners) {
        try { fn(); } catch (e) { console.error(e); }
    }
}

export function getNotes() {
    if (!cache) {
        cache = replay();
        try { syncHook?.(cache); } catch (e) { console.error(e); }
    }
    return cache;
}

/** 已完成的記事只算有勾選的類型。 */
export function notesOfType(type, { states = ['active', 'broken'] } = {}) {
    return [...getNotes().notes.values()].filter((n) => n.type === type && states.includes(n.state));
}

export function closedNotes() {
    return [...getNotes().notes.values()].filter((n) => n.state === 'done' && isTracked(n.type));
}

/** 一個變化屬於哪一類記事（新增的看 op.type，其他看它指向的記事；記事刪掉了就看以前知道的）。 */
export function opType(op, notes = getNotes().notes) {
    return op.type ?? notes.get(op.id)?.type ?? getNotes().known?.get(op.id)?.type ?? null;
}

/** 手動調整物件數量（−／＋）。 */
export function changeQuantity(id, delta) {
    const note = getNotes().notes.get(id);
    if (!note || note.type !== 'item') return false;
    const now = Number.parseInt(note.data.quantity, 10);
    const next = Math.max(0, (Number.isFinite(now) ? now : (delta > 0 ? 0 : 1)) + delta);
    return pushManual({ op: 'update', id, data: { quantity: String(next) }, raw: true });
}

// ===== 手動修改 =====

function pushManual(op) {
    const rec = chatRecord(true);
    if (!rec) return false;
    rec.manualOps = [...manualOps(), { ...op, at: Date.now() }];
    emitNotesChange();
    const c = ctx();
    try {
        if (typeof c?.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
        else c?.saveMetadata?.();
    } catch (e) { /* 忽略 */ }
    return true;
}

export function addNoteManual(type, data) {
    const clean = cleanData(type, data);
    if (!NOTE_TYPES.includes(type) || !clean[TITLE_FIELD[type]]) return false;
    const made = type === 'promise' || type === 'todo' ? storyToday() : null;
    return pushManual({ op: 'add', id: newNoteId(type), type, data: clean, ...(made ? { made } : {}) });
}

export function updateNoteManual(id, data) {
    const note = getNotes().notes.get(id);
    if (!note) return false;
    // 清空的欄位也要寫進去（用空字串蓋掉）。
    const next = {};
    for (const f of fieldsOf(note)) {
        const raw = String(data?.[f] ?? '').trim();
        const v = DATE_FIELDS.has(f) ? normDate(raw) : raw.slice(0, MAX_FIELD);
        if (v !== (note.data[f] ?? '')) next[f] = v;
    }
    if (next[TITLE_FIELD[note.type]] === '') return false; // 標題不能清空
    if (!Object.keys(next).length) return true;
    return pushManual({ op: 'update', id, data: next, raw: true });
}

export function completeNoteManual(id, result = 'done') {
    const date = storyToday();
    return pushManual({ op: 'complete', id, result, ...(date ? { closedDate: date } : {}) });
}

/** 還沒有短標題的約定／待辦（含已完成的）。 */
export function notesWithoutTitle() {
    return [...getNotes().notes.values()].filter((n) => (n.type === 'promise' || n.type === 'todo') && !n.data.title && isTracked(n.type));
}

/** 一次補上很多條的短標題：titles = { id: '標題' }。回傳補了幾條。 */
export function setTitlesManual(titles) {
    const notes = getNotes().notes;
    const ops = [];
    const at = Date.now();
    for (const [id, raw] of Object.entries(titles ?? {})) {
        const title = String(raw ?? '').trim().slice(0, MAX_TITLE + 5);
        const n = notes.get(id);
        if (!title || !n || n.data.title) continue;
        ops.push({ op: 'update', id, data: { title }, raw: true, at });
    }
    if (!ops.length) return 0;
    const rec = chatRecord(true);
    rec.manualOps = [...manualOps(), ...ops];
    emitNotesChange();
    const c = ctx();
    try {
        if (typeof c?.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
        else c?.saveMetadata?.();
    } catch (e) { /* 忽略 */ }
    return ops.length;
}

export function reopenNoteManual(id) {
    return pushManual({ op: 'reopen', id });
}

export function setRoleManual(id, role) {
    return pushManual({ op: 'role', id, role: role ?? null });
}

/**
 * 哪條人物是 {{user}}、哪條是 {{char}}：Map<id, 'user'|'char'>。
 * 手動指定的優先；沒指定的，名字或別稱和酒館裡的名字一樣（或互相包含）就自動認。
 */
export function leadRoles(notes = getNotes().notes) {
    const out = new Map();
    const taken = new Set();
    for (const n of notes.values()) {
        if (n.type === 'character' && n.role && !taken.has(n.role)) {
            out.set(n.id, n.role);
            taken.add(n.role);
        }
    }
    const c = ctx();
    const names = { user: c?.name1, char: c?.name2 };
    const norm = (x) => String(x ?? '').trim().toLowerCase();
    for (const role of ['user', 'char']) {
        const want = norm(names[role]);
        if (taken.has(role) || !want) continue;
        for (const n of notes.values()) {
            if (n.type !== 'character' || out.has(n.id)) continue;
            const mine = [n.data.name, ...String(n.data.alias ?? '').split(/[、,，/／;；\s]+/)].map(norm).filter(Boolean);
            if (mine.some((x) => x === want || (want.length >= 2 && x.includes(want)) || (x.length >= 2 && want.includes(x)))) {
                out.set(n.id, role);
                break;
            }
        }
    }
    return out;
}

export function pinNoteManual(id, on) {
    return pushManual({ op: 'pin', id, on: Boolean(on) });
}

export function deleteNoteManual(id) {
    return pushManual({ op: 'delete', id });
}

/** 撤銷／恢復某一層的某個變化。 */
export function setFloorOpUndone(index, k, undone) {
    const e = getEntry(index);
    if (!e || !Array.isArray(e.ops) || !e.ops[k]) return false;
    e.ops[k] = { ...e.ops[k], undone: Boolean(undone) };
    // 同步到目前的 swipe（和 setEntry 一樣的理由）。
    const m = getChat()[index];
    const info = Array.isArray(m?.swipe_info) ? m.swipe_info[m.swipe_id] : null;
    if (info?.extra?.[MODULE]) info.extra[MODULE] = structuredClone(e);
    saveChatSoon();
    emitNotesChange();
    return true;
}

// ===== 顯示用文字 =====

export function typeLabel(type) {
    return t(`type.${type}`);
}

export function resultLabel(result) {
    return t(`result.${result ?? 'done'}`);
}

/** 把一個變化寫成一行給人看的文字。noteAfter 是套用後的記事（用來拿標題）。 */
export function describeOp(op, notes, known = getNotes().known) {
    const note = notes.get(op.id);
    const info = note ? null : known?.get(op.id);
    const type = op.type ?? note?.type ?? info?.type;
    // 指向的記事已經刪掉（或合併掉）：用以前知道的名字，並註明。
    const gone = !note ? ` ${t('changes.deleted')}` : '';
    const title = (op.op === 'add' ? (op.data?.title || op.data?.[TITLE_FIELD[op.type]] || '') : (note ? displayTitle(note) : info?.title) || op.id) + gone;
    if (op.op === 'add') return `＋ ${typeLabel(type)}：${title}`;
    if (op.op === 'complete') {
        const sym = op.result === 'broken' ? '✗' : '✓';
        return `${sym} ${typeLabel(type)}：${title}（${resultLabel(op.result)}）`;
    }
    const fields = Object.entries(op.data ?? {})
        .map(([f, v]) => `${fieldLabel(type, f)}→${v}`).join('，');
    return `✎ ${typeLabel(type)}：${title}${fields ? `（${fields}）` : ''}`;
}

/**
 * 記事清單文字：只列進行中（含被打破的約定），已完成的不列，省 token。
 * withIds：給摘要模型看時要有 id（它要引用）；注入給角色看時不需要。
 */
export function formatNotesForPrompt(notes, { withIds = true, types = null, only = null, emptyText = t('prompt.noNotes') } = {}) {
    const lines = [];
    // 主角是誰一律看最新的（摘要某一層時的清單不含手動修改，但手動指定的主角要算）。
    const roles = leadRoles(getNotes().notes);
    for (const n of notes.values()) {
        if (n.state === 'done' || !isTracked(n.type)) continue;
        if (types && !types.includes(n.type)) continue;
        // only：只列這些 id（「只送相關的記事」挑出來的）。
        if (only && !only.has(n.id)) continue;
        const flag = n.state === 'broken' ? `｜${resultLabel('broken')}` : '';
        // 主角本人標出來：摘要模型才知道更新 {{user}}／{{char}} 要用哪一條。
        const role = roles.get(n.id);
        const tag = role ? t('notes.role.tag', { name: (role === 'user' ? ctx()?.name1 : ctx()?.name2) || `{{${role}}}` }) : '';
        lines.push(`${withIds ? `[${n.id}] ` : ''}${tag}${noteLine(n)}${flag}`);
    }
    return lines.length ? lines.join('\n') : emptyText;
}

/** 一條記事的內容（不含 id、狀態）。向量也用這段文字來算。 */
export function noteLine(n) {
    const parts = fieldsOf(n)
        .filter((f) => n.data[f])
        .map((f) => `${fieldLabel(n.type, f)}：${n.data[f]}`);
    // 約定／待辦：哪天約定的、推算出來的預定日期（模型沒寫 due 時）。
    const { made, due, guessed } = noteDates(n);
    if (guessed) parts.push(`${fieldLabel(n.type, 'due')}：${due}`);
    if (made) parts.push(`${t(`notes.made.${n.type}`)}：${made}`);
    return `${typeLabel(n.type)}｜${parts.join('｜')}`;
}

export function initNotes() {
    const c = ctx();
    if (!c?.eventSource || !c.eventTypes) return;
    const ev = c.eventTypes;
    for (const name of ['CHAT_CHANGED', 'MESSAGE_DELETED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_UPDATED']) {
        if (ev[name]) c.eventSource.on(ev[name], invalidateNotes);
    }
}
