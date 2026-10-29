// 第 7 步：帶走／即時共用／前情提要。
//
// 每個聊天的摘要和記事會留一份「快照」在插件設定裡（以角色卡為單位）：
//   extensionSettings.lovers_planner.characters[頭像].chats[聊天 id] = { at, name, floors, lines, notes }
// 這樣開新聊天、或從其他聊天匯入時，不用讀別的聊天檔就拿得到資料。
//
// 摘要：
//   複製帶走 → 變成新聊天的「前情提要」（chat_metadata.lovers_planner.recap），可以選濃縮或原樣。
//   即時共用 → 新聊天記住來源（summaryLink），每次讀來源聊天最新的快照，唯讀（只有摘要所屬的聊天能改）。
// 記事（人物／物件／約定／待辦，每類各自選）：
//   複製帶走 → 存成這個聊天的基底（chat_metadata.lovers_planner.base），之後各自獨立。
//   即時共用 → 同角色共用一份（characters[頭像].shared.notes），兩邊都能改，以最新的修改為準。
// 回憶錄（v0.13.20，使用者要求）：
//   複製帶走 → 存在這個聊天的 base.memories（之後各自獨立，可以改、刪）。
//   即時共用 → 新聊天記住來源（memoriesLink），每次讀來源聊天最新快照裡的回憶，唯讀。
//   每條回憶有 origin（最早是哪個聊天的哪一條），一路帶下去也認得出是同一條，不會重複。
// 這個版本之前就有的舊聊天，第一次打開時記憶範圍設成「獨立」，不會突然和別的聊天混在一起。

import { ctx, LOG_PREFIX, MODULE, toast, toastActions } from './util.js';
import { getSettings, isTracked, saveSettings } from './settings.js';
import { t } from './i18n.js';
import { getTemplate } from './prompts.js';
import { generateText } from './llm.js';
import { errorText } from './errors.js';
import { aiIndices, chatKey, getChat, getEntry, isUserMessage } from './chat.js';
import { getNotes, invalidateNotes, NOTE_TYPES, noteTitle, onNotesChange, setNotesBase, setNotesSync } from './notes.js';
import { sceneLine } from './lines.js';
import { listMemories, memoryOrigin, onMemoriesChange, setMemoriesBase } from './memories.js';
import { addCarriedEvents, calendarOn, carryItems, onCalendarChange, removeCarriedFrom } from './calendar.js';
import { digestLabel, structure } from './compress.js';
import { isActive, onSummaryChange } from './summarize.js';
import {
    characterKey, getCharacterScope, getChatScope, SCOPE_KINDS, setCharacterScope, setChatScope,
} from './scope.js';

export const KIND_OF_TYPE = { character: 'characters', item: 'items', promise: 'promises', todo: 'todos' };
const TYPE_OF_KIND = Object.fromEntries(Object.entries(KIND_OF_TYPE).map(([a, b]) => [b, a]));
/** 每個角色最多留幾個聊天的快照。 */
const MAX_SNAPSHOTS = 30;
const SNAPSHOT_DELAY_MS = 1500;

// ===== 存取 =====

function chatRecord(create) {
    const meta = ctx()?.chatMetadata;
    if (!meta) return null;
    if (!meta[MODULE] && create) meta[MODULE] = {};
    return meta[MODULE] ?? null;
}

