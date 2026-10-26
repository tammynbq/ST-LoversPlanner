// 約定／待辦的日期（使用者要求）：哪一天約定的（made）、預定哪一天做（due）。
//
// made：這條記事是在哪一層新增的，就用那一層的故事日期（entry.date，要開行事曆才有）；手動新增的用當時最新的故事日期。
// due：模型直接回報的 data.due（YYYY-MM-DD）；沒有的話，從「時間」欄位（沒有就從內容）推算：
//      今天／明天／後天／大後天、這週三／下週三／週六、三天後、10月21日、2026-10-21……
//      推算的標成 guessed，畫面上會註明。「明年秋天」這種沒有確切哪一天的就不算。

import { aiIndices, getEntry } from './chat.js';
import { addDays, normDate } from './calendar.js';

const DAY = { 今: 0, 明: 1 };
const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 七: 0 };
const NUM = { 一: 1, 兩: 2, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const EN_WEEKDAY = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function weekdayOf(date) {
    return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** 0 = 星期日 … 6 = 星期六。next：「下週X」（下一個星期一開始的那一週）；否則是最近的一個（今天也算）。 */
function nextWeekday(made, wd, next) {
    const today = weekdayOf(made);
    if (next) {
        // 下週一 = 今天之後的第一個星期一；下週X 從那天算起（週日當成一週最後一天）。
        const toMonday = ((1 - today + 7) % 7) || 7;
        return addDays(made, toMonday + ((wd + 6) % 7));
    }
    return addDays(made, (wd - today + 7) % 7);
}

function parseNum(s) {
    if (/^\d+$/.test(s)) return Number(s);
    if (s === '十') return 10;
    if (s.length === 2 && s[0] === '十') return 10 + (NUM[s[1]] ?? 0);
    return NUM[s] ?? null;
}

/** 從一段文字推算是哪一天（made：說這句話的那一天）。推算不出來回傳 ''。 */
export function guessDate(text, made) {
    const s = String(text ?? '');
    if (!s) return '';
    // 寫明的日期：2026-10-21、2026/10/21、2026年10月21日
    const full = s.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
    if (full) return normDate(`${full[1]}-${full[2]}-${full[3]}`);
    if (!normDate(made)) return '';
    // 10月21日／10月21號／10/21：年份用 made 的；已經過了就算明年。
    const md = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日號号]?/) ?? s.match(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/);
    if (md) {
        const year = Number(made.slice(0, 4));
        let d = normDate(`${year}-${md[1]}-${md[2]}`);
        if (d && d < made) d = normDate(`${year + 1}-${md[1]}-${md[2]}`);
        if (d) return d;
    }
    if (/大[後后]天/.test(s)) return addDays(made, 3);
    if (/[後后]天/.test(s)) return addDays(made, 2);
    const rel = s.match(/([今明])(?:天|日|早|晚|夜|晨|午|兒|儿)/);
    const after = s.match(/(\d+|[一兩两二三四五六七八九十]{1,2})\s*天[後后]/);
    if (after && parseNum(after[1]) !== null) return addDays(made, parseNum(after[1]));
    const wk = s.match(/(下|這|这|本)?\s*(?:個|个)?\s*(?:週|周|星期|禮拜|礼拜)\s*([一二三四五六日天七])/);
    if (wk) return nextWeekday(made, WEEKDAY[wk[2]], wk[1] === '下');
    if (rel) return addDays(made, DAY[rel[1]]);
    const lower = s.toLowerCase();
    if (/\bday after tomorrow\b/.test(lower)) return addDays(made, 2);
    if (/\btomorrow\b/.test(lower)) return addDays(made, 1);
    if (/\b(today|tonight)\b/.test(lower)) return made;
    const en = lower.match(/\b(next|this)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
    if (en) return nextWeekday(made, EN_WEEKDAY.indexOf(en[2]), en[1] === 'next');
    return '';
}

/** 目前故事裡的「今天」：最新一個有日期的樓層。沒有就是 null。 */
export function storyToday() {
    const list = aiIndices();
    for (let k = list.length - 1; k >= 0; k--) {
        const d = normDate(getEntry(list[k])?.date);
        if (d) return d;
    }
    return null;
}

/** 一條約定／待辦的日期：{ made, due, guessed, from: 'when'|'content'|null }（沒有就是空字串）。 */
export function noteDates(note) {
    if (!note || (note.type !== 'promise' && note.type !== 'todo')) return { made: '', due: '', guessed: false, from: null };
    const made = normDate(note.made) || (note.createdFloor !== null && note.createdFloor !== undefined ? normDate(getEntry(note.createdFloor)?.date) : '');
    const given = normDate(note.data?.due);
    if (given) return { made, due: given, guessed: false, from: null };
    const byWhen = guessDate(note.data?.when, made);
    if (byWhen) return { made, due: byWhen, guessed: true, from: 'when' };
    const byContent = guessDate(note.data?.content, made);
    return { made, due: byContent, guessed: Boolean(byContent), from: byContent ? 'content' : null };
}

/** 某一層的故事日期（沒寫就延續前面最近一個有日期的樓層）。 */
function floorDate(index) {
    const list = aiIndices().filter((i) => i <= index);
    for (let k = list.length - 1; k >= 0; k--) {
        const d = normDate(getEntry(list[k])?.date);
        if (d) return d;
    }
    return '';
}

/** 約定／待辦完成（或被打破）的故事日期：手動完成時記下的，或完成那一層的日期。 */
export function closedDateOf(note) {
    if (!note || note.state === 'active') return '';
    if (normDate(note.closedDate)) return normDate(note.closedDate);
    return note.closedFloor !== null && note.closedFloor !== undefined ? floorDate(note.closedFloor) : '';
}
