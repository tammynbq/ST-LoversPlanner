// 🩺 檢查：摘要有沒有生成、有沒有可疑的地方，以及（選用）請模型抽查（使用者要求）。
//
// runChecks() 不呼叫模型：
//   生成狀態：還沒摘要、失敗、過期、從截斷的回覆救回來、章／卷失效、該壓縮沒壓縮、補建暫停、前情提要濃縮失敗。
//   可疑：摘要空白、太長、和上一層一樣；時間／地點空白；記事重名；數量 0 的物件。
// auditFloors() 會呼叫模型：拿原文對照摘要，找寫錯、漏掉、人物搞錯。
// 每個問題附修正方法；autoFix 為 true 的會被「全部修正」處理。

import { ctx, LOG_PREFIX, toast } from './util.js';
import { getSettings, isTracked } from './settings.js';
import { t } from './i18n.js';
import { getTemplate } from './prompts.js';
import { generateText } from './llm.js';
import { errorText } from './errors.js';
import { parseJsonLenient } from './json.js';
import { cleanForSummary } from './filter.js';
import { aiIndices, floorSource, getChat, getEntry } from './chat.js';
import { completeNoteManual, deleteNoteManual, fieldLabel, getNotes, NOTE_FIELDS, noteTitle, updateNoteManual } from './notes.js';
import { compressionDue, digestLabel, structure } from './compress.js';
import { enqueue, enqueueCompress, floorState, sideFloor, unsummarizedIndices } from './summarize.js';
import { getCatchup, resumeCatchup } from './catchup.js';
import { condenseRecap, getRecap } from './carry.js';
import { aliasesOf } from './recall.js';
import { estimateTokens } from './hide.js';
import { longFields, tidyCharacter } from './tidy.js';

/** 一層最多列幾個「時間／地點空白」的樓層（其他的只算數量）。 */
const MAX_LISTED = 12;

function issue(kind, severity, extra = {}) {
    return { id: `${kind}:${extra.floor ?? extra.target ?? extra.ids?.join(',') ?? ''}`, kind, severity, autoFix: false, ...extra };
}

/** 兩段摘要幾乎一樣（拿掉標點和空白後相同，或其中一段包含另一段）。 */
function nearlySame(a, b) {
    const norm = (x) => String(x ?? '').replace(/[\s\p{P}]/gu, '').toLowerCase();
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const [short, long] = x.length < y.length ? [x, y] : [y, x];
    return short.length >= 12 && long.includes(short);
}

