// 📦 舊聊天整理（v0.13.33，日記第一階段，使用者要求）：
//   不打開聊天（打開 3000 多則的聊天會卡），直接向酒館要聊天檔來讀，只讀資料、不畫訊息。
//   只列同一個角色的聊天。可以勾好幾個一起讀：照故事日期分天、列出每天多大（之後的階段才寫日記）；
//   順便找出生理期、親熱、紀念日，可以帶進現在的聊天。舊聊天檔完全不改。
// 日期：戀人手帳的單層摘要有 date 就用；沒有就借 Horae 的 horae_meta.timestamp.story_date；都沒有就跟著前一層。
// 分支聊天（前面的訊息一樣）：同一則訊息（send_date＋內容）只算一次。

import { ctx, MODULE } from './util.js';
import { hashText, isAiMessage, isUserMessage } from './chat.js';
import { normDate } from './calendar.js';
import { characterKey } from './scope.js';
import { cleanForSummary } from './filter.js';

/** 上次分析的每一天的內容（寫日記用，不存檔；重新整理後要再讀一次）。 */
let lastUnits = new Map();

/**
 * 某一天切好的段落：[{ part, total, units }]（每段最多 PART_FLOORS 個 AI 樓層，從使用者發言前切開）。
 * 沒讀過（或重新整理過）就回傳空陣列。
 */
export function dayParts(date) {
    const units = lastUnits.get(date) ?? [];
    const ai = units.filter((u) => u.ai).length;
    if (!ai) return [];
    const total = Math.max(1, Math.ceil(ai / PART_FLOORS));
    const per = Math.ceil(ai / total);
    const out = [];
    let cur = [];
    let n = 0;
    for (const u of units) {
        if (!u.ai && n >= per && out.length < total - 1) {
            out.push(cur);
            cur = [];
            n = 0;
        }
        cur.push(u);
        if (u.ai) n++;
    }
    if (cur.length) out.push(cur);
    return out.map((list, k) => ({ part: k + 1, total: out.length, units: list }));
}

export function hasLoadedDays() {
    return lastUnits.size > 0;
}

/** 一段最多幾個 AI 樓層（太長的一天切成幾段寫日記）。 */
export const PART_FLOORS = 17;
/** 日記大約每個 AI 樓層幾個字（自然版提示詞的設定），上下限是一段的。 */
const DIARY_PER_FLOOR = 24;
const DIARY_MIN = 180;
const DIARY_MAX = 960;

