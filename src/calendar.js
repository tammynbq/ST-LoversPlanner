// 行事曆（使用者要求）：故事裡的日期＋行程、生理期、親熱的日子、紀念日。
//
// 日期：每層摘要時請模型回報「這一層是故事裡的哪一天」（entry.date，YYYY-MM-DD）；
//       沒寫就延續上一層，過夜就加一天；完全沒線索時從設定的「故事開始日」算。
// 事件：每層摘要時一起回報（entry.events），另外可以手動新增；樓層的事件可以單獨隱藏。
//   plan        { date, title }        某天要做的事
//   period      { state: start|end }   {{user}} 的生理期開始／結束（日期＝這一層的日期）
//   intimacy    { count }              親熱幾次（日期＝這一層的日期）
//   anniversary { date: MM-DD, title } 紀念日、生日（每年重複）
// 行事曆不另外存，和記事一樣每次從各層算出來；手動的部分存在 chat_metadata.lovers_planner.calendar。

import { ctx, MODULE } from './util.js';
import { getSettings } from './settings.js';
import { currentLocale, t } from './i18n.js';
import { aiIndices, getChat, getEntry } from './chat.js';

export const CAL_TYPES = ['plan', 'period', 'intimacy', 'anniversary'];

/**
 * 現在還在用的事件類型。plan（行程）在 v0.13.18 併進約定／待辦（使用者決定），模型不再回報、不能手動新增，
 * 舊資料由 planmerge.js 轉成約定；這裡只留著 CAL_TYPES 讓舊資料讀得懂。
 */
export const ACTIVE_CAL_TYPES = CAL_TYPES.filter((x) => x !== 'plan');

// 有預定日期的約定／待辦（planmerge.js 提供，避免互相 import）：[{ date, kind: 'promise'|'todo', title }]。
let datedNotesProvider = null;
export function setDatedNotesProvider(fn) {
    datedNotesProvider = fn;
}

// ===== 日期小工具（一律用 UTC，免得時區讓日期差一天） =====

const DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

/** 整理成 YYYY-MM-DD；不合法回傳 ''。 */
export function normDate(value) {
    const m = String(value ?? '').trim().replace(/[/.年月]/g, '-').replace(/日$/, '').match(DATE_RE);
    if (!m) return '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCMonth() !== +m[2] - 1) return '';
    return d.toISOString().slice(0, 10);
}

