// 小彩蛋（v0.13.31，使用者說「都可以」）：
//   ① 那年今日：故事裡的「今天」碰到一年前的同一天（沒有的話，回憶錄裡幾個月前的同一天）→ 大視窗最上面一張小卡片。
//   ② 紀念日花瓣：故事裡的今天是紀念日／生日 → 標題列下面寫今天是什麼日子，打開大視窗時飄一陣花瓣（每天一次）。
//   ③ 里程碑：AI 樓層到 100、500、1000…層 → 跳一個小慶祝（每個聊天每個里程碑一次；第一次打開時已經超過的不補）。
//   ④ 隱藏彩蛋：連點大視窗左上角的📔五下 → 冒愛心，從回憶錄抽一條。
// 都不呼叫模型。狀態存在 chat_metadata.lovers_planner.eggs。

import { ctx, LOG_PREFIX, MODULE, toast } from './util.js';
import { t } from './i18n.js';
import { aiIndices, getEntry } from './chat.js';
import { storyToday } from './notedates.js';
import { listMemories, memoriesOn, surfaceNext } from './memories.js';
import { buildCalendar, calendarOn, dayInfo, normDate, onCalendarChange } from './calendar.js';

export const MILESTONES = [100, 500, 1000, 2000, 3000, 5000, 10000];

function eggs(create) {
    const meta = ctx()?.chatMetadata;
    if (!meta) return null;
    if (!meta[MODULE] && create) meta[MODULE] = {};
    const rec = meta[MODULE];
    if (rec && !rec.eggs && create) rec.eggs = {};
    return rec?.eggs ?? null;
}

