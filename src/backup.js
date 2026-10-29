// 資料管理（v0.13.7，使用者要求）：這個聊天的戀人手帳內容導出、導入、全部刪除。
//
// 導出的檔案：{ format, version, exportedAt, chat, character, floors: [{ sendDate, index, name, entry }], meta, settings? }
//   floors：每一層訊息上的 extra.lovers_planner（摘要、記事變化、日期、回憶…），用 send_date 對回樓層。
//   meta：chat_metadata.lovers_planner（章、卷、手動改的記事、行事曆、回憶錄、前情提要…）。
//   settings：戀人手帳的設定，不含 API 金鑰（免得分享檔案時外洩）。
// 導入：「覆蓋」先清空再放進去；「合併」只補還沒有摘要的樓層，聊天資料裡的清單只加沒有的。
//   原文改過的樓層，hash 對不上，會自然變成「過期」。
// 刪除：聊天本身不動，只清掉每一層（含每個 swipe）上的戀人手帳資料、聊天資料、角色那邊這個聊天的快照；
//   和同角色其他聊天共用的記事不清（使用者決定）。刪除前會先下載一份備份。

import { ctx, MODULE } from './util.js';
import { getSettings, saveSettings } from './settings.js';
import { chatKey, getChat, hashText, isAiMessage, saveChatSoon, setEntry } from './chat.js';
import { invalidateNotes } from './notes.js';
import { cancelQueue } from './summarize.js';
import { clearInjection } from './hide.js';
import { removeSnapshot } from './carry.js';

export const BACKUP_FORMAT = 'lovers-planner-backup';
export const BACKUP_VERSION = 1;

/** 設定裡不能導出的（金鑰）。 */
const SECRET_PATHS = [['custom', 'key'], ['recall', 'vector', 'key']];

function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function withoutSecrets(settings) {
    const out = clone(settings) ?? {};
    // 角色的快照屬於各個聊天，不放進設定的備份；調用紀錄也不放。
    delete out.characters;
    delete out.usage;
    for (const path of SECRET_PATHS) {
        let obj = out;
        for (const k of path.slice(0, -1)) obj = obj?.[k];
        if (obj && path[path.length - 1] in obj) obj[path[path.length - 1]] = '';
    }
    for (const p of out.profiles ?? []) if (p && 'key' in p) p.key = '';
    return out;
}

function saveMeta() {
    const c = ctx();
    try {
        if (typeof c?.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
        else c?.saveMetadata?.();
    } catch (e) { /* 忽略 */ }
}

/** 這個聊天的戀人手帳內容（給導出用）。 */
export function buildBackup({ settings = true } = {}) {
    const c = ctx();
    const chat = getChat();
    const floors = [];
    chat.forEach((m, i) => {
        const entry = m?.extra?.[MODULE];
        if (!entry || !isAiMessage(m)) return;
        floors.push({ sendDate: m.send_date ?? null, index: i, name: m.name ?? '', entry: clone(entry) });
    });
    return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        chat: chatKey(),
        character: c?.name2 ?? '',
        floors,
        meta: clone(c?.chatMetadata?.[MODULE] ?? {}),
        ...(settings ? { settings: withoutSecrets(getSettings()) } : {}),
    };
}

/**
 * 檔名：lovers-planner_角色_日期_時間.json。只用英文字母和數字（瀏覽器遇到中文檔名有時會改成「download」），
 * 角色名不是英文的就用一段代碼代替；日期和時間讓每次導出的檔名不同。
 */