/** 整理成 MM-DD（紀念日）；也接受完整日期。 */
export function normMonthDay(value) {
    const s = String(value ?? '').trim().replace(/[/.月]/g, '-').replace(/日$/, '');
    const full = normDate(s);
    if (full) return full.slice(5);
    const m = s.match(/^(\d{1,2})-(\d{1,2})$/);
    if (!m || +m[1] < 1 || +m[1] > 12 || +m[2] < 1 || +m[2] > 31) return '';
    return `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function toDate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(s, n) {
    const d = toDate(s);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
    return Math.round((toDate(b) - toDate(a)) / 86400000);
}

export function weekdayName(s, style = 'short') {
    return toDate(s).toLocaleDateString(currentLocale(), { weekday: style, timeZone: 'UTC' });
}

export function monthTitle(ym) {
    return toDate(`${ym}-01`).toLocaleDateString(currentLocale(), { year: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** 這個月（YYYY-MM）的格子：前面補上個月的空格，每週從星期日開始。 */
export function monthGrid(ym) {
    const first = `${ym}-01`;
    const pad = toDate(first).getUTCDay();
    const days = [];
    for (let d = first; d.startsWith(ym); d = addDays(d, 1)) days.push(d);
    return { pad, days };
}

export function shiftMonth(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    const total = y * 12 + (m - 1) + n;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

// ===== 設定 =====

export function calendarOn() {
    const c = getSettings().calendar;
    return Boolean(c?.enabled) && ACTIVE_CAL_TYPES.some((x) => c.track?.[x]);
}

export function calTracked(type) {
    const c = getSettings().calendar;
    return Boolean(c?.enabled && c.track?.[type]);
}

// ===== 整理模型回報的事件 =====

/** 模型回報的 events 整理成固定格式，只留有勾選的類型。 */
export function cleanEvents(raw) {
    const out = [];
    for (const ev of Array.isArray(raw) ? raw : []) {
        const type = String(ev?.type ?? '').toLowerCase();
        if (!ACTIVE_CAL_TYPES.includes(type) || !calTracked(type)) continue;
        const title = String(ev.title ?? ev.content ?? '').trim().slice(0, 60);
        if (type === 'plan') {
            if (title) out.push({ type, date: normDate(ev.date), title });
        } else if (type === 'period') {
            const state = String(ev.state ?? 'start').toLowerCase() === 'end' ? 'end' : 'start';
            out.push({ type, state });
        } else if (type === 'intimacy') {
            const count = Math.min(20, Math.max(1, Number.parseInt(ev.count, 10) || 1));
            out.push({ type, count });
        } else if (type === 'anniversary') {
            const date = normMonthDay(ev.date);
            if (title && date) out.push({ type, date, title });
        }
    }
    return out.slice(0, 10);
}

// ===== 手動的部分 =====

function record(create) {
    const meta = ctx()?.chatMetadata;
    if (!meta) return null;
    if (!meta[MODULE] && create) meta[MODULE] = {};
    const rec = meta[MODULE];
    if (rec && !rec.calendar && create) rec.calendar = { manual: [], removed: [] };
    return rec?.calendar ?? null;
}

function saveMeta() {
    const c = ctx();
    try {
        if (typeof c?.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
        else c?.saveMetadata?.();
    } catch (e) { /* 忽略 */ }
    for (const fn of listeners) {
        try { fn(); } catch (e) { console.error(e); }
    }
}

const listeners = new Set();
export function onCalendarChange(fn) {
    listeners.add(fn);
}

export function addManualEvent(ev) {
    const [clean] = cleanEvents([ev]);
    const date = normDate(ev.date);
    if (!clean || (!date && clean.type !== 'anniversary')) return false;
    const rec = record(true);
    rec.manual = [...(rec.manual ?? []), { ...clean, ...(clean.type === 'anniversary' ? {} : { date }), id: `ev_${Math.random().toString(36).slice(2, 8)}` }];
    saveMeta();
    return true;
}

export function removeEvent(item) {
    const rec = record(true);
    if (item.source === 'manual') rec.manual = (rec.manual ?? []).filter((x) => x.id !== item.id);
    else if (item.source === 'carried') rec.carried = (rec.carried ?? []).filter((x) => x.origin !== item.origin);
    else rec.removed = [...new Set([...(rec.removed ?? []), item.key])];
    saveMeta();
    return true;
}

// ===== 帶到其他聊天（v0.13.33） =====

/**
 * 這個聊天的行事曆事件（生理期、親熱、紀念日），帶到別的聊天用。
 * origin 是最早記下它的「聊天#key」，一路帶下去也認得出同一筆。
 */
export function carryItems(chatId) {
    return buildCalendar().items.filter((x) => ['period', 'intimacy', 'anniversary'].includes(x.type)).map((x) => ({
        type: x.type,
        date: x.date,
        ...(x.title ? { title: x.title } : {}),
        ...(x.state ? { state: x.state } : {}),
        ...(x.count ? { count: x.count } : {}),
        origin: x.origin ?? `${chatId}#${x.key ?? x.id}`,
    }));
}

/** 把別的聊天的事件加進這個聊天（同一筆不重複；同一天同名的紀念日也不重複）。回傳加了幾筆。 */
export function addCarriedEvents(list, from = '') {
    const rec = record(true);
    const have = new Set((rec.carried ?? []).map((x) => x.origin));
    const cal = buildCalendar();
    const annivs = new Set(cal.items.filter((x) => x.type === 'anniversary').map((x) => `${x.date}|${String(x.title ?? '').trim()}`));
    const add = [];
    for (const ev of list ?? []) {
        if (!ev?.origin || have.has(ev.origin) || !['period', 'intimacy', 'anniversary'].includes(ev.type)) continue;
        if (ev.type === 'anniversary') {
            const k = `${ev.date}|${String(ev.title ?? '').trim()}`;
            if (annivs.has(k)) continue;
            annivs.add(k);
        }
        have.add(ev.origin);
        add.push({ ...ev, ...(from && !ev.from ? { from } : {}) });
    }
    if (!add.length) return 0;
    rec.carried = [...(rec.carried ?? []), ...add];
    saveMeta();
    return add.length;
}

