// L2／L3 分層壓縮：已經被隱藏的舊樓層，每 N 層連續的摘要壓成一章（L2），每 M 章壓成一卷（L3）。
//
// 存在 chat_metadata.lovers_planner：
//   chapters: [{ id, members: [send_date…], memberIdx: [index…], memberAts: [entry.at…],
//                time, location, summary, status: 'ok'|'fail', error?, at, manual? }]
//   volumes:  [{ id, level, chapterIds: [id…], chapterAts: [at…], time, location, summary, status, error?, at, manual? }]
//             level 3＝卷（成員是章）；level 4＝部、5 以上＝紀（成員是下一層的 volume）。沒有 level 的是舊資料，當作 3。
//             chapterIds／chapterAts 名字沿用舊的，存的是「下一層成員」的 id 和 at。
// 用 send_date 認樓層（刪掉訊息後索引會位移）；memberIdx 只是找不到時的提示。
// 成員的摘要被改過（entry.at 變了）、不再是「已摘要」或訊息不見了，那一章就是「過期」；
// 過期的章不注入，改回注入那幾層的單層摘要。卷也一樣。

import { ctx, LOG_PREFIX, MODULE, toast } from './util.js';
import { getSettings } from './settings.js';
import { currentLocale, t } from './i18n.js';
import { getTemplate } from './prompts.js';
import { ApiError } from './api/custom.js';
import { generateText } from './llm.js';
import { errorText } from './errors.js';
import { getChat, getEntry, isAiMessage } from './chat.js';
import { sceneLine } from './lines.js';
import { enqueueCompress, floorState, isActive, previousDate, setAfterSummaryHook, setCompressHandler } from './summarize.js';
import { normDate } from './calendar.js';
import { computeHidden } from './hide.js';

