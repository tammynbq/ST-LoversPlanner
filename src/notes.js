// 記事：人物、物件、約定、待辦。
//
// 記事清單不另外存一份，而是每次依序「重播」計算出來：
//   1. 每個 AI 樓層摘要時回報的變化（存在該層的 entry.ops，可以單獨標成「已撤銷」）
//   2. 使用者在大視窗手動做的修改（存在 chat_metadata.lovers_planner.manualOps，最後套用）
// 好處：swipe 換版本、刪除樓層、重做摘要、撤銷某條變化時，記事都會自動跟著正確。

import { ctx, MODULE } from './util.js';
import { t } from './i18n.js';
import { getChat, getEntry, isAiMessage, saveChatSoon } from './chat.js';

export const NOTE_TYPES = ['character', 'item', 'promise', 'todo'];

export const NOTE_FIELDS = {
    character: ['name', 'relation', 'status', 'likes', 'dislikes', 'note'],
    item: ['name', 'holder', 'status'],
    promise: ['content', 'with', 'when'],
    todo: ['content'],
};

const ID_PREFIX = { character: 'c', item: 'i', promise: 'p', todo: 't' };

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

function cleanData(type, data) {
    const out = {};
    if (!data || typeof data !== 'object') return out;
    for (const f of NOTE_FIELDS[type] ?? []) {
        const v = data[f];
        if (v === undefined || v === null) continue;
        const s = String(v).trim().slice(0, MAX_FIELD);
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

/** 對 state（Map）套用一個變化，回傳 true 表示有效。floor 是樓層索引，手動修改是 null。 */
function applyOp(state, op, floor) {
    const at = floor ?? null;
    switch (op.op) {
        case 'add': {
            if (!NOTE_TYPES.includes(op.type) || !op.id || state.has(op.id)) return false;
            const data = cleanData(op.type, op.data);
            if (!data[TITLE_FIELD[op.type]]) return false;
            state.set(op.id, {
                id: op.id, type: op.type, data, state: 'active', result: null,
                createdFloor: at, updatedFloor: null, closedFloor: null, manual: floor === null,
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
            state.set(op.id, { ...note, data: merged, updatedFloor: at ?? note.updatedFloor });
            return true;
        }
        case 'complete': {
            const note = state.get(op.id);
            if (!note) return false;
            const result = RESULTS.includes(op.result) ? op.result : 'done';
            if (note.type === 'character') return false; // 人物不會結束，只更新狀態
            if (note.type === 'promise' && result === 'broken') {
                state.set(op.id, { ...note, state: 'broken', result, closedFloor: at, closedManual: floor === null });
            } else {
                state.set(op.id, { ...note, state: 'done', result, closedFloor: at, closedManual: floor === null });
            }
            return true;
        }
        case 'reopen': {
            const note = state.get(op.id);
            if (!note || note.state === 'active') return false;
            state.set(op.id, { ...note, state: 'active', result: null, closedFloor: null, closedManual: false });
            return true;
        }
        case 'delete':
            return state.delete(op.id);
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
export function normalizeModelOps(rawOps, stateBefore, previousOps = []) {
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
            if (!NOTE_TYPES.includes(type)) continue;
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
            if (!note) continue;
            if (kind === 'update') {
                const data = cleanData(note.type, raw.data ?? {});
                // 模型常把名字一起寫進來只是為了指明是哪一條，沒改名就拿掉。
                if (sameKey(data[TITLE_FIELD[note.type]], noteTitle(note))) delete data[TITLE_FIELD[note.type]];
                op = { op: 'update', id: note.id, data };
            } else {
                op = { op: 'complete', id: note.id, result: String(raw.result ?? 'done').toLowerCase() };
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

/**
 * 依序重播，回傳 { notes: Map, perFloor: Map<index, [{ op, k, valid }]> }。
 * upTo：只重播到這個樓層之前（不含），而且不套用手動修改；用來替某一層組提示詞。
 */
export function replay({ upTo = Infinity } = {}) {
    const state = new Map();
    const perFloor = new Map();
    const chat = getChat();
    const end = Math.min(chat.length, upTo);
    for (let i = 0; i < end; i++) {
        if (!isAiMessage(chat[i])) continue;
        const ops = floorOps(i);
        if (!ops) continue;
        const list = [];
        ops.forEach((op, k) => {
            const valid = !op.undone && applyOp(state, op, i);
            list.push({ op, k, valid });
        });
        perFloor.set(i, list);
    }
    if (upTo === Infinity) {
        for (const op of manualOps()) applyOp(state, op, null);
    }
    return { notes: state, perFloor };
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
    if (!cache) cache = replay();
    return cache;
}

export function notesOfType(type, { states = ['active', 'broken'] } = {}) {
    return [...getNotes().notes.values()].filter((n) => n.type === type && states.includes(n.state));
}

export function closedNotes() {
    return [...getNotes().notes.values()].filter((n) => n.state === 'done');
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
    return pushManual({ op: 'add', id: newNoteId(type), type, data: clean });
}

export function updateNoteManual(id, data) {
    const note = getNotes().notes.get(id);
    if (!note) return false;
    // 清空的欄位也要寫進去（用空字串蓋掉）。
    const next = {};
    for (const f of NOTE_FIELDS[note.type]) {
        const v = String(data?.[f] ?? '').trim().slice(0, MAX_FIELD);
        if (v !== (note.data[f] ?? '')) next[f] = v;
    }
    if (next[TITLE_FIELD[note.type]] === '') return false; // 標題不能清空
    if (!Object.keys(next).length) return true;
    return pushManual({ op: 'update', id, data: next, raw: true });
}

export function completeNoteManual(id, result = 'done') {
    return pushManual({ op: 'complete', id, result });
}

export function reopenNoteManual(id) {
    return pushManual({ op: 'reopen', id });
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
export function describeOp(op, notes) {
    const note = notes.get(op.id);
    const type = op.type ?? note?.type;
    const title = op.op === 'add' ? (op.data?.[TITLE_FIELD[op.type]] ?? '') : noteTitle(note) || op.id;
    if (op.op === 'add') return `＋ ${typeLabel(type)}：${title}`;
    if (op.op === 'complete') {
        const sym = op.result === 'broken' ? '✗' : '✓';
        return `${sym} ${typeLabel(type)}：${title}（${resultLabel(op.result)}）`;
    }
    const fields = Object.entries(op.data ?? {})
        .map(([f, v]) => `${t(`field.${type}.${f}`)}→${v}`).join('，');
    return `✎ ${typeLabel(type)}：${title}${fields ? `（${fields}）` : ''}`;
}

/**
 * 記事清單文字：只列進行中（含被打破的約定），已完成的不列，省 token。
 * withIds：給摘要模型看時要有 id（它要引用）；注入給角色看時不需要。
 */
export function formatNotesForPrompt(notes, { withIds = true } = {}) {
    const lines = [];
    for (const n of notes.values()) {
        if (n.state === 'done') continue;
        const parts = NOTE_FIELDS[n.type]
            .filter((f) => n.data[f])
            .map((f) => `${t(`field.${n.type}.${f}`)}：${n.data[f]}`);
        const flag = n.state === 'broken' ? `｜${resultLabel('broken')}` : '';
        lines.push(`${withIds ? `[${n.id}] ` : ''}${typeLabel(n.type)}｜${parts.join('｜')}${flag}`);
    }
    return lines.length ? lines.join('\n') : t('prompt.noNotes');
}

export function initNotes() {
    const c = ctx();
    if (!c?.eventSource || !c.eventTypes) return;
    const ev = c.eventTypes;
    for (const name of ['CHAT_CHANGED', 'MESSAGE_DELETED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_UPDATED']) {
        if (ev[name]) c.eventSource.on(ev[name], invalidateNotes);
    }
}