/** 拿掉從某個聊天帶來的事件（復原帶入用）。 */
export function removeCarriedFrom(from) {
    const rec = record(false);
    if (!rec?.carried?.length) return 0;
    const before = rec.carried.length;
    rec.carried = rec.carried.filter((x) => x.from !== from);
    if (rec.carried.length !== before) saveMeta();
    return before - rec.carried.length;
}

/** 隱藏過的樓層事件全部恢復。 */
export function restoreRemoved() {
    const rec = record(false);
    if (!rec?.removed?.length) return false;
    rec.removed = [];
    saveMeta();
    return true;
}

// ===== 算出行事曆 =====

/** 生理期沒記到「結束」時，最多當作持續幾天（只用來在月曆上標出來）。 */
const OPEN_DAYS = 10;

/**
 * 回傳 {
 *   today: 'YYYY-MM-DD' | null（最新一個有日期的樓層），
 *   items: [{ type, date, title?, count?, state?, source: 'floor'|'manual', floor?, key?, id? }],
 *   periods: [{ start, end, open }]（open：沒記到結束）,
 *   removedCount,
 * }
 */
export function buildCalendar() {
    const s = getSettings().calendar ?? {};
    const rec = record(false);
    const removed = new Set(rec?.removed ?? []);
    const items = [];
    let cur = '';
    let today = null;
    const chat = getChat();
    for (const i of aiIndices()) {
        const e = getEntry(i);
        if (e?.status !== 'ok') continue;
        const d = normDate(e.date);
        if (d) cur = d;
        if (cur) today = cur;
        (e.events ?? []).forEach((ev, k) => {
            // 行程已經轉成約定（planmerge.js），不再顯示。
            if (ev.type === 'plan' || !calTracked(ev.type)) return;
            const key = `${chat[i]?.send_date ?? `#${i}`}#${k}`;
            if (removed.has(key)) return;
            const date = ev.type === 'plan' ? (normDate(ev.date) || cur) : ev.type === 'anniversary' ? ev.date : cur;
            if (!date) return;
            items.push({ ...ev, date, source: 'floor', floor: i, key });
        });
    }
    for (const ev of rec?.manual ?? []) if (ev.type !== 'plan' && calTracked(ev.type)) items.push({ ...ev, source: 'manual' });
    // 從其他聊天帶來的（v0.13.33）：舊聊天整理、帶到新聊天。
    for (const ev of rec?.carried ?? []) if (ev.type !== 'plan' && calTracked(ev.type)) items.push({ ...ev, source: 'carried' });
    if (!today) today = normDate(s.start) || null;

    // 生理期（v0.13.1 使用者要求：不是每個人都有固定週期，不設週期、不預測）：
    // 只記劇情裡提到的開始和結束。每次開始配上之後（下次開始之前）的第一個結束；
    // 沒記到結束的，最多算 OPEN_DAYS 天（也不超過下次開始的前一天）。
    const starts = [...new Set(items.filter((x) => x.type === 'period' && x.state === 'start').map((x) => x.date))].sort();
    const ends = items.filter((x) => x.type === 'period' && x.state === 'end').map((x) => x.date).sort();
    const periods = starts.map((start, k) => {
        const nextStart = starts[k + 1];
        const end = ends.find((x) => x >= start && (!nextStart || x < nextStart));
        if (end) return { start, end, open: false };
        let last = addDays(start, OPEN_DAYS - 1);
        if (nextStart && last >= nextStart) last = addDays(nextStart, -1);
        return { start, end: last, open: true };
    });
    const cal = { today, items, periods, removedCount: removed.size, prediction: null };
    if (s.predict && calTracked('period')) cal.prediction = predictPeriod(periods, Boolean(s.ovulation));
    return cal;
}

// ===== 生理期推算（選項，預設關） =====