function record(create) {
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

export function getChapters() {
    const list = record(false)?.chapters;
    return Array.isArray(list) ? list : [];
}

export function getVolumes() {
    const list = record(false)?.volumes;
    return Array.isArray(list) ? list : [];
}

function newId(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 依 send_date 找回樓層索引；同一個 send_date 有好幾則時，選離提示最近的。 */
function indexFinder() {
    const bySend = new Map();
    getChat().forEach((m, i) => {
        if (!isAiMessage(m)) return;
        const key = m.send_date ?? `#${i}`;
        if (!bySend.has(key)) bySend.set(key, []);
        bySend.get(key).push(i);
    });
    return (sendDate, hint) => {
        const list = bySend.get(sendDate ?? `#${hint}`);
        if (!list?.length) return -1;
        return list.reduce((best, i) => (Math.abs(i - hint) < Math.abs(best - hint) ? i : best), list[0]);
    };
}

function sendDateOf(index) {
    return getChat()[index]?.send_date ?? `#${index}`;
}

/**
 * 整理出目前的章和卷（含狀態和編號），以及哪些樓層已經被「有效的章」涵蓋。
 * 回傳 { chapters: [{ data, indices, state, number }], volumes: [{ data, chapters, state, number }],
 *        covered: Set<樓層>, claimed: Set<樓層>, coveredChapters: Set<章 id>, claimedChapters: Set<章 id> }
 */
export function structure() {
    const find = indexFinder();
    const chapters = getChapters().map((data) => {
        const indices = (data.members ?? []).map((sd, k) => find(sd, data.memberIdx?.[k] ?? 0));
        let state = data.status === 'fail' ? 'fail' : 'ok';
        if (state === 'ok') {
            const broken = indices.some((i, k) => i < 0 || floorState(i) !== 'ok' || getEntry(i)?.at !== data.memberAts?.[k]);
            if (broken) state = 'stale';
        }
        return { data, indices, state, number: 0 };
    }).sort((a, b) => (Math.min(...a.indices.filter((i) => i >= 0), Infinity)) - (Math.min(...b.indices.filter((i) => i >= 0), Infinity)));
    chapters.forEach((c, k) => { c.number = k + 1; });
    const byId = new Map(chapters.map((c) => [c.data.id, c]));

    // 卷以上：由低到高一層一層算，成員是下一層（章或較低層的卷）。
    const all = getVolumes().map((data) => ({ data, level: Math.max(3, Number(data.level) || 3) }));
    const levels = [...new Set(all.map((x) => x.level))].sort((a, b) => a - b);
    const volById = new Map();
    const volumes = [];
    for (const level of levels) {
        const list = all.filter((x) => x.level === level).map(({ data }) => {
            const children = (data.chapterIds ?? []).map((id) => (level === 3 ? byId.get(id) : volById.get(id)));
            let state = data.status === 'fail' ? 'fail' : 'ok';
            if (state === 'ok') {
                const broken = children.some((c, k) => !c || c.state !== 'ok' || c.data.at !== data.chapterAts?.[k]);
                if (broken) state = 'stale';
            }
            const kids = children.filter(Boolean);
            // chapters：底下所有的章（舊程式碼用 v.chapters 找樓層範圍）。
            const chapters = level === 3 ? kids : kids.flatMap((c) => c.chapters);
            return { data, level, children: kids, chapters, state, number: 0 };
        });
        const first = (v) => Math.min(...v.chapters.flatMap((c) => c.indices).filter((i) => i >= 0), Infinity);
        list.sort((a, b) => first(a) - first(b));
        list.forEach((v, k) => { v.number = k + 1; volById.set(v.data.id, v); });
        volumes.push(...list);
    }

    const covered = new Set();
    const claimed = new Set();
    for (const c of chapters) {
        for (const i of c.indices) {
            if (i < 0) continue;
            claimed.add(i);
            if (c.state === 'ok') covered.add(i);
        }
    }
    // 章被有效的卷涵蓋；卷被有效的更高一層涵蓋（注入時只送最上層有效的）。
    const coveredChapters = new Set();
    const claimedChapters = new Set();
    const coveredVolumes = new Set();
    const claimedVolumes = new Set();
    for (const v of volumes) {
        for (const c of v.children) {
            if (v.level === 3) {
                claimedChapters.add(c.data.id);
                if (v.state === 'ok') coveredChapters.add(c.data.id);
            } else {
                claimedVolumes.add(c.data.id);
                if (v.state === 'ok') coveredVolumes.add(c.data.id);
            }
        }
    }
    return { chapters, volumes, covered, claimed, coveredChapters, claimedChapters, coveredVolumes, claimedVolumes };
}

/** 到期要壓成一章的樓層：從最舊的未壓縮樓層開始，連續 N 層已摘要（跳過的不算、遇到沒摘要好的就停）。 */
export function dueChapterFloors(st = structure()) {
    const n = Number(getSettings().compress.l1PerL2) || 10;
    const { keepFrom } = computeHidden();
    const chat = getChat();
    const picked = [];
    for (let i = 0; i < keepFrom; i++) {
        if (!isAiMessage(chat[i])) continue;
        // 已經在某一章裡（例如使用者多選壓的）：斷開，不要跨過它和後面的樓層湊成一章。
        if (st.claimed.has(i)) {
            picked.length = 0;
            continue;
        }
        const state = floorState(i);
        if (state === 'skip') continue;
        // 粗略補建的樓層沒有單層摘要，不能拿來合併。
        if (state !== 'ok' || getEntry(i)?.coarse) return null;
        picked.push(i);
        if (picked.length === n) return picked;
    }
    return null;
}

/**
 * 使用者多選的樓層能不能壓成一章（v0.12.6，使用者要求）。
 * 要至少 2 層、都已摘要（粗略補建的不行）、都還不在任何章裡，而且是連續的：
 * 中間沒選到的樓層只能是「跳過」的，或已經在別的章裡。
 * 回傳 { floors } 或 { error: 'few' | 'state' | 'claimed' | 'gap' }。
 */
export function checkManualChapter(indices, st = structure()) {
    const chat = getChat();
    const floors = [...new Set(indices)].filter((i) => isAiMessage(chat[i])).sort((a, b) => a - b);
    if (floors.length < 2) return { error: 'few' };
    if (floors.some((i) => st.claimed.has(i))) return { error: 'claimed' };
    if (floors.some((i) => floorState(i) !== 'ok' || getEntry(i)?.coarse)) return { error: 'state' };
    const picked = new Set(floors);
    for (let i = floors[0]; i < floors[floors.length - 1]; i++) {
        if (!isAiMessage(chat[i]) || picked.has(i) || st.claimed.has(i)) continue;
        if (floorState(i) !== 'skip') return { error: 'gap' };
    }
    return { floors };
}

/** 把多選的樓層排進佇列壓成一章。回傳 checkManualChapter 的結果。 */
export function compressSelected(indices) {
    const res = checkManualChapter(indices);
    if (res.floors) enqueueCompress({ floors: res.floors });
    return res;
}

/**
 * 到期要往上壓一層的：從 L3 開始，找最低一層「連續 N 個有效、還沒被收進上一層」的成員。
 * 回傳 { level: 要產生的層級, items } 或 null。L3 每 l2PerL3 章一卷；L4 以上每 higherPer 個一組。
 */
export function dueVolumeGroup(st = structure()) {
    const c = getSettings().compress;
    const maxLevel = Math.max(3, ...st.volumes.map((v) => v.level)) + 1;
    for (let level = 3; level <= maxLevel; level++) {
        const m = level === 3 ? (Number(c.l2PerL3) || 5) : (Number(c.higherPer) || 5);
        const pool = level === 3
            ? st.chapters.filter((x) => !st.claimedChapters.has(x.data.id))
            : st.volumes.filter((v) => v.level === level - 1 && !st.claimedVolumes.has(v.data.id));
        const picked = [];
        for (const x of pool) {
            if (x.state !== 'ok') break;
            picked.push(x);
            if (picked.length === m) return { level, items: picked };
        }
    }
    return null;
}

/** 舊名字：到期要壓成一卷的章（只看 L3）。 */
export function dueVolumeChapters(st = structure()) {
    const due = dueVolumeGroup(st);
    return due?.level === 3 ? due.items : null;
}

/** 卷以上的標籤：第 n 卷／第 n 部／第 n 紀。 */
export function digestLabel(level, n) {
    if (level <= 3) return t('volume.label', { n });
    if (level === 4) return t('level.label.4', { n });
    if (level === 5) return t('level.label.5', { n });
    return t('level.label.more', { n, level });
}

/** 時間字串裡有沒有寫日期（2025-12-12、2025年12月12日、12月12日、12/12）。 */
function hasDate(text) {
    return /\d{4}\s*[-/.年]|\d{1,2}\s*月\s*\d{1,2}|(?<![\d:])\d{1,2}\/\d{1,2}(?![\d:])/.test(String(text ?? ''));
}

/**
 * 時間範圍：items = [{ time, from, to }]（from／to 是那一段開始、結束的故事日期，行事曆的 YYYY-MM-DD）。
 * 單層摘要的時間常常只寫「14:52」，日期另外存在 date；合併時用日期補上，免得變成「上午 → 14:52」看不出是哪天。
 * 開始和結束是同一天就只在開始寫日期。
 */
function rangeOf(items) {
    const firstPart = (v) => String(v ?? '').split('→').map((x) => x.trim()).filter(Boolean)[0] ?? '';
    const lastPart = (v) => String(v ?? '').split('→').map((x) => x.trim()).filter(Boolean).pop() ?? '';
    const withTime = items.filter((x) => String(x.time ?? '').trim());
    const first = withTime[0];
    const last = withTime[withTime.length - 1];
    const startDate = items.find((x) => x.from)?.from ?? '';
    const endDate = [...items].reverse().find((x) => x.to)?.to ?? '';
    if (!first) return startDate && endDate && startDate !== endDate ? `${startDate} → ${endDate}` : (startDate || endDate);
    const a = firstPart(first.time);
    const b = lastPart(last.time);
    const aDate = first.from || startDate;
    const bDate = last.to || endDate;
    const start = !hasDate(a) && aDate ? `${aDate} ${a}` : a;
    const end = !hasDate(b) && bDate && bDate !== aDate ? `${bDate} ${b}` : b;
    return start === end ? start : `${start} → ${end}`;
}

/**
 * 地點：拆開（→、、）去掉重複；超過 max 個時，依「恋语市郊区・银杏林营地・C区营位」這種層級往上歸納
 * （只留前幾層），直到不超過 max；還是太多就列前 max 個加「等」。
 */
export function placesOf(values, max = 4) {
    const list = [];
    for (const v of values) {
        for (const part of String(v ?? '').split(/\s*(?:→|->|、|，|,|；|;)\s*/).map((x) => x.trim()).filter(Boolean)) {
            if (!list.includes(part)) list.push(part);
        }
    }
    if (list.length <= max) return list.join('、');
    const SEP = /\s*[・·•／/>＞]\s*/;
    const depth = Math.max(...list.map((x) => x.split(SEP).length));
    for (let d = depth - 1; d >= 1; d--) {
        const general = [];
        for (const x of list) {
            const g = x.split(SEP).slice(0, d).join('・');
            if (!general.includes(g)) general.push(g);
        }
        if (general.length <= max) return general.join('、');
    }
    return `${list.slice(0, max).join('、')} 等`;
}

/** 一層摘要的日期（沒寫就延續前面的樓層）。 */
function floorDate(index) {
    return normDate(getEntry(index)?.date) || previousDate(index);
}

/** 章的時間、地點、開始和結束的日期（不用呼叫模型）。 */
function chapterMeta(indices) {
    const items = indices.map((i) => {
        const e = getEntry(i);
        const d = floorDate(i);
        return { time: e?.time, from: d, to: d, location: e?.location };
    });
    return {
        time: rangeOf(items),
        location: placesOf(items.map((x) => x.location)),
        dateFrom: items.find((x) => x.from)?.from ?? '',
        dateTo: [...items].reverse().find((x) => x.to)?.to ?? '',
    };
}

/** 卷以上的時間、地點、日期：從下一層的成員算。 */
function volumeMeta(children) {
    const items = children.map((x) => ({ time: x.data.time, from: x.data.dateFrom, to: x.data.dateTo, location: x.data.location }));
    return {
        time: rangeOf(items),
        location: placesOf(items.map((x) => x.location)),
        dateFrom: items.find((x) => x.from)?.from ?? '',
        dateTo: [...items].reverse().find((x) => x.to)?.to ?? '',
    };
}

/**
 * 重新算一次已經壓好的章、卷的時間和地點（v0.13.5 修：地點沒合併、日期被吞掉）。不呼叫模型、不改 at（不會讓上一層過期）。
 * 粗略補建的章沒有單層摘要：保留模型寫的時間，補上日期；地點照樣歸納。回傳有沒有改。
 */
export function refreshDigestMeta() {
    const rec = record(false);
    if (!rec) return false;
    let changed = false;
    const st = structure();
    const same = (a, b) => ['time', 'location', 'dateFrom', 'dateTo'].every((k) => (a[k] ?? '') === (b[k] ?? ''));
    for (const c of st.chapters) {
        const alive = c.indices.filter((i) => i >= 0);
        if (!alive.length) continue;
        let meta;
        if (c.data.coarse) {
            const last = alive[alive.length - 1];
            const to = floorDate(last);
            const from = previousDate(alive[0]) || to;
            meta = { time: rangeOf([{ time: c.data.time, from, to }]), location: placesOf([c.data.location]), dateFrom: from, dateTo: to };
            // 已經算過的不要再加一次日期。
            if (c.data.dateTo) meta.time = c.data.time;
        } else {
            meta = chapterMeta(alive);
        }
        if (!same(c.data, meta)) {
            Object.assign(c.data, meta);
            changed = true;
        }
    }
    // 由低到高：卷用章的、部用卷的。
    for (const v of [...st.volumes].sort((a, b) => a.level - b.level)) {
        if (!v.children.length) continue;
        const meta = volumeMeta(v.children);
        if (!same(v.data, meta)) {
            Object.assign(v.data, meta);
            changed = true;
        }
    }
    if (changed) saveMeta();
    return changed;
}

/** 每一層的上限（tokens）：L2 沒有上限（只看比例），L3、L4、L5、更高各自可調。 */
function capTokens(level) {
    const c = getSettings().compress;
    if (level <= 2) return 0;
    const v = level === 3 ? c.capL3 : level === 4 ? c.capL4 : level === 5 ? c.capL5 : c.capMore;
    return Math.max(0, Number(v) || 0);
}

/** 壓縮後的目標字數：原文字數 × 壓縮比例（上下限平均），再受這一層的上限限制。 */
export function targetLength(text, level = 2) {
    const c = getSettings().compress;
    const ratio = (Number(c.ratioMin) + Number(c.ratioMax)) / 200 || 0.35;
    const zh = currentLocale().startsWith('zh');
    const units = zh ? text.replace(/\s/g, '').length : text.split(/\s+/).filter(Boolean).length;
    let target = units * ratio;
    const cap = capTokens(level);
    // tokens 換成字數：中文約 1.15 字／token，英文約 0.75 字／token（用使用者的聊天實測的比例）。
    if (cap) target = Math.min(target, cap * (zh ? 1.15 : 0.75));
    return Math.max(20, Math.round(target / 10) * 10);
}

/** 壓縮模型的回覆：要的是純文字；包在 ```、或回了 {"summary": …} 也接受。 */
export function parsePlain(raw) {
    let text = String(raw ?? '').trim().replace(/^```\w*\s*/, '').replace(/\s*```$/, '').trim();
    if (text.startsWith('{')) {
        try {
            const obj = JSON.parse(text);
            if (typeof obj?.summary === 'string') text = obj.summary.trim();
        } catch (e) { /* 當純文字 */ }
    }
    if (!text) throw new ApiError('empty');
    return text;
}

function fill(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

async function callModel(templateKey, varName, text, level = 2) {
    const c = ctx();
    const length = targetLength(text, level);
    const prompt = fill(getTemplate(templateKey), { [varName]: text, length, char: c?.name2 ?? '', user: c?.name1 ?? '' });
    const raw = await generateText(prompt, { maxTokens: Math.max(1500, length * 3) });
    return parsePlain(raw);
}

function upsert(listName, item) {
    const rec = record(true);
    if (!rec) return;
    const list = Array.isArray(rec[listName]) ? rec[listName] : [];
    const k = list.findIndex((x) => x.id === item.id);
    if (k >= 0) list[k] = item;
    else list.push(item);
    rec[listName] = list;
    saveMeta();
}

/** 把這幾層壓成一章（existing：重新壓縮既有的那一章）。 */
async function compressChapter(indices, existing = null) {
    const entries = indices.map((i) => getEntry(i));
    const text = entries.map((e) => sceneLine(e)).join('\n');
    const base = {
        id: existing?.id ?? newId('ch'),
        members: indices.map(sendDateOf),
        memberIdx: [...indices],
        memberAts: entries.map((e) => e.at),
        ...chapterMeta(indices),
    };
    try {
        const summary = await callModel('l2', 'summaries', text);
        upsert('chapters', { ...base, summary, status: 'ok', at: Date.now() });
        return true;
    } catch (e) {
        console.warn(LOG_PREFIX, '壓縮成章失敗', e);
        if (existing) upsert('chapters', { ...existing, status: 'fail', error: errorText(e), at: Date.now() });
        else toast(t('compress.failed', { error: errorText(e) }), 'error');
        return false;
    }
}

/** 把這幾個成員（章，或下一層的卷）壓成 level 層的一個總結。 */
async function compressVolume(children, existing = null, level = existing?.level ?? 3) {
    const childLabel = (x) => (level === 3 ? t('chapter.label', { n: x.number }) : digestLabel(level - 1, x.number));
    const text = children.map((x) => sceneLine({ ...x.data, characters: [] }, childLabel(x))).join('\n');
    const base = {
        id: existing?.id ?? newId(level === 3 ? 'vol' : `l${level}`),
        level,
        chapterIds: children.map((x) => x.data.id),
        chapterAts: children.map((x) => x.data.at),
        ...volumeMeta(children),
    };
    try {
        const summary = await callModel('l3', 'chapters', text, level);
        upsert('volumes', { ...base, summary, status: 'ok', at: Date.now() });
        return true;
    } catch (e) {
        console.warn(LOG_PREFIX, `壓縮成 L${level} 失敗`, e);
        if (existing) upsert('volumes', { ...existing, status: 'fail', error: errorText(e), at: Date.now() });
        else toast(t('compress.failed', { error: errorText(e) }), 'error');
        return false;
    }
}

/**
 * 佇列裡的壓縮工作（summarize.js 呼叫）。
 * target：章／卷的 id → 用目前還在、還有效的成員重新壓縮；null → 把所有到期的壓完。
 */
export async function runCompression(target) {
    if (!isActive()) return;
    if (target?.floors) {
        // 使用者多選的：排隊的時候可能已經變了，再檢查一次。
        const res = checkManualChapter(target.floors);
        if (res.floors) await compressChapter(res.floors);
        else toast(t(`bulk.compress.${res.error}`), 'warning');
        return;
    }
    if (target) {
        const st = structure();
        const ch = st.chapters.find((c) => c.data.id === target);
        if (ch?.data.coarse && coarseRedo) {
            const alive = ch.indices.filter((i) => i >= 0 && isAiMessage(getChat()[i]));
            if (alive.length) await coarseRedo(alive, ch.data);
            else deleteChapter(target);
            return;
        }
        if (ch) {
            const alive = ch.indices.filter((i) => i >= 0 && floorState(i) === 'ok');
            if (alive.length) await compressChapter(alive, ch.data);
            else deleteChapter(target);
            return;
        }
        const vol = st.volumes.find((v) => v.data.id === target);
        if (vol) {
            const alive = vol.children.filter((c) => c.state === 'ok');
            if (alive.length) await compressVolume(alive, { ...vol.data, level: vol.level }, vol.level);
            else deleteVolume(target);
        }
        return;
    }
    // 一次最多壓 50 次，避免意外的無限迴圈（補建很長的聊天時，一次會有很多章要往上壓）。
    for (let k = 0; k < 50; k++) {
        const st = structure();
        const floors = dueChapterFloors(st);
        if (floors) {
            if (!(await compressChapter(floors))) return;
            continue;
        }
        const due = dueVolumeGroup(st);
        if (due) {
            if (!(await compressVolume(due.items, null, due.level))) return;
            continue;
        }
        return;
    }
}

/** 有沒有到期要壓縮的。 */
export function compressionDue() {
    const st = structure();
    return Boolean(dueChapterFloors(st) || dueVolumeGroup(st));
}

/** 補建（catchup.js）直接寫好的一章。 */
export function saveChapter(item) {
    upsert('chapters', item);
}

// 粗略補建的章，重做時要回去讀原文（成員沒有單層摘要可以合併）。
let coarseRedo = null;
export function setCoarseRedo(fn) {
    coarseRedo = fn;
}

export function editChapter(id, summary) {
    const ch = getChapters().find((c) => c.id === id);
    const text = String(summary ?? '').trim();
    if (!ch || !text) return false;
    upsert('chapters', { ...ch, summary: text, status: 'ok', error: undefined, manual: true, at: Date.now() });
    return true;
}

export function editVolume(id, summary) {
    const vol = getVolumes().find((v) => v.id === id);
    const text = String(summary ?? '').trim();
    if (!vol || !text) return false;
    upsert('volumes', { ...vol, summary: text, status: 'ok', error: undefined, manual: true, at: Date.now() });
    return true;
}

export function deleteChapter(id) {
    const rec = record(false);
    if (!rec?.chapters) return;
    rec.chapters = rec.chapters.filter((c) => c.id !== id);
    saveMeta();
}

export function deleteVolume(id) {
    const rec = record(false);
    if (!rec?.volumes) return;
    rec.volumes = rec.volumes.filter((v) => v.id !== id);
    saveMeta();
}

export function initCompression() {
    setCompressHandler(runCompression);
    // 舊的章、卷：時間和地點用新的方式重算一次（換聊天時也算）。
    try { refreshDigestMeta(); } catch (e) { console.warn(LOG_PREFIX, e); }
    const c = ctx();
    if (c?.eventSource && c.eventTypes?.CHAT_CHANGED) {
        c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => { try { refreshDigestMeta(); } catch (e) { console.warn(LOG_PREFIX, e); } });
    }
    // 每摘要好一層就檢查一次：有到期的就排一個壓縮工作。
    setAfterSummaryHook(() => {
        if (getSettings().compress.auto && isActive() && compressionDue()) enqueueCompress();
    });
}