/** 不呼叫模型的檢查。回傳 [{ id, kind, severity: 'error'|'warn'|'info', autoFix, floor?, floors?, target?, ids?, text? }]。 */
export function runChecks() {
    const out = [];
    const s = getSettings();
    const st = structure();

    // ===== 生成狀態 =====
    const todo = unsummarizedIndices();
    if (todo.length) out.push(issue('none', 'warn', { floors: todo, n: todo.length }));
    let prevSummary = null;
    const noTime = [];
    const noLocation = [];
    for (const i of aiIndices()) {
        const state = floorState(i);
        const e = getEntry(i);
        if (state === 'fail') out.push(issue('fail', 'error', { floor: i, autoFix: true, text: e?.error ?? '' }));
        // ⭐ 小劇場還沒讀或讀取失敗：回憶和約定沒記到（原文照樣不送）。
        if (state === 'side' && (e?.pending || e?.error)) out.push(issue('sideUnread', 'warn', { floor: i, autoFix: true, text: e?.error ?? '' }));
        else if (state === 'stale') out.push(issue('stale', 'error', { floor: i, autoFix: true }));
        if (state !== 'ok' || !e || e.coarse) {
            if (state !== 'skip' && state !== 'side') prevSummary = null;
            continue;
        }
        if (e.repaired) out.push(issue('repaired', 'warn', { floor: i, autoFix: true }));
        // ===== 可疑 =====
        const summary = String(e.summary ?? '').trim();
        if (summary.replace(/[\s\p{P}]/gu, '').length < 4) {
            out.push(issue('empty', 'error', { floor: i, autoFix: true }));
        } else if (!e.manual && estimateTokens(summary) > Math.max(60, s.summary.maxTokens * 1.6)) {
            out.push(issue('long', 'warn', { floor: i, n: estimateTokens(summary) }));
        }
        if (prevSummary && nearlySame(prevSummary.text, summary)) out.push(issue('dup', 'warn', { floor: i, other: prevSummary.floor }));
        if (isTracked('time') && !String(e.time ?? '').trim()) noTime.push(i);
        if (isTracked('location') && !String(e.location ?? '').trim()) noLocation.push(i);
        prevSummary = { floor: i, text: summary };
    }
    if (noTime.length) out.push(issue('noTime', 'info', { floors: noTime, n: noTime.length }));
    if (noLocation.length) out.push(issue('noLocation', 'info', { floors: noLocation, n: noLocation.length }));

    for (const c of st.chapters) {
        if (c.state === 'stale' || c.state === 'fail') out.push(issue(`chapter-${c.state}`, 'error', { target: c.data.id, n: c.number, autoFix: true }));
    }
    for (const v of st.volumes) {
        if (v.state === 'stale' || v.state === 'fail') out.push(issue(`volume-${v.state}`, 'error', { target: v.data.id, n: v.number, label: digestLabel(v.level, v.number), autoFix: true }));
    }
    if (s.compress && compressionDue()) out.push(issue('compressDue', 'warn', { autoFix: true }));
    const cu = getCatchup();
    if (cu?.paused) out.push(issue('catchupPaused', 'warn', { autoFix: true, text: cu.error ?? '' }));
    if (getRecap()?.status === 'fail') out.push(issue('recapFail', 'warn', { autoFix: true }));

    // ===== 記事 =====
    const notes = [...getNotes().notes.values()].filter((n) => n.state !== 'done' && isTracked(n.type));
    const seen = new Set();
    for (const a of notes) {
        for (const b of notes) {
            if (a === b || a.type !== b.type || seen.has(b.id) || seen.has(a.id)) continue;
            if (!sameThing(a, b)) continue;
            seen.add(b.id);
            out.push(issue('dupNote', 'warn', { ids: [a.id, b.id], title: noteTitle(a), other: noteTitle(b), type: a.type }));
        }
    }
    for (const n of notes) {
        if (n.type === 'item' && n.state === 'active' && Number.parseInt(n.data.quantity, 10) === 0) {
            out.push(issue('zeroItem', 'warn', { ids: [n.id], title: noteTitle(n), autoFix: true }));
        }
        // 人物欄位太長（狀態寫成一段摘要、備註裡寫了發生過的事）：請模型整理，每個人物一次呼叫，所以不算進「全部修正」。
        const long = longFields(n);
        if (long.length) out.push(issue('longField', 'warn', { ids: [n.id], title: noteTitle(n), fields: long.map((f) => fieldLabel('character', f)).join('、') }));
    }
    return out;
}

/** 兩條記事是不是同一個（標題一樣；人物的話，名字互相包含也算，例如「林曉」和「林曉（小曉）」）。 */
function sameThing(a, b) {
    const x = noteTitle(a).trim().toLowerCase();
    const y = noteTitle(b).trim().toLowerCase();
    if (!x || !y) return false;
    if (x === y) return true;
    if (a.type !== 'character') return false;
    const A = aliasesOf(noteTitle(a));
    const B = aliasesOf(noteTitle(b));
    return A.some((p) => B.includes(p));
}

/** 需要使用者注意的數量（標題列的數字）：錯誤＋警告，不算提示。 */
export function issueCount(list = runChecks()) {
    return list.filter((x) => x.severity !== 'info').length;
}

/** 把 b 併進 a：a 沒有的欄位用 b 的補上，然後刪掉 b。 */
export function mergeNotes(aId, bId) {
    const notes = getNotes().notes;
    const a = notes.get(aId);
    const b = notes.get(bId);
    if (!a || !b) return false;
    const data = { ...a.data };
    for (const f of NOTE_FIELDS[a.type]) if (!data[f] && b.data[f]) data[f] = b.data[f];
    updateNoteManual(aId, data);
    deleteNoteManual(bId);
    return true;
}

/** 修正一個問題。回傳 true 表示有做事。 */
export function fixIssue(x) {
    switch (x.kind) {
        case 'fail':
        case 'stale':
        case 'repaired':
        case 'empty':
        case 'long':
        case 'dup':
        case 'audit':
            return enqueue(x.floor, { front: true });
        case 'chapter-stale':
        case 'chapter-fail':
        case 'volume-stale':
        case 'volume-fail':
            return enqueueCompress(x.target);
        case 'compressDue':
            return enqueueCompress();
        case 'catchupPaused':
            return Boolean(resumeCatchup());
        case 'recapFail':
            condenseRecap();
            return true;
        case 'sideUnread':
            return sideFloor(x.floor);
        case 'dupNote':
            return mergeNotes(x.ids[0], x.ids[1]);
        case 'zeroItem':
            return completeNoteManual(x.ids[0], 'used');
        case 'longField':
            // 非同步：整理好時記事會變，畫面自己重畫。
            tidyCharacter(x.ids[0])
                .then((r) => toast(t('check.tidy.done', r), 'success'))
                .catch((e) => toast(t('check.tidy.fail', { title: x.title, error: errorText(e) }), 'error'));
            return true;
        default:
            return false;
    }
}