function save() {
    const c = ctx();
    try {
        if (typeof c?.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
        else c?.saveMetadata?.();
    } catch (e) { /* 忽略 */ }
}

const monthsBetween = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

/**
 * ① 那年今日。回傳 { date, years?, months?, title, text, memKey? } 或 null（沒有、或今天已經收起來了）。
 * 先找一年（或更多年）前同一天的回憶和摘要；都沒有才找回憶錄裡幾個月前的同一天。
 */
export function onThisDay() {
    const today = storyToday();
    if (!today || eggs(false)?.onDay === today) return null;
    const md = today.slice(5);
    const mems = memoriesOn() ? listMemories().map((m) => ({ ...m, d: normDate(m.date) })).filter((m) => m.d && m.d < today) : [];
    const yearly = mems.filter((m) => m.d.slice(5) === md).sort((a, b) => a.d.localeCompare(b.d))[0];
    if (yearly) return { date: yearly.d, years: Number(today.slice(0, 4)) - Number(yearly.d.slice(0, 4)), title: yearly.title, text: yearly.content, memKey: yearly.key };
    for (const i of aiIndices()) {
        const e = getEntry(i);
        const d = normDate(e?.date);
        if (e?.status === 'ok' && e.summary && d && d < today && d.slice(5) === md) {
            return { date: d, years: Number(today.slice(0, 4)) - Number(d.slice(0, 4)), title: '', text: e.summary };
        }
    }
    // 一年以上的只在同月同日時算（上面），這裡只看一到十一個月前。
    const monthly = mems.filter((m) => m.d.slice(8) === today.slice(8) && monthsBetween(m.d, today) >= 1 && monthsBetween(m.d, today) <= 11).sort((a, b) => a.d.localeCompare(b.d))[0];
    if (monthly) return { date: monthly.d, months: monthsBetween(monthly.d, today), title: monthly.title, text: monthly.content, memKey: monthly.key };
    return null;
}

export function dismissOnThisDay() {
    const today = storyToday();
    if (!today) return;
    eggs(true).onDay = today;
    save();
}

/** 「讓角色想起」：下一回一定提起這條回憶（用回憶錄原本的「下次提起」）。 */
export function remindOnThisDay(memKey) {
    surfaceNext(memKey);
    dismissOnThisDay();
}

/** ② 今天的紀念日（標題）；沒有就是空陣列。大視窗每次重畫都會問，算一次記 3 秒（長聊天的行事曆不便宜）。 */
let annCache = null;
onCalendarChange(() => { annCache = null; });
export function anniversariesToday() {
    const today = storyToday();
    if (!today || !calendarOn()) return [];
    const key = `${ctx()?.chatId ?? ''}|${today}`;
    if (annCache && annCache.key === key && Date.now() - annCache.at < 3000) return annCache.list;
    let list = [];
    try {
        list = dayInfo(buildCalendar(), today).anniversaries.map((x) => x.title).filter(Boolean);
    } catch (e) { /* 行事曆算不出來就當沒有 */ }
    annCache = { key, at: Date.now(), list };
    return list;
}

/** 今天要不要飄花瓣（每個故事日一次；問過就記下來）。 */
export function takePetals() {
    const today = storyToday();
    if (!today || eggs(false)?.petals === today || !anniversariesToday().length) return false;
    const rec = eggs(true);
    rec.petals = today;
    save();
    return true;
}

/**
 * ③ 新的回覆存好後檢查里程碑。回傳這次達到的里程碑（沒有就是 0）。
 * 第一次檢查時已經超過的里程碑直接記下來，不補慶祝。
 */
export function takeMilestone() {
    const n = aiIndices().length;
    const reached = MILESTONES.filter((m) => n >= m).pop() ?? 0;
    const rec = eggs(true);
    if (rec.milestone === undefined) {
        rec.milestone = reached;
        save();
        return 0;
    }
    if (reached <= rec.milestone) return 0;
    rec.milestone = reached;
    save();
    return reached;
}

/** 故事從哪一天開始（第一個有日期的 AI 樓層）。 */
export function storyStart() {
    for (const i of aiIndices()) {
        const d = normDate(getEntry(i)?.date);
        if (d) return d;
    }
    return '';
}

/** ④ 隨機抽一條回憶。 */
export function randomMemory() {
    const list = memoriesOn() ? listMemories() : [];
    return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

/** 飄花瓣／冒愛心：在 host 上蓋一層，幾秒後自己拿掉。系統設定「減少動態效果」時不飄。 */
export function burst(host, symbols, { count = 18, up = false } = {}) {
    if (!host || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const layer = document.createElement('div');
    layer.className = `lp-burst${up ? ' lp-burst-up' : ''}`;
    layer.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < count; i++) {
        const s = document.createElement('span');
        s.textContent = symbols[i % symbols.length];
        s.style.left = `${Math.round(Math.random() * 92) + 2}%`;
        s.style.animationDelay = `${(Math.random() * 1.2).toFixed(2)}s`;
        s.style.animationDuration = `${(2.6 + Math.random() * 1.6).toFixed(2)}s`;
        s.style.fontSize = `${14 + Math.round(Math.random() * 14)}px`;
        layer.appendChild(s);
    }
    host.appendChild(layer);
    setTimeout(() => layer.remove(), 5200);
}

export function initEggs() {
    const c = ctx();
    if (!c?.eventSource || !c.eventTypes) return;
    // 打開聊天時先記下已經到的里程碑（不補慶祝）。
    const baseline = () => { try { takeMilestone(); } catch (e) { console.error(LOG_PREFIX, e); } };
    c.eventSource.on(c.eventTypes.CHAT_CHANGED, baseline);
    baseline();
    c.eventSource.on(c.eventTypes.MESSAGE_RECEIVED, () => {
        try {
            const n = takeMilestone();
            if (!n) return;
            const since = storyStart();
            toast(since ? t('egg.milestoneSince', { n, date: since }) : t('egg.milestone', { n }), 'success');
            burst(document.body, ['🎉', '💕', '✨', '🌸'], { count: 24 });
        } catch (e) {
            console.error(LOG_PREFIX, e);
        }
    });
}