/** 至少要記到幾次完整的週期（開始到下次開始）才推算。 */
const MIN_CYCLES = 3;
/** 用最近幾次週期。 */
const RECENT_CYCLES = 6;
/** 比這更短的間隔當成記錯（同一次記了兩個開始），不算。 */
const MIN_GAP = 15;
/** 排卵日 ≈ 下次生理期前 14 天；容易受孕的日子是排卵日前 5 天到排卵後 1 天。 */
const LUTEAL = 14;
/** 推算的範圍超過這麼多天，就不推排卵期（太不規律，推了也沒意義）。 */
const OVULATION_MAX_SPREAD = 14;

function median(list) {
    const a = [...list].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

/**
 * 範圍法：下次大約在「上次開始＋最近幾次裡最短的週期」到「＋最長的週期」之間（不給單一日期）。
 * 很長的間隔（一季、半年）也算進去，範圍會變寬，本身就表示不確定。
 * 回傳 null（資料不夠），或 { cycles, min, max, median, last, earliest, latest, fertile: { from, to } | null, spread }。
 */
export function predictPeriod(periods, ovulation = false) {
    const starts = periods.map((p) => p.start);
    const gaps = [];
    for (let k = 1; k < starts.length; k++) {
        const d = daysBetween(starts[k - 1], starts[k]);
        if (d >= MIN_GAP) gaps.push(d);
    }
    if (gaps.length < MIN_CYCLES) return null;
    const recent = gaps.slice(-RECENT_CYCLES);
    const min = Math.min(...recent);
    const max = Math.max(...recent);
    const last = starts[starts.length - 1];
    const earliest = addDays(last, min);
    const latest = addDays(last, max);
    const spread = max - min;
    const fertile = ovulation && spread <= OVULATION_MAX_SPREAD
        ? { from: addDays(earliest, -(LUTEAL + 5)), to: addDays(latest, -(LUTEAL - 1)) }
        : null;
    return { cycles: recent.length, min, max, median: median(recent), last, earliest, latest, fertile, spread, ovulationSkipped: ovulation && !fertile };
}

/** 某一天的內容：{ items, plans, anniversaries, intimacy, period: 'actual'|'predicted'|null, periodDay, periodOpen, fertile }。 */
export function dayInfo(cal, date) {
    const md = date.slice(5);
    const on = cal.items.filter((x) => (x.type === 'anniversary' ? x.date === md : x.date === date));
    const info = {
        items: on,
        plans: on.filter((x) => x.type === 'plan'),
        anniversaries: on.filter((x) => x.type === 'anniversary'),
        intimacy: on.filter((x) => x.type === 'intimacy').reduce((n, x) => n + (Number(x.count) || 1), 0),
        period: null,
        periodDay: 0,
        periodOpen: false,
        fertile: false,
    };
    const p = cal.periods.find((x) => date >= x.start && date <= x.end);
    if (p) {
        info.period = 'actual';
        info.periodDay = daysBetween(p.start, date) + 1;
        info.periodOpen = p.open;
    }
    // 推算（只有開了選項才有）：下次大約的範圍、排卵期。上次生理期還沒結束的日子不算。
    const pred = cal.prediction;
    if (pred && !p) {
        const lastEnd = cal.periods[cal.periods.length - 1]?.end ?? '';
        if (date >= pred.earliest && date <= pred.latest && date > lastEnd) info.period = 'predicted';
        if (pred.fertile && date >= pred.fertile.from && date <= pred.fertile.to && date > lastEnd) info.fertile = true;
    }
    return info;
}

/** 紀念日下一次是哪天（從 from 那天開始算，含當天）。 */
function nextAnniversary(md, from) {
    let date = `${from.slice(0, 4)}-${md}`;
    if (!normDate(date)) date = `${from.slice(0, 4)}-02-28`; // 2 月 29 日遇到平年
    if (date < from) date = `${Number(from.slice(0, 4)) + 1}-${md}`;
    return normDate(date) || `${Number(from.slice(0, 4)) + 1}-02-28`;
}

/** 從今天起 ahead 天內的事（含今天）：[{ date, in: 幾天後, kind, title }]，依日期排序。 */
export function upcoming(cal, ahead = Number(getSettings().calendar?.ahead) || 7) {
    if (!cal.today) return [];
    const end = addDays(cal.today, ahead);
    const out = [];
    for (const x of cal.items) {
        if (x.type === 'anniversary') {
            const d = nextAnniversary(x.date, cal.today);
            if (d <= end) out.push({ date: d, kind: 'anniversary', title: x.title });
        }
    }
    // 有預定日期的約定／待辦（過了還沒做的不列，那由記事清單提醒）。
    let dated = [];
    try { dated = datedNotesProvider?.() ?? []; } catch (e) { console.error(e); }
    for (const x of dated) if (x.date >= cal.today && x.date <= end) out.push(x);
    return out.map((x) => ({ ...x, in: daysBetween(cal.today, x.date) })).sort((a, b) => a.date.localeCompare(b.date));
}

/** 開了推算、但資料還不夠推算時：上次開始後超過這麼多天沒來，也告訴角色（讓角色可以關心）。 */
const LONG_ABSENCE = 60;

/**
 * 今天的生理期狀態：
 *   { kind: 'during', day, open }
 *   { kind: 'last', date, days, soon?, late?, long?, fertile? }：上次開始是哪天、幾天前；
 *     開了推算時：soon＝今天在推算的範圍附近（前 3 天起）、late＝比推算最晚的日子晚了幾天、fertile＝今天可能在排卵期；
 *     資料不夠推算時：long＝上次之後已經超過 60 天沒來。
 * | null
 */
export function periodStatus(cal) {
    if (!calTracked('period') || !cal.today) return null;
    const info = dayInfo(cal, cal.today);
    if (info.period === 'actual') return { kind: 'during', day: info.periodDay, open: info.periodOpen };
    const past = cal.periods.filter((x) => x.start <= cal.today);
    if (!past.length) return null;
    const last = past[past.length - 1].start;
    const out = { kind: 'last', date: last, days: daysBetween(last, cal.today) };
    if (!getSettings().calendar?.predict) return out;
    const pred = cal.prediction;
    if (pred) {
        if (cal.today > pred.latest) out.late = daysBetween(pred.latest, cal.today);
        else if (cal.today >= addDays(pred.earliest, -3)) out.soon = true;
        if (info.fertile) out.fertile = true;
    } else if (out.days > LONG_ABSENCE) {
        out.long = true;
    }
    return out;
}

// ===== 送給角色的文字 =====

export function calendarInjection() {
    const s = getSettings().calendar;
    if (!calendarOn() || !s.inject) return '';
    const cal = buildCalendar();
    if (!cal.today) return '';
    const user = ctx()?.name1 ?? '';
    const lines = [t('cal.inject.today', { date: cal.today, weekday: weekdayName(cal.today, 'long') })];
    const p = periodStatus(cal);
    // 生理期中告訴角色第幾天；開了推算才說「可能快來了」「晚了」「排卵期」「很久沒來」（語氣都是不確定的）。
    if (p?.kind === 'during') lines.push(t('cal.inject.during', { user, day: p.day }));
    else if (p?.kind === 'last') {
        const pred = cal.prediction;
        if (p.late) lines.push(t('cal.inject.late', { user, n: p.late, days: p.days }));
        else if (p.soon) lines.push(t('cal.inject.soon', { user, from: pred.earliest.slice(5), to: pred.latest.slice(5) }));
        else if (p.long) lines.push(t('cal.inject.long', { user, days: p.days }));
        if (p.fertile) lines.push(t('cal.inject.fertile', { user }));
    }
    const today = dayInfo(cal, cal.today);
    if (today.intimacy) lines.push(t('cal.inject.intimacy', { n: today.intimacy }));
    const list = upcoming(cal).filter((x) => x.kind !== 'period');
    if (list.length) {
        const parts = list.map((x) => {
            const when = x.in === 0 ? t('cal.today') : t('cal.inDays', { n: x.in });
            const label = x.kind === 'anniversary' ? t('cal.anniversaryOf', { title: x.title })
                : x.kind === 'promise' || x.kind === 'todo' ? t(`cal.${x.kind}Of`, { title: x.title }) : x.title;
            return `${x.date.slice(5)}（${when}）${label}`;
        });
        lines.push(t('cal.inject.upcoming', { list: parts.join('；') }));
    }
    return lines.join('\n');
}