function saveMeta() {
    const c = ctx();
    try {
        if (typeof c?.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
        else c?.saveMetadata?.();
    } catch (e) { /* 忽略 */ }
}

function characterRecord(create) {
    const key = characterKey();
    if (!key) return null;
    const all = getSettings().characters;
    if (!all[key] && create) all[key] = {};
    return all[key] ?? null;
}

function sharedStore(create) {
    const rec = characterRecord(create);
    if (!rec) return null;
    if (!rec.shared && create) rec.shared = { notes: {} };
    return rec.shared ?? null;
}

/** 這個聊天實際用的範圍：'none' | 'copy' | 'share' | 'own'（本視窗設成獨立）。 */
export function effectiveScope(kind) {
    const chat = getChatScope()[kind];
    if (chat === 'own' || chat === 'share') return chat;
    return getCharacterScope()[kind];
}

function isShared(type) {
    return effectiveScope(KIND_OF_TYPE[type]) === 'share';
}

// ===== 記事的基底和共用 =====

function plainNote(n, updatedAt) {
    return {
        id: n.id, type: n.type, data: { ...n.data }, state: n.state, result: n.result ?? null,
        pinned: Boolean(n.pinned), ...(n.role ? { role: n.role } : {}), ...(n.cardFields?.length ? { cardFields: [...n.cardFields] } : {}), updatedAt: Number(updatedAt) || 0, ...(n.source ? { source: n.source } : {}),
    };
}

function baseNotes() {
    if (!characterKey()) return [];
    const rec = chatRecord(false);
    const own = rec?.base?.notes ?? {};
    const shared = sharedStore(false)?.notes ?? {};
    const out = new Map();
    for (const n of Object.values(own)) if (!isShared(n.type)) out.set(n.id, n);
    for (const n of Object.values(shared)) {
        if (!isShared(n.type)) continue;
        if (n.deleted) out.delete(n.id);
        else out.set(n.id, n);
    }
    // 從複製改成共用時，原本帶來的記事也一起併進共用的那份。
    for (const n of Object.values(own)) if (isShared(n.type) && !shared[n.id]) out.set(n.id, n);
    return [...out.values()];
}

function sameNote(a, b) {
    return a && b && a.state === b.state && (a.result ?? null) === (b.result ?? null)
        && Boolean(a.pinned) === Boolean(b.pinned) && (a.role ?? null) === (b.role ?? null) && JSON.stringify(a.data) === JSON.stringify(b.data);
}

/** 完整重播後：共用的類型，把這個聊天看到的結果寫回共用的那份（以最新的修改為準）。 */
function syncShared(result) {
    if (!characterKey() || !isActive()) return;
    const types = NOTE_TYPES.filter(isShared);
    if (!types.length) return;
    const store = sharedStore(true);
    let changed = false;
    for (const n of result.notes.values()) {
        if (!types.includes(n.type)) continue;
        const prev = store.notes[n.id];
        const at = result.touched.get(n.id) ?? prev?.updatedAt ?? 0;
        if (prev && !prev.deleted && sameNote(prev, n)) continue;
        if (prev && at < (prev.updatedAt ?? 0)) continue;
        store.notes[n.id] = plainNote(n, at);
        changed = true;
    }
    // 在這個聊天被刪掉的。
    for (const [id, at] of result.touched) {
        const prev = store.notes[id];
        if (!prev || prev.deleted || result.notes.has(id) || !types.includes(prev.type)) continue;
        if (at >= (prev.updatedAt ?? 0)) {
            store.notes[id] = { id, type: prev.type, deleted: true, updatedAt: at };
            changed = true;
        }
    }
    if (changed) saveSettings();
}

// ===== 回憶錄 =====

function plainMemory(m, from) {
    return {
        origin: memoryOrigin(m), title: m.title ?? '', content: m.content ?? '', date: m.date ?? '', time: m.time ?? '',
        ...(m.theater ? { theater: true } : {}), from: m.from ?? from,
    };
}

/** 帶來的回憶：複製帶走的（base.memories）＋即時共用來源最新的。 */
function baseMemories() {
    if (!characterKey()) return [];
    const rec = chatRecord(false);
    const out = [];
    if (effectiveScope('memories') === 'share' && rec?.memoriesLink?.source) {
        const snap = getSnapshot(rec.memoriesLink.source);
        for (const m of snap?.memories ?? []) out.push({ ...m, linked: true });
    }
    for (const m of Object.values(rec?.base?.memories ?? {})) out.push(m);
    return out;
}

// ===== 摘要的文字 =====

/** 這個聊天自己的摘要，一行一段：卷 → 章 → 沒被章涵蓋的單層摘要。 */
function ownSummaryLines() {
    const st = structure();
    const rows = [];
    for (const v of st.volumes) {
        if (v.state !== 'ok' || st.coveredVolumes.has(v.data.id)) continue;
        const first = Math.min(...v.chapters.flatMap((c) => c.indices).filter((i) => i >= 0));
        rows.push({ at: first, line: sceneLine({ ...v.data, characters: [] }, digestLabel(v.level, v.number)) });
    }
    for (const c of st.chapters) {
        if (c.state !== 'ok' || st.coveredChapters.has(c.data.id)) continue;
        rows.push({ at: Math.min(...c.indices.filter((i) => i >= 0)), line: sceneLine({ ...c.data, characters: [] }, t('chapter.label', { n: c.number })) });
    }
    for (const i of aiIndices()) {
        if (st.covered.has(i)) continue;
        const e = getEntry(i);
        if (e?.status === 'ok' && e.summary) rows.push({ at: i, line: sceneLine(e) });
    }
    return rows.sort((a, b) => a.at - b.at).map((r) => r.line);
}

// ===== 快照 =====

function snapshots(create = false) {
    const rec = characterRecord(create);
    if (!rec) return null;
    if (!rec.chats && create) rec.chats = {};
    return rec.chats ?? null;
}

/** 刪掉這個聊天的快照（資料管理 › 刪除本窗口的內容）。 */
export function removeSnapshot() {
    const all = snapshots(false);
    const id = chatKey();
    if (!all || !id || !(id in all)) return false;
    delete all[id];
    saveSettings();
    return true;
}

/** 同角色其他聊天的快照，新的在前。 */
export function otherSnapshots() {
    const list = snapshots(false) ?? {};
    const me = chatKey();
    return Object.entries(list)
        .filter(([id]) => id !== me)
        .map(([id, s]) => ({ id, ...s }))
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

export function getSnapshot(id) {
    const s = snapshots(false)?.[id];
    return s ? { id, ...s } : null;
}

/** 把目前聊天的摘要和記事記一份快照（有摘要或記事才記）。 */
export function writeSnapshot() {
    const id = chatKey();
    if (!id || !isActive() || !characterKey()) return;
    const rec = chatRecord(false);
    const lines = [];
    if (rec?.recap?.text) lines.push(`${t('recap.label')}${rec.recap.text}`);
    lines.push(...ownSummaryLines());
    const notes = [...getNotes().notes.values()].filter((n) => n.state !== 'done').map((n) => plainNote(n, 0));
    // 回憶：自己的和複製帶來的（即時共用讀來的不放，免得兩個聊天互相讀成一圈）。
    const memories = listMemories().filter((m) => !m.linked).map((m) => plainMemory(m, id));
    // 行事曆（生理期、親熱、紀念日，v0.13.33）：以前沒帶，新聊天的「上次生理期」和紀念日都是空的。
    const calendar = calendarOn() ? carryItems(id) : [];
    if (!lines.length && !notes.length && !memories.length && !calendar.length) return;
    const all = snapshots(true);
    const prev = all[id];
    const next = { at: Date.now(), floors: aiIndices().length, lines, notes, ...(memories.length ? { memories } : {}), ...(calendar.length ? { calendar } : {}) };
    if (prev && JSON.stringify({ ...prev, at: 0 }) === JSON.stringify({ ...next, at: 0 })) return;
    all[id] = next;
    const ids = Object.keys(all);
    if (ids.length > MAX_SNAPSHOTS) {
        ids.sort((a, b) => (all[a].at ?? 0) - (all[b].at ?? 0)).slice(0, ids.length - MAX_SNAPSHOTS).forEach((k) => delete all[k]);
    }
    saveSettings();
}

let snapshotTimer = null;
export function scheduleSnapshot() {
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
        try { writeSnapshot(); } catch (e) { console.warn(LOG_PREFIX, '快照失敗', e); }
    }, SNAPSHOT_DELAY_MS);
}