function headers() {
    return { ...(ctx()?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' }) };
}

async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

/** 目前這個聊天的 id（聊天檔名，不含 .jsonl）。 */
function currentChatId() {
    const c = ctx();
    return String(c?.getCurrentChatId?.() ?? c?.chatId ?? '');
}

/** 同一個角色的其他聊天：[{ id, size, items, last, preview }]，新的在前。 */
export async function listOldChats() {
    const avatar = characterKey();
    if (!avatar) return [];
    const list = await post('/api/characters/chats', { avatar_url: avatar });
    if (!Array.isArray(list)) throw new Error('bad response');
    const current = currentChatId();
    return list
        .map((x) => ({
            id: String(x.file_id ?? String(x.file_name ?? '').replace(/\.jsonl$/, '')),
            size: x.file_size ?? '',
            items: Number(x.chat_items) || 0,
            last: x.last_mes ?? '',
            preview: String(x.mes ?? '').slice(0, 60),
        }))
        .filter((x) => x.id && x.id !== current)
        .sort((a, b) => (Number(new Date(b.last)) || Number(b.last) || 0) - (Number(new Date(a.last)) || Number(a.last) || 0));
}

/** 讀一個聊天檔（整個陣列，第一筆通常是聊天資訊和 chat_metadata）。 */
export async function loadOldChat(id) {
    const c = ctx();
    const ch = c?.characters?.[c.characterId];
    const data = await post('/api/chats/get', { ch_name: ch?.name ?? c?.name2 ?? '', file_name: id, avatar_url: characterKey() });
    if (!Array.isArray(data) || !data.length) throw new Error('empty chat');
    return data;
}

/** Horae 記的故事日期（格式很亂：2025/12/14 08:42（星期日）、2026/9/14 (一)）。 */
function horaeDate(m) {
    const s = (m?.horae_meta ?? m?.extra?.horae_meta)?.timestamp?.story_date;
    const x = String(s ?? '').match(/(\d{4})\s*[/\-年.]\s*(\d{1,2})\s*[/\-月.]\s*(\d{1,2})/);
    return x ? normDate(`${x[1]}-${x[2].padStart(2, '0')}-${x[3].padStart(2, '0')}`) : '';
}

const EVENT_TYPES = ['period', 'intimacy', 'anniversary'];

function plainEvent(ev, date, origin) {
    return {
        type: ev.type,
        date,
        ...(ev.title ? { title: String(ev.title) } : {}),
        ...(ev.state ? { state: ev.state } : {}),
        ...(ev.count ? { count: Number(ev.count) || 1 } : {}),
        origin,
    };
}

/**
 * 分析讀到的聊天（照勾選的順序，舊的先）。
 * loaded：[{ id, data }]。回傳 { chats, days, totals, calendar, overlaps }。
 */
export function analyzeChats(loaded) {
    const seen = new Set();
    const days = new Map();
    const day = (date) => {
        if (!days.has(date)) days.set(date, { date, ai: 0, user: 0, summarized: 0, coarse: 0, side: 0, rawChars: 0, sumChars: 0, chats: new Set(), units: [], sendChars: 0 });
        return days.get(date);
    };
    const totals = { ai: 0, summarized: 0, unsummarized: 0, undated: 0, skipped: 0, side: 0, duplicates: 0, horae: 0 };
    const events = [];
    const chats = [];
    for (const { id, data } of loaded) {
        const header = data[0] && !('mes' in data[0]) ? data[0] : null;
        const messages = header ? data.slice(1) : data;
        const meta = header?.chat_metadata?.[MODULE] ?? {};
        const removed = new Set(meta.calendar?.removed ?? []);
        const info = { id, ai: 0, firstDate: '', lastDate: '' };
        let cur = '';
        for (const m of messages) {
            if (!isAiMessage(m) && !isUserMessage(m)) continue;
            const key = `${m.send_date ?? ''}|${hashText(m.mes ?? '')}`;
            if (seen.has(key)) {
                if (isAiMessage(m)) totals.duplicates++;
                continue;
            }
            seen.add(key);
            const e = m.extra?.[MODULE];
            if (isAiMessage(m)) {
                const own = normDate(e?.date);
                const h = own ? '' : horaeDate(m);
                if (own || h) cur = own || h;
                if (!own && h) totals.horae++;
            }
            const d = day(cur);
            const text = cleanForSummary(m.mes ?? '');
            const raw = text.length;
            if (isUserMessage(m)) {
                d.user++;
                d.rawChars += raw;
                d.units.push({ ai: false, name: m.name ?? '', text });
                d.sendChars += raw;
                continue;
            }
            info.ai++;
            totals.ai++;
            if (cur) {
                if (!info.firstDate || cur < info.firstDate) info.firstDate = cur;
                if (!info.lastDate || cur > info.lastDate) info.lastDate = cur;
            } else totals.undated++;
            if (e?.status === 'skip') {
                totals.skipped++;
                continue;
            }
            if (e?.status === 'side') {
                totals.side++;
                d.side++;
                continue;
            }
            d.ai++;
            d.rawChars += raw;
            d.chats.add(id);
            // 寫日記用：有單層摘要（不是粗略補建）就用摘要，沒有就用原文。
            const time = e?.time || (m?.horae_meta ?? m?.extra?.horae_meta)?.timestamp?.story_time || '';
            const summary = e?.status === 'ok' && !e.coarse && e.summary ? String(e.summary) : '';
            d.units.push({ ai: true, name: m.name ?? '', text, summary, time: String(time) });
            d.sendChars += summary ? summary.length : raw;
            if (e?.status === 'ok' && (e.summary || e.coarse)) {
                d.summarized++;
                totals.summarized++;
                if (e.coarse) d.coarse++;
                d.sumChars += String(e.summary ?? '').length;
            } else totals.unsummarized++;
            (Array.isArray(e?.events) ? e.events : []).forEach((ev, k) => {
                if (!EVENT_TYPES.includes(ev?.type)) return;
                const evKey = `${m.send_date ?? ''}#${k}`;
                if (removed.has(evKey)) return;
                const date = ev.type === 'anniversary' ? String(ev.date ?? '') : cur;
                if (!date) return;
                events.push(plainEvent(ev, date, `${id}#${evKey}`));
            });
        }
        for (const ev of meta.calendar?.manual ?? []) {
            if (EVENT_TYPES.includes(ev?.type) && ev.date) events.push(plainEvent(ev, ev.date, `${id}#${ev.id}`));
        }
        for (const ev of meta.calendar?.carried ?? []) if (EVENT_TYPES.includes(ev?.type) && ev.origin) events.push({ ...ev });
        chats.push(info);
    }
    lastUnits = new Map([...days.values()].map((d) => [d.date, d.units]));
    const list = [...days.values()]
        .filter((d) => d.ai || d.side)
        .map((d) => {
            const parts = Math.max(1, Math.ceil(d.ai / PART_FLOORS));
            const per = d.ai ? Math.ceil(d.ai / parts) : 0;
            const diary = d.ai ? parts * Math.max(DIARY_MIN, Math.min(DIARY_MAX, per * DIARY_PER_FLOOR)) : 0;
            return { date: d.date, ai: d.ai, user: d.user, summarized: d.summarized, coarse: d.coarse, side: d.side, rawChars: d.rawChars, sumChars: d.sumChars, sendChars: d.sendChars, parts, diary, chats: [...d.chats] };
        })
        .sort((a, b) => (a.date ? (b.date ? a.date.localeCompare(b.date) : -1) : 1));
    // 同一個 origin 只留一筆（帶來帶去的）。
    const byOrigin = new Map();
    for (const ev of events) if (!byOrigin.has(ev.origin)) byOrigin.set(ev.origin, ev);
    const calendar = [...byOrigin.values()];
    return {
        chats,
        days: list,
        totals: { ...totals, days: list.filter((d) => d.date && d.ai).length, diary: list.reduce((n, d) => n + d.diary, 0), raw: list.reduce((n, d) => n + d.rawChars, 0) },
        calendar: {
            items: calendar,
            period: calendar.filter((x) => x.type === 'period' && x.state === 'start').length,
            intimacy: calendar.filter((x) => x.type === 'intimacy').reduce((n, x) => n + (Number(x.count) || 1), 0),
            anniversary: calendar.filter((x) => x.type === 'anniversary').length,
        },
        // 同一天有好幾個聊天都寫到（可能是 IF 線、平行世界）。
        overlaps: list.filter((d) => d.date && d.chats.length > 1).map((d) => d.date),
    };
}
