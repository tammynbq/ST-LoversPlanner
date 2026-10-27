// 行程併進約定（v0.13.18，使用者決定：「也是約定也是行程」）：
// 模型不再另外記行事曆的「📌 行程」（plan 事件），有日期的事記成約定／待辦（due 寫日期），月曆上照樣顯示。
// 以前記下的行程，打開聊天時轉成約定一次（chat_metadata.lovers_planner.plansMerged），
// 已經有同一天、差不多內容的約定／待辦的就不重複轉。轉過去的行程從行事曆拿掉。
// 另外把有預定日期的約定／待辦接到行事曆的「接下來幾天」（注入給角色的提醒）。

import { ctx, hasCharacterChat, LOG_PREFIX, MODULE } from './util.js';
import { aiIndices, getChat, getEntry } from './chat.js';
import { normDate, setDatedNotesProvider } from './calendar.js';
import { addNotesManualBatch, getNotes, noteTitle } from './notes.js';
import { noteDates } from './notedates.js';
import { isTracked } from './settings.js';

const MAX_TITLE = 15;

function norm(x) {
    return String(x ?? '').replace(/[\s\p{P}]/gu, '').toLowerCase();
}

/** 已經有同一天、內容差不多的約定／待辦。 */
function alreadyThere(notes, date, title) {
    const t = norm(title);
    return notes.some((n) => {
        if (n.type !== 'promise' && n.type !== 'todo') return false;
        if (noteDates(n).due !== date) return false;
        const a = norm(n.data.title);
        const b = norm(noteTitle(n));
        return !t || [a, b].some((x) => x && (x.includes(t) || t.includes(x)));
    });
}

/** 這個聊天以前記下的行程：[{ date, title, floor?, key?, id? }]。 */
function oldPlans() {
    const rec = ctx()?.chatMetadata?.[MODULE]?.calendar;
    const removed = new Set(rec?.removed ?? []);
    const chat = getChat();
    const out = [];
    let cur = '';
    for (const i of aiIndices()) {
        const e = getEntry(i);
        if (e?.status !== 'ok') continue;
        if (normDate(e.date)) cur = normDate(e.date);
        (e.events ?? []).forEach((ev, k) => {
            if (ev?.type !== 'plan' || !ev.title) return;
            const key = `${chat[i]?.send_date ?? `#${i}`}#${k}`;
            if (removed.has(key)) return;
            const date = normDate(ev.date) || cur;
            if (date) out.push({ date, title: String(ev.title), floor: i, key, made: cur });
        });
    }
    for (const ev of rec?.manual ?? []) {
        if (ev?.type === 'plan' && ev.title && normDate(ev.date)) out.push({ date: normDate(ev.date), title: String(ev.title), id: ev.id });
    }
    return out;
}

/** 轉一次。回傳轉了幾條（已經轉過就是 0）。 */
export function mergePlans() {
    if (!hasCharacterChat()) return 0;
    const meta = ctx()?.chatMetadata;
    if (!meta) return 0;
    const rec = meta[MODULE] ?? {};
    if (rec.plansMerged) return 0;
    const plans = oldPlans();
    const notes = [...getNotes().notes.values()];
    const list = [];
    for (const p of plans) {
        if (alreadyThere(notes, p.date, p.title) || list.some((x) => x.data.due === p.date && norm(x.data.content) === norm(p.title))) continue;
        list.push({ type: 'promise', data: { title: p.title.slice(0, MAX_TITLE), content: p.title, due: p.date }, made: p.made || '', fromFloor: p.floor });
    }
    const n = list.length ? addNotesManualBatch(list) : 0;
    meta[MODULE] = { ...(meta[MODULE] ?? {}), plansMerged: true };
    // 舊的行程從行事曆拿掉（約定已經會顯示在月曆上）。
    const cal = meta[MODULE].calendar;
    if (cal) {
        cal.removed = [...new Set([...(cal.removed ?? []), ...plans.filter((p) => p.key).map((p) => p.key)])];
        cal.manual = (cal.manual ?? []).filter((ev) => ev?.type !== 'plan');
    }
    try {
        const c = ctx();
        if (typeof c?.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
        else c?.saveMetadata?.();
    } catch (e) {
        console.error(LOG_PREFIX, e);
    }
    if (n) console.log(LOG_PREFIX, `把 ${n} 個行程轉成約定`);
    return n;
}

// 行事曆的「接下來幾天」也列有預定日期、還沒完成的約定／待辦。
setDatedNotesProvider(() => [...getNotes().notes.values()]
    .filter((n) => (n.type === 'promise' || n.type === 'todo') && n.state === 'active' && isTracked(n.type))
    .map((n) => ({ date: noteDates(n).due, kind: n.type, title: n.data.title || noteTitle(n) }))
    .filter((x) => x.date));