// ===== 前情提要 =====

/** 目前聊天的前情提要：{ text, source, mode: 'raw'|'condensed', status: 'ok'|'busy'|'fail', error?, raw, at } 或 null。 */
export function getRecap() {
    const r = chatRecord(false)?.recap;
    return r && typeof r.text === 'string' ? r : null;
}

/** 即時共用的摘要：{ source, lines, missing } 或 null。唯讀。 */
export function getLinkedSummary() {
    const link = chatRecord(false)?.summaryLink;
    if (!link?.source || effectiveScope('summary') !== 'share') return null;
    const snap = getSnapshot(link.source);
    return { source: link.source, lines: snap?.lines ?? [], at: snap?.at ?? 0, missing: !snap };
}

/** 注入用：前情提要（帶來的＋即時共用的）。 */
export function recapLines() {
    const out = [];
    const recap = getRecap();
    if (recap?.text) out.push(`${t('recap.label')}${recap.text}`);
    const linked = getLinkedSummary();
    if (linked?.lines.length) out.push(...linked.lines);
    return out;
}

const listeners = new Set();
export function onCarryChange(fn) {
    listeners.add(fn);
}
function emit() {
    invalidateNotes();
    for (const fn of listeners) {
        try { fn(); } catch (e) { console.error(LOG_PREFIX, e); }
    }
}