/** 「全部修正」：只處理可以自動修的。回傳處理了幾項。 */
export function fixAll(list = runChecks()) {
    let n = 0;
    for (const x of list) if (x.autoFix && fixIssue(x)) n++;
    return n;
}

// ===== 請模型抽查 =====

const audits = new Map(); // floor → { ok, problems, hash, entryAt, at, error? }

/** 抽查結果還算數：原文和摘要都沒變過。 */
function auditStillValid(floor) {
    const r = audits.get(floor);
    return Boolean(r) && getChat()[floor] !== undefined && floorSource(floor).hash === r.hash && getEntry(floor)?.at === r.entryAt;
}

export function auditResults() {
    return audits;
}

/** 要抽查哪幾層：先挑規則檢查覺得可疑的，再挑最近的；已經抽查過、原文沒變的不重複查。 */
export function pickAuditFloors(n) {
    const flagged = new Set(runChecks().filter((x) => ['long', 'dup', 'repaired'].includes(x.kind)).map((x) => x.floor));
    const ok = aiIndices().filter((i) => floorState(i) === 'ok' && getEntry(i)?.summary && !getEntry(i)?.coarse)
        .filter((i) => !auditStillValid(i));
    const first = ok.filter((i) => flagged.has(i)).reverse();
    const rest = ok.filter((i) => !flagged.has(i)).reverse();
    return [...first, ...rest].slice(0, Math.max(0, n));
}

function fill(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

async function auditOne(index) {
    const c = ctx();
    const src = floorSource(index);
    const e = getEntry(index);
    const content = [
        ...src.users.map((u) => `${u.name ?? c?.name1 ?? 'User'}: ${cleanForSummary(u.mes)}`),
        `${src.ai.name ?? c?.name2 ?? 'Character'}: ${cleanForSummary(src.ai.mes)}`,
    ].join('\n\n');
    const summary = [
        e.time ? `${t('meta.time')}：${e.time}` : '',
        e.location ? `${t('meta.location')}：${e.location}` : '',
        e.characters?.length ? `${t('meta.characters')}：${e.characters.join('、')}` : '',
        e.summary,
    ].filter(Boolean).join('\n');
    const prompt = fill(getTemplate('audit'), { char: c?.name2 ?? '', user: c?.name1 ?? '', content, summary });
    const raw = await generateText(prompt, { maxTokens: 3000, purpose: 'check' });
    const parsed = parseJsonLenient(String(raw ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''), { accept: (v) => typeof v?.ok === 'boolean' });
    const v = parsed?.value;
    if (typeof v?.ok !== 'boolean') throw new Error(t('err.parse', { detail: String(raw ?? '').slice(0, 120) }));
    const problems = (Array.isArray(v.problems) ? v.problems : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 5);
    return { ok: v.ok && !problems.length, problems };
}

let auditing = null;

export function auditProgress() {
    return auditing;
}

/** 抽查這幾層（一層一層來）。onProgress() 每查完一層呼叫一次。 */
export async function auditFloors(indices, onProgress = () => {}) {
    if (auditing) return;
    auditing = { done: 0, total: indices.length };
    onProgress();
    try {
        for (const i of indices) {
            const hash = floorSource(i).hash;
            const entryAt = getEntry(i)?.at;
            try {
                audits.set(i, { ...(await auditOne(i)), hash, entryAt, at: Date.now() });
            } catch (e) {
                console.warn(LOG_PREFIX, `抽查第 ${i} 層失敗`, e);
                audits.set(i, { ok: null, problems: [], error: errorText(e), hash, entryAt, at: Date.now() });
            }
            auditing.done++;
            onProgress();
        }
    } finally {
        auditing = null;
        onProgress();
    }
}

/** 抽查結果裡有問題的，當成檢查清單的一項。 */
export function auditIssues() {
    const out = [];
    for (const [floor, r] of audits) {
        if (!auditStillValid(floor)) continue;
        if (r.ok === false) out.push(issue('audit', 'warn', { floor, problems: r.problems }));
        else if (r.ok === null) out.push(issue('auditError', 'info', { floor, text: r.error }));
    }
    return out;
}

export function clearAudits() {
    audits.clear();
}
