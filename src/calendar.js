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
    return Boolean(c?.enabled) && CAL_TYPES.some((x) => c.track?.[x]);
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
        if (!CAL_TYPES.includes(type) || !calTracked(type)) continue;
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
    else rec.removed = [...new Set([...(rec.removed ?? []), item.key])];
    saveMeta();
    return true;
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

/**
 * 回傳 {
 *   today: 'YYYY-MM-DD' | null（最新一個有日期的樓層），
 *   items: [{ type, date, title?, count?, state?, source: 'floor'|'manual', floor?, key?, id? }],
 *   periods: [{ start, end, assumed }], cycle, length, next: 下次預計開始 | null,
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
            if (!calTracked(ev.type)) return;
            const key = `${chat[i]?.send_date ?? `#${i}`}#${k}`;
            if (removed.has(key)) return;
            const date = ev.type === 'plan' ? (normDate(ev.date) || cur) : ev.type === 'anniversary' ? ev.date : cur;
            if (!date) return;
            items.push({ ...ev, date, source: 'floor', floor: i, key });
        });
    }
    for (const ev of rec?.manual ?? []) if (calTracked(ev.type)) items.push({ ...ev, source: 'manual' });
    if (!today) today = normDate(s.start) || null;

    // 生理期：每次開始，配上之後（下次開始之前）的第一個結束；沒記結束就當作持續「每次幾天」。
    const length = Math.max(1, Number(s.periodLength) || 5);
    const starts = [...new Set(items.filter((x) => x.type === 'period' && x.state === 'start').map((x) => x.date))].sort();
    const ends = items.filter((x) => x.type === 'period' && x.state === 'end').map((x) => x.date).sort();
    const periods = starts.map((start, k) => {
        const nextStart = starts[k + 1];
        const end = ends.find((x) => x >= start && (!nextStart || x < nextStart));
        return { start, end: end ?? addDays(start, length - 1), assumed: !end };
    });
    const diffs = [];
    for (let k = 1; k < starts.length; k++) {
        const d = daysBetween(starts[k - 1], starts[k]);
        if (d >= 15 && d <= 60) diffs.push(d);
    }
    const cycle = diffs.length ? Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length) : Math.max(15, Number(s.periodCycle) || 28);
    const next = starts.length ? addDays(starts[starts.length - 1], cycle) : null;
    return { today, items, periods, cycle, length, next, removedCount: removed.size };
}

/** 某一天的內容：{ plans, anniversaries, intimacy, intimacyItems, periodItems, period: 'actual'|'predicted'|null, periodDay }。 */
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
    };
    const p = cal.periods.find((x) => date >= x.start && date <= x.end);
    if (p) {
        info.period = 'actual';
        info.periodDay = daysBetween(p.start, date) + 1;
    } else if (cal.next && calTracked('period')) {
        // 預測接下來三次。
        for (let k = 0; k < 3; k++) {
            const start = addDays(cal.next, k * cal.cycle);
            if (date >= start && date <= addDays(start, cal.length - 1)) {
                info.period = 'predicted';
                break;
            }
        }
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
        if (x.type === 'plan' && x.date >= cal.today && x.date <= end) out.push({ date: x.date, kind: 'plan', title: x.title });
        if (x.type === 'anniversary') {
            const d = nextAnniversary(x.date, cal.today);
            if (d <= end) out.push({ date: d, kind: 'anniversary', title: x.title });
        }
    }
    if (calTracked('period') && cal.next && cal.next > cal.today && cal.next <= end && !dayInfo(cal, cal.today).period) {
        out.push({ date: cal.next, kind: 'period' });
    }
    return out.map((x) => ({ ...x, in: daysBetween(cal.today, x.date) })).sort((a, b) => a.date.localeCompare(b.date));
}

/** 今天的生理期狀態：{ kind: 'during', day } | { kind: 'until', days, date } | { kind: 'late', days } | null。 */
export function periodStatus(cal) {
    if (!calTracked('period') || !cal.today) return null;
    const info = dayInfo(cal, cal.today);
    if (info.period === 'actual') return { kind: 'during', day: info.periodDay };
    if (!cal.next) return null;
    const d = daysBetween(cal.today, cal.next);
    return d >= 0 ? { kind: 'until', days: d, date: cal.next } : { kind: 'late', days: -d };
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
    if (p?.kind === 'during') lines.push(t('cal.inject.during', { user, day: p.day }));
    else if (p?.kind === 'until' && p.days <= (Number(s.ahead) || 7)) lines.push(t('cal.inject.until', { user, days: p.days, date: p.date.slice(5) }));
    else if (p?.kind === 'late') lines.push(t('cal.inject.late', { user, days: p.days }));
    const today = dayInfo(cal, cal.today);
    if (today.intimacy) lines.push(t('cal.inject.intimacy', { n: today.intimacy }));
    const list = upcoming(cal).filter((x) => x.kind !== 'period');
    if (list.length) {
        const parts = list.map((x) => {
            const when = x.in === 0 ? t('cal.today') : t('cal.inDays', { n: x.in });
            return `${x.date.slice(5)}（${when}）${x.kind === 'anniversary' ? t('cal.anniversaryOf', { title: x.title }) : x.title}`;
        });
        lines.push(t('cal.inject.upcoming', { list: parts.join('；') }));
    }
    return lines.join('\n');
}
