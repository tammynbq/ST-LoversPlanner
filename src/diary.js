// 📖 日記（v0.13.34，日記第二階段）：把舊聊天整理讀到的每一天寫成一篇日記（太長的一天分段寫）。
// 寫法：自然（v6，像回憶，預設）或精簡（v5，像紀錄），提示詞可以在設定 › 進階改。OOC 不寫進日記。
// 再壓一次：先勾要留的重點、選壓到多少；原版一直留著，可以換回來。壓到一半以下會提醒。
// 存在目前聊天的 chat_metadata.lovers_planner.diary.days[日期]：
//   { date, parts: [{ part, total, floors, summary, points, time, location, at, by, style, error? }],
//     compressed: { summary, at, by, ratio, keep, from } | null, use: 'original' | 'compressed' }
// 寫日記要用到舊聊天的內容（oldchats.dayParts），重新整理後要再讀一次舊聊天；再壓一次只用日記本身。
// 送給角色的方式是第三階段。

import { ctx, LOG_PREFIX, MODULE } from './util.js';
import { getSettings } from './settings.js';
import { t } from './i18n.js';
import { getTemplate } from './prompts.js';
import { generateText, modelLabel } from './llm.js';
import { parseJsonLenient } from './json.js';
import { ApiError } from './api/custom.js';
import { dayParts } from './oldchats.js';
import { dropTasks, enqueueTask, queuedTasks } from './summarize.js';

export const TASK = 'diary';
/** 再壓一次可以選的比例；低於 MIN_SAFE_RATIO 會提醒（測試：壓到一半以下，中等的事大多會不見）。 */
export const RATIOS = [0.7, 0.5, 0.3];
export const MIN_SAFE_RATIO = 0.5;

const listeners = new Set();
export function onDiaryChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
function emit() {
    for (const fn of listeners) {
        try { fn(); } catch (e) { console.error(LOG_PREFIX, e); }
    }
}

function record(create) {
    const meta = ctx()?.chatMetadata;
    if (!meta) return null;
    if (!meta[MODULE] && create) meta[MODULE] = {};
    const rec = meta[MODULE];
    if (rec && !rec.diary && create) rec.diary = { days: {}, sources: [] };
    return rec?.diary ?? null;
}