export function backupFileName(data) {
    const ascii = (x) => String(x ?? '').replace(/[^A-Za-z0-9.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
    const code = (x) => hashText(String(x ?? '')).slice(0, 6);
    const who = ascii(data.character) || code(`${data.character}|${data.chat}`);
    const at = (data.exportedAt ?? new Date().toISOString()).replace(/[-:]/g, '').slice(0, 13).replace('T', '_');
    return `lovers-planner_${who}_${at}.json`;
}

/** 下載成檔案。 */
export function downloadBackup(data = buildBackup()) {
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = backupFileName(data);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return a.download;
}

/** 讀進來的檔案是不是戀人手帳的備份。 */
export function parseBackup(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { return { error: 'json' }; }
    if (data?.format !== BACKUP_FORMAT || !Array.isArray(data.floors)) return { error: 'format' };
    if (Number(data.version) > BACKUP_VERSION) return { error: 'version' };
    return { data };
}

/** 清掉這一則訊息（含每個 swipe）上的戀人手帳資料。 */
function clearMessage(m) {
    if (m?.extra && MODULE in m.extra) delete m.extra[MODULE];
    for (const info of Array.isArray(m?.swipe_info) ? m.swipe_info : []) {
        if (info?.extra && MODULE in info.extra) delete info.extra[MODULE];
    }
}

/** 照 send_date 找回樓層；同一個 send_date 有好幾則時，選和原本位置最近的。 */
function finder() {
    const by = new Map();
    getChat().forEach((m, i) => {
        if (!isAiMessage(m)) return;
        const k = m.send_date ?? `#${i}`;
        if (!by.has(k)) by.set(k, []);
        by.get(k).push(i);
    });
    return (f) => {
        const list = by.get(f.sendDate ?? `#${f.index}`);
        if (!list?.length) return -1;
        return list.reduce((best, i) => (Math.abs(i - f.index) < Math.abs(best - f.index) ? i : best), list[0]);
    };
}

/** 合併聊天資料：清單（章、卷、手動修改…）只加沒有的；其他欄位已經有就不動。 */
function mergeMeta(cur, add) {
    const out = { ...cur };
    const byId = (a, b, key = 'id') => {
        const have = new Set((a ?? []).map((x) => (key === 'json' ? JSON.stringify(x) : x?.[key])));
        return [...(a ?? []), ...(b ?? []).filter((x) => !have.has(key === 'json' ? JSON.stringify(x) : x?.[key]))];
    };
    for (const [k, v] of Object.entries(add ?? {})) {
        if (k === 'catchup') continue; // 補建進度不跟著搬
        if (k === 'chapters' || k === 'volumes') out[k] = byId(cur[k], v);
        else if (k === 'manualOps') out[k] = byId(cur[k], v, 'json');
        else if ((k === 'calendar' || k === 'memories') && v && typeof v === 'object') {
            const c = cur[k] ?? {};
            out[k] = { ...v, ...c, manual: byId(c.manual, v.manual), removed: [...new Set([...(c.removed ?? []), ...(v.removed ?? [])])] };
        } else if (!(k in cur)) out[k] = v;
    }
    return out;
}

/**
 * 導入。mode：'replace' 覆蓋（先清空）／'merge' 合併（只補沒有的）。settings：也導入設定（不會蓋掉現在的 API 金鑰）。
 * 回傳 { matched, unmatched, skipped }。
 */
export function importBackup(data, { mode = 'merge', settings = false } = {}) {
    const c = ctx();
    const chat = getChat();
    cancelQueue();
    if (mode === 'replace') chat.forEach(clearMessage);
    const find = finder();
    let matched = 0;
    let unmatched = 0;
    let skipped = 0;
    for (const f of data.floors) {
        const i = find(f);
        if (i < 0 || !f.entry) {
            unmatched++;
            continue;
        }
        if (mode === 'merge' && chat[i]?.extra?.[MODULE]) {
            skipped++;
            continue;
        }
        setEntry(i, clone(f.entry));
        matched++;
    }
    if (c?.chatMetadata) {
        const meta = clone(data.meta ?? {});
        delete meta?.catchup;
        c.chatMetadata[MODULE] = mode === 'replace' ? meta : mergeMeta(c.chatMetadata[MODULE] ?? {}, meta);
    }
    if (settings && data.settings) {
        const cur = getSettings();
        const keep = { custom: cur.custom?.key, vector: cur.recall?.vector?.key, characters: cur.characters, usage: cur.usage,
            profiles: new Map((cur.profiles ?? []).map((p) => [p.id, p.key])) };
        const next = clone(data.settings);
        delete next.characters;
        delete next.usage;
        Object.assign(cur, next);
        if (cur.custom) cur.custom.key = keep.custom ?? '';
        if (cur.recall?.vector) cur.recall.vector.key = keep.vector ?? '';
        // 另外存的幾組 API：Key 不導出，導入時同一組（同 id）沿用這台裝置的 Key。
        for (const p of cur.profiles ?? []) p.key = keep.profiles.get(p.id) ?? '';
        cur.characters = keep.characters;
        cur.usage = keep.usage;
        saveSettings();
    }
    invalidateNotes();
    saveChatSoon();
    saveMeta();
    return { matched, unmatched, skipped };
}

/** 刪除這個聊天的戀人手帳內容（聊天本身不動；共用的記事不動）。回傳清掉了幾層。 */
export function wipeChat() {
    const c = ctx();
    const chat = getChat();
    cancelQueue();
    let n = 0;
    chat.forEach((m) => {
        if (m?.extra?.[MODULE] || (Array.isArray(m?.swipe_info) && m.swipe_info.some((x) => x?.extra?.[MODULE]))) n++;
        clearMessage(m);
    });
    if (c?.chatMetadata && MODULE in c.chatMetadata) delete c.chatMetadata[MODULE];
    removeSnapshot();
    clearInjection();
    invalidateNotes();
    saveChatSoon();
    saveMeta();
    return n;
}