function fill(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

/** 用模型把前情提要濃縮成一段（從原文 raw 濃縮）。 */
export async function condenseRecap() {
    const rec = chatRecord(false);
    const recap = rec?.recap;
    if (!recap) return false;
    const chatId = chatKey();
    const raw = recap.raw ?? recap.text;
    rec.recap = { ...recap, raw, status: 'busy', error: null };
    emit();
    try {
        const c = ctx();
        const length = Number(getSettings().carry.recapLength) || 400;
        const prompt = fill(getTemplate('recap'), { recap: raw, length, char: c?.name2 ?? '', user: c?.name1 ?? '' });
        let text = String(await generateText(prompt, { maxTokens: Math.max(4000, length * 3), purpose: 'recap' }) ?? '').trim();
        text = text.replace(/^```\w*\s*/, '').replace(/\s*```$/, '').trim();
        if (!text) throw new Error(t('err.empty'));
        if (chatKey() !== chatId) return false;
        rec.recap = { ...rec.recap, text, mode: 'condensed', status: 'ok', at: Date.now() };
        return true;
    } catch (e) {
        console.warn(LOG_PREFIX, '前情提要濃縮失敗', e);
        if (chatKey() !== chatId) return false;
        rec.recap = { ...rec.recap, status: 'fail', error: errorText(e) };
        return false;
    } finally {
        if (chatKey() === chatId) {
            saveMeta();
            emit();
            scheduleSnapshot();
        }
    }
}

export function editRecap(text) {
    const rec = chatRecord(false);
    if (!rec?.recap) return false;
    rec.recap = { ...rec.recap, text: String(text).trim(), status: 'ok', manual: true, at: Date.now() };
    saveMeta();
    emit();
    scheduleSnapshot();
    return true;
}

/** 改回沒濃縮的原文。 */
export function restoreRecapRaw() {
    const rec = chatRecord(false);
    if (!rec?.recap?.raw) return false;
    rec.recap = { ...rec.recap, text: rec.recap.raw, mode: 'raw', status: 'ok', at: Date.now() };
    saveMeta();
    emit();
    return true;
}

export function deleteRecap() {
    const rec = chatRecord(false);
    if (!rec?.recap) return false;
    delete rec.recap;
    saveMeta();
    emit();
    scheduleSnapshot();
    return true;
}

// ===== 帶走（開新聊天時自動、或手動匯入） =====

/**
 * 從某個快照帶資料過來。
 * kinds：{ summary|characters|items|promises|todos: 'copy' | 'share' | 'none' }
 * 回傳 { summary: bool, notes: 帶來的記事數, condense: 要不要接著濃縮 }。
 */
function carryFrom(snap, kinds, { condense }) {
    const rec = chatRecord(true);
    const undo = {
        recap: rec.recap ?? null, base: rec.base ?? null, summaryLink: rec.summaryLink ?? null, memoriesLink: rec.memoriesLink ?? null,
        scope: rec.scope ? { ...rec.scope } : null,
    };
    const out = { summary: false, notes: 0, memories: 0, calendar: 0, condense: false };

    if (kinds.summary === 'copy' && snap.lines?.length) {
        const raw = snap.lines.join('\n');
        rec.recap = { text: raw, raw, source: snap.id, mode: 'raw', status: 'ok', at: Date.now() };
        out.summary = true;
        out.condense = condense;
    } else if (kinds.summary === 'share') {
        rec.summaryLink = { source: snap.id, at: Date.now() };
        out.summary = true;
    }

    const current = getNotes().notes;
    const titles = new Set([...current.values()].map((n) => `${n.type}\u0000${noteTitle(n).trim().toLowerCase()}`));
    const base = { ...(rec.base?.notes ?? {}) };
    let store = null;
    for (const n of snap.notes ?? []) {
        const mode = kinds[KIND_OF_TYPE[n.type]];
        if (!isTracked(n.type) || (mode !== 'copy' && mode !== 'share')) continue;
        const key = `${n.type}\u0000${noteTitle(n).trim().toLowerCase()}`;
        if (titles.has(key) || current.has(n.id)) continue;
        titles.add(key);
        const plain = { ...plainNote(n, 0), source: snap.id };
        if (mode === 'copy') {
            base[n.id] = plain;
        } else {
            // 共用的那份還沒有這條（例如來源聊天是獨立的）就補進去。
            store ??= sharedStore(true);
            if (!store.notes[n.id]) store.notes[n.id] = plain;
        }
        out.notes++;
    }
    // 回憶錄
    const memories = { ...(rec.base?.memories ?? {}) };
    if (kinds.memories === 'copy') {
        const have = new Set([...listMemories().map((m) => memoryOrigin(m)), ...Object.keys(memories)]);
        for (const m of snap.memories ?? []) {
            if (!m?.origin || have.has(m.origin)) continue;
            have.add(m.origin);
            memories[m.origin] = { ...m, from: m.from ?? snap.id };
            out.memories++;
        }
    } else if (kinds.memories === 'share' && snap.memories?.length) {
        rec.memoriesLink = { source: snap.id, at: Date.now() };
        out.memories = snap.memories.length;
    }
    rec.base = { notes: base, ...(Object.keys(memories).length ? { memories } : {}) };
    // 行事曆跟著摘要走：摘要有帶（複製或共用）就把生理期、親熱、紀念日複製過來。
    if (kinds.summary && kinds.summary !== 'none' && snap.calendar?.length) out.calendar = addCarriedEvents(snap.calendar, snap.id);
    if (store) saveSettings();
    rec.carry = { source: snap.id, at: Date.now(), undo, kinds };
    saveMeta();
    emit();
    return out;
}

/** 復原上一次帶入（新聊天自動帶的、或手動匯入的）。 */
export function undoCarry() {
    const rec = chatRecord(false);
    const carry = rec?.carry;
    if (!carry?.undo) return false;
    const { undo, kinds } = carry;
    for (const key of ['recap', 'base', 'summaryLink', 'memoriesLink']) {
        if (undo[key]) rec[key] = undo[key];
        else delete rec[key];
    }
    rec.scope = undo.scope ? { ...undo.scope } : rec.scope;
    // 共用的類型：這個聊天改成獨立，就看不到共用的那份了。
    for (const kind of SCOPE_KINDS) {
        if (kinds?.[kind] === 'share' && kind !== 'summary') rec.scope = { ...getChatScope(), ...(rec.scope ?? {}), [kind]: 'own' };
    }
    removeCarriedFrom(carry.source);
    delete rec.carry;
    saveMeta();
    emit();
    scheduleSnapshot();
    return true;
}

export function lastCarry() {
    return chatRecord(false)?.carry ?? null;
}

function isNewChat() {
    const chat = getChat();
    return !chat.some(isUserMessage) && aiIndices().length <= 1;
}

function announce(snap, result) {
    toastActions(t('carry.done', { chat: snap.id, notes: result.notes, memories: result.memories, calendar: result.calendar ?? 0 }), [{
        label: t('carry.undo'),
        run: () => {
            undoCarry();
            toast(t('carry.undone'), 'info');
        },
    }]);
}

/** 換聊天後：新聊天照角色的共同設定自動帶記憶；舊聊天第一次打開時設成獨立。 */
export async function onChatOpened() {
    if (!isActive() || !characterKey()) return;
    const rec = chatRecord(true);
    if (rec.linkInit) {
        scheduleSnapshot();
        return;
    }
    rec.linkInit = Date.now();
    if (!isNewChat()) {
        // 這個功能之前就有的聊天：維持原本「各自獨立」的樣子（使用者可以再改）。
        const scope = getChatScope();
        for (const kind of SCOPE_KINDS) if (scope[kind] === 'inherit') scope[kind] = 'own';
        rec.scope = scope;
        saveMeta();
        emit();
        scheduleSnapshot();
        return;
    }
    saveMeta();
    const snap = otherSnapshots()[0];
    if (!snap) return;
    const kinds = getCharacterScope();
    if (Object.values(kinds).every((v) => v === 'none')) return;
    const result = carryFrom(snap, kinds, { condense: getSettings().carry.recapMode === 'condense' });
    if (!result.summary && !result.notes && !result.memories && !result.calendar) {
        delete rec.carry;
        saveMeta();
        return;
    }
    announce(snap, result);
    if (result.condense) await condenseRecap();
}

/**
 * 手動從其他聊天匯入（一律複製帶走；摘要選「即時共用」時改成連結）。
 * kinds：{ summary: 'copy'|'share'|'none', characters: 'copy'|'none', … }
 */
export async function importFrom(snapshotId, kinds, { condense = getSettings().carry.recapMode === 'condense' } = {}) {
    const snap = getSnapshot(snapshotId);
    if (!snap) return null;
    if (kinds.summary === 'share') setChatScope('summary', 'share');
    const result = carryFrom(snap, kinds, { condense });
    if (result.condense) condenseRecap();
    return result;
}

// ===== 改記憶範圍 =====

/** 從共用改成別的時，把共用的那份留一份在這個聊天（之後各自獨立）。 */
function freezeShared(types) {
    if (!types.length) return;
    const rec = chatRecord(true);
    const shared = sharedStore(false)?.notes ?? {};
    const base = { ...(rec.base?.notes ?? {}) };
    for (const n of Object.values(shared)) if (types.includes(n.type) && !n.deleted) base[n.id] = { ...n };
    rec.base = { ...(rec.base ?? {}), notes: base };
}

/** 回憶從即時共用改成別的：把來源的回憶留一份在這個聊天。 */
function freezeMemories() {
    const rec = chatRecord(true);
    const snap = rec.memoriesLink?.source ? getSnapshot(rec.memoriesLink.source) : null;
    const memories = { ...(rec.base?.memories ?? {}) };
    for (const m of snap?.memories ?? []) if (m?.origin && !memories[m.origin]) memories[m.origin] = { ...m, from: m.from ?? snap.id };
    rec.base = { ...(rec.base ?? { notes: {} }), memories };
    delete rec.memoriesLink;
}

function sharedTypes() {
    return NOTE_TYPES.filter(isShared);
}

function afterScopeChange(before, memShared = false) {
    const lost = before.filter((type) => !isShared(type));
    if (lost.length) freezeShared(lost);
    const rec = chatRecord(true);
    if (memShared && effectiveScope('memories') !== 'share' && rec.memoriesLink) freezeMemories();
    // 回憶改成即時共用但還沒有來源：跟摘要同一個來源，沒有就用最近聊的那個。
    if (effectiveScope('memories') === 'share' && !rec.memoriesLink?.source) {
        const src = rec.summaryLink?.source ?? otherSnapshots()[0]?.id;
        if (src) rec.memoriesLink = { source: src, at: Date.now() };
    }
    // 摘要改成即時共用但還沒選來源：用最近聊的那個。
    if (effectiveScope('summary') === 'share' && !rec.summaryLink?.source) {
        const snap = otherSnapshots()[0];
        if (snap) rec.summaryLink = { source: snap.id, at: Date.now() };
    }
    saveMeta();
    emit();
}

export function changeChatScope(kind, value) {
    const before = sharedTypes();
    const mem = effectiveScope('memories') === 'share';
    setChatScope(kind, value);
    afterScopeChange(before, mem);
}

export function changeCharacterScope(kind, value) {
    const before = sharedTypes();
    const mem = effectiveScope('memories') === 'share';
    setCharacterScope(kind, value);
    afterScopeChange(before, mem);
}

/** 摘要即時共用的來源改成另一個聊天。 */
export function setSummarySource(snapshotId) {
    const rec = chatRecord(true);
    rec.summaryLink = { source: snapshotId, at: Date.now() };
    // 回憶也即時共用時，跟著用同一個來源。
    if (effectiveScope('memories') === 'share') rec.memoriesLink = { source: snapshotId, at: Date.now() };
    saveMeta();
    emit();
}

export function initCarry() {
    setNotesBase(baseNotes);
    setNotesSync(syncShared);
    setMemoriesBase(baseMemories);
    // 手動改了記事：馬上重播一次，共用的那份才會立刻更新（不用等畫面重畫）。
    onNotesChange(() => {
        try { getNotes(); } catch (e) { console.error(LOG_PREFIX, e); }
        scheduleSnapshot();
    });
    onSummaryChange(scheduleSnapshot);
    onMemoriesChange(scheduleSnapshot);
    onCalendarChange(scheduleSnapshot);
    const c = ctx();
    if (!c?.eventSource || !c.eventTypes) return;
    c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => {
        invalidateNotes();
        onChatOpened().catch((e) => console.error(LOG_PREFIX, '帶記憶失敗', e));
    });
}

export { TYPE_OF_KIND };