function saveMeta() {
    const c = ctx();
    try {
        if (typeof c?.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
        else c?.saveMetadata?.();
    } catch (e) { /* 忽略 */ }
    emit();
}

export function diaryStyle() {
    return getSettings().diary?.style === 'concise' ? 'concise' : 'natural';
}

/** 一段的目標字數（自然版每層約 24 字，精簡版約 20 字）。 */
export function partLength(floors, style = diaryStyle()) {
    return style === 'concise' ? Math.max(150, Math.min(800, floors * 20)) : Math.max(180, Math.min(960, floors * 24));
}

function fill(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

function names() {
    const c = ctx();
    return { char: c?.name2 ?? '', user: c?.name1 ?? '' };
}

/** 一段的內容：使用者發言用原文；AI 樓層有單層摘要就用摘要（標［摘要］），沒有就用原文。 */
export function partContent(units) {
    const tag = t('diary.summaryTag');
    return units.map((u) => {
        const time = u.time ? `（${u.time}）` : '';
        if (u.ai && u.summary) return `【${u.name}】${tag}${time}\n${u.summary}`;
        return `【${u.name}】${u.ai ? time : ''}\n${u.text}`;
    }).join('\n\n');
}

export function buildDiaryPrompt(date, p, style = diaryStyle()) {
    const floors = p.units.filter((u) => u.ai).length;
    const length = partLength(floors, style);
    const { char, user } = names();
    const prompt = fill(getTemplate(style === 'concise' ? 'diaryConcise' : 'diary'), {
        char, user, date,
        part: p.total > 1 ? t('diary.partLabel', { k: p.part, n: p.total }) : '',
        length, max: Math.round(length * 1.25), content: partContent(p.units),
    });
    return { prompt, length, floors };
}

/** 模型回的 points：「重大｜…」→ { level: 'major'|'minor', text }。 */
export function parsePoints(list) {
    return (Array.isArray(list) ? list : []).map((x) => {
        const s = String(x ?? '').trim();
        const m = s.match(/^(重大|中等|major|minor)\s*[｜|:：]\s*(.+)$/i);
        if (!m) return s ? { level: 'minor', text: s } : null;
        return { level: /重大|major/i.test(m[1]) ? 'major' : 'minor', text: m[2].trim() };
    }).filter(Boolean);
}

function parseDiary(raw) {
    const r = parseJsonLenient(raw, { accept: (o) => typeof o?.summary === 'string' });
    const v = r?.value;
    if (!v || typeof v.summary !== 'string' || !v.summary.trim()) throw new ApiError('parse', t('diary.parseFail'));
    return v;
}

/** 寫一段（隊伍裡跑）。讀不到內容（重新整理過）就記成失敗，請使用者再讀一次舊聊天。 */
async function writePart(date, partNo, style) {
    const p = dayParts(date).find((x) => x.part === partNo);
    const rec = record(true);
    const day = rec.days[date] ?? (rec.days[date] = { date, parts: [], compressed: null, use: 'original' });
    if (!p) {
        day.parts[partNo - 1] = { ...(day.parts[partNo - 1] ?? { part: partNo }), error: t('diary.needReload') };
        saveMeta();
        return;
    }
    const { prompt, length, floors } = buildDiaryPrompt(date, p, style);
    try {
        const raw = await generateText(prompt, { maxTokens: Math.max(1024, length * 3), purpose: 'diary' });
        const v = parseDiary(raw);
        day.parts.length = p.total;
        day.parts[partNo - 1] = {
            part: partNo, total: p.total, floors,
            summary: v.summary.trim(), points: parsePoints(v.points),
            time: String(v.time ?? ''), location: String(v.location ?? ''),
            at: Date.now(), by: modelLabel(), style,
        };
        // 改了內容，舊的壓縮版就不對了。
        day.compressed = null;
        day.use = 'original';
    } catch (e) {
        console.warn(LOG_PREFIX, '寫日記失敗', date, partNo, e);
        day.parts[partNo - 1] = { ...(day.parts[partNo - 1] ?? { part: partNo, total: p.total, floors }), error: e?.message || String(e) };
    }
    saveMeta();
}

/** 一天寫好了沒有：'done' | 'partial' | 'error' | 'none'。 */
export function dayState(date) {
    const day = record(false)?.days?.[date];
    if (!day?.parts?.length) return 'none';
    const total = day.parts[0]?.total ?? day.parts.length;
    const ok = day.parts.filter((p) => p?.summary && !p.error).length;
    if (day.parts.some((p) => p?.error)) return 'error';
    return ok >= total ? 'done' : 'partial';
}

/**
 * 把這幾天排進隊伍。rewrite：已經寫好的也重寫（例如換寫法）；否則只寫還沒寫的段。
 * 回傳排了幾段。
 */
export function queueDays(dates, { style = diaryStyle(), rewrite = false } = {}) {
    let n = 0;
    const rec = record(true);
    rec.style = style;
    for (const date of dates) {
        const parts = dayParts(date);
        for (const p of parts) {
            const have = rec.days?.[date]?.parts?.[p.part - 1];
            if (!rewrite && have?.summary && !have.error && have.total === p.total) continue;
            if (enqueueTask(() => writePart(date, p.part, style), { label: TASK })) n++;
        }
    }
    return n;
}

export function pauseDiary() {
    dropTasks(TASK);
    emit();
}

export function diaryPending() {
    return queuedTasks(TASK);
}

export function setSources(ids) {
    const rec = record(true);
    rec.sources = [...new Set([...(rec.sources ?? []), ...ids])];
    saveMeta();
}

/** 這一天現在用的日記全文（壓縮版或原版）。 */
export function dayText(day, which = day?.use) {
    if (which === 'compressed' && day?.compressed?.summary) return day.compressed.summary;
    return (day?.parts ?? []).filter((p) => p?.summary).map((p) => p.summary).join('\n');
}

/** 全部的日記，照日期排：[{ date, state, parts, points, original, compressed, use, chars }]。 */
export function listDiary() {
    const days = record(false)?.days ?? {};
    return Object.values(days).map((d) => {
        const points = (d.parts ?? []).flatMap((p) => p?.points ?? []);
        const original = dayText(d, 'original');
        return {
            date: d.date, state: dayState(d.date), parts: d.parts ?? [], points, original,
            compressed: d.compressed ?? null, use: d.compressed?.summary && d.use === 'compressed' ? 'compressed' : 'original',
            chars: dayText(d).length, errors: (d.parts ?? []).filter((p) => p?.error).map((p) => p.error),
            style: d.parts?.find((p) => p?.style)?.style ?? '',
        };
    }).sort((a, b) => (a.date ? (b.date ? a.date.localeCompare(b.date) : -1) : 1));
}

export function diarySources() {
    return record(false)?.sources ?? [];
}

// ===== 再壓一次 =====

export function buildCompressPrompt(date, { ratio = MIN_SAFE_RATIO, keep = null } = {}) {
    const day = record(false)?.days?.[date];
    const original = dayText(day, 'original');
    const points = (day?.parts ?? []).flatMap((p) => p?.points ?? []);
    const kept = keep ? points.filter((_, i) => keep.includes(i)) : points;
    const length = Math.max(60, Math.round(original.length * ratio));
    const { char, user } = names();
    const prompt = fill(getTemplate('diaryCompress'), {
        char, user, date, length, max: Math.round(length * 1.2),
        points: kept.map((p) => `- ${p.level === 'major' ? t('diary.major') : t('diary.minor')}｜${p.text}`).join('\n') || t('diary.noPoints'),
        diary: original,
        style: diaryStyle() === 'natural' ? t('diary.compressNatural') : '',
    });
    return { prompt, length, from: original.length, kept };
}

/** 再壓一次（排進隊伍）。keep：要留的重點（points 的索引）；沒給就全部留。 */
export function compressDay(date, opts = {}) {
    return enqueueTask(async () => {
        const rec = record(true);
        const day = rec.days?.[date];
        if (!day) return;
        const { prompt, length, from, kept } = buildCompressPrompt(date, opts);
        try {
            const raw = await generateText(prompt, { maxTokens: Math.max(1024, length * 3), purpose: 'diaryCompress' });
            const v = parseDiary(raw);
            day.compressed = { summary: v.summary.trim(), at: Date.now(), by: modelLabel(), ratio: opts.ratio ?? MIN_SAFE_RATIO, keep: kept.map((p) => p.text), from };
            day.use = 'compressed';
            day.compressError = '';
        } catch (e) {
            console.warn(LOG_PREFIX, '再壓一次失敗', date, e);
            day.compressError = e?.message || String(e);
        }
        saveMeta();
    }, { label: TASK });
}

/** 用原版或壓縮版。 */
export function useVersion(date, which) {
    const day = record(false)?.days?.[date];
    if (!day) return;
    day.use = which === 'compressed' && day.compressed?.summary ? 'compressed' : 'original';
    saveMeta();
}

export function dropCompressed(date) {
    const day = record(false)?.days?.[date];
    if (!day) return;
    day.compressed = null;
    day.use = 'original';
    saveMeta();
}

export function deleteDay(date) {
    const rec = record(false);
    if (!rec?.days?.[date]) return;
    delete rec.days[date];
    saveMeta();
}

/** 手動修改一天的日記：有在用壓縮版就改壓縮版；不然幾段併成一篇（重點留著）。 */
export function editDay(date, text) {
    const day = record(false)?.days?.[date];
    const value = String(text ?? '').trim();
    if (!day || !value) return false;
    if (day.use === 'compressed' && day.compressed) {
        day.compressed.summary = value;
    } else {
        const parts = day.parts.filter(Boolean);
        day.parts = [{
            part: 1, total: 1, floors: parts.reduce((n, p) => n + (p.floors ?? 0), 0), summary: value,
            points: parts.flatMap((p) => p.points ?? []), time: parts[0]?.time ?? '', location: parts[0]?.location ?? '',
            at: Date.now(), by: 'manual', style: parts[0]?.style ?? diaryStyle(),
        }];
        day.compressed = null;
        day.use = 'original';
    }
    saveMeta();
    return true;
}
