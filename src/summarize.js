// L1 單層摘要：排隊、組提示詞、呼叫模型、解析結果、寫回訊息。
//
// 三種模式（設定 › 摘要）：
//   'after'  每回正文結束後自動：AI 一回覆完就摘要這一層（重新生成／swipe 會再摘一次）。
//   'before' 開始下回前自動：使用者送出下一句時，才摘要上一個 AI 樓層（那時才算定案，比較省）。
//   'manual' 手動：只在按「立即摘要」時。
// 走主 API 時，等酒館這一輪生成結束才開始，避免和正常生成搶同一條連線。

import { ctx, hasCharacterChat, isGroupChat, LOG_PREFIX, toast } from './util.js';
import { getSettings, isTracked, trackedNoteTypes } from './settings.js';
import { currentLocale, t } from './i18n.js';
import { getTemplate } from './prompts.js';
import { ApiError } from './api/custom.js';
import { countTokens, generateText, modelLabel, usesMain } from './llm.js';
import { errorText } from './errors.js';
import { formatNotesForPrompt, invalidateNotes, normalizeModelOps, replay } from './notes.js';
import { buildL1Parts } from './l1rules.js';
import { parseJsonLenient } from './json.js';
import { cleanForSummary, extractRef, extractTheater } from './filter.js';
import { calendarOn, cleanEvents, normDate } from './calendar.js';
import { cleanKeepsakes, memoriesOn } from './memories.js';
import {
    chatKey, floorSource, floorStatus, getChat, getEntry, isAiMessage, lastAiIndex, saveChatSoon, setEntry,
} from './chat.js';

/** 主 API 正在生成時，超過這麼久沒收到結束事件就當作已經結束（避免卡住）。 */
const MAIN_BUSY_TIMEOUT_MS = 3 * 60 * 1000;

// 佇列裡有三種工作：{ index, chatId } 摘要一層；{ kind: 'compress', target, chatId } 壓縮（compress.js）；
// { kind: 'coarse', indices, chatId } 補建時把一整段舊樓層直接寫成一章（catchup.js）。
const queue = [];
const queued = new Set();
let running = null; // 正在摘要的 index；壓縮中是 'compress'；粗略補建中是 'coarse'
let runningCoarse = new Set(); // 粗略補建中的那一段樓層
let runningTask = null; // 正在跑的一般工作（例如 'diary'）
const coarseQueued = new Set(); // 排隊等粗略補建的樓層
let compressHandler = null; // compress.js 的 runCompression（用註冊的方式，避免互相 import）
let coarseHandler = null; // catchup.js 的 runCoarse
const afterSummaryHooks = []; // 一層（或一段）摘要好之後呼叫（compress.js 檢查要不要壓縮、catchup.js 檢查進度）
let mainBusySince = 0;
// 攔截器正在「等摘要好才開始生成」：這時候主 API 是空的，可以直接摘要。
let holding = false;
const listeners = new Set();

export function onSummaryChange(fn) {
    listeners.add(fn);
}

function notify(index) {
    invalidateNotes();
    for (const fn of listeners) {
        try { fn(index); } catch (e) { console.error(LOG_PREFIX, e); }
    }
}

export function isActive() {
    return getSettings().enabled && hasCharacterChat() && !isGroupChat();
}

/** 畫面用的狀態：存起來的狀態，再加上「排隊中／摘要中」。 */
export function floorState(index) {
    if (running === index || runningCoarse.has(index)) return 'busy';
    if (queued.has(index) || coarseQueued.has(index)) return 'queued';
    return floorStatus(index);
}

/**
 * 排隊中＋進行中的工作數。預設不算排隊中的一般工作（寫日記）：送出前只等摘要，
 * 不用等幾十段日記寫完（正在跑的那一個還是會等）。
 */
export function pendingCount({ tasks = false } = {}) {
    return queue.filter((q) => tasks || q.kind !== 'task').length + (running === null ? 0 : 1);
}

/** side：⭐ 小劇場，只讀回憶和約定，不寫正劇摘要。 */
export function enqueue(index, { front = false, side = false } = {}) {
    if (!isActive() || !isAiMessage(getChat()[index])) return false;
    if (queued.has(index) || running === index) return true;
    const item = { index, chatId: chatKey(), ...(side ? { side: true } : {}) };
    if (front) queue.unshift(item);
    else queue.push(item);
    queued.add(index);
    notify(index);
    drain();
    return true;
}

export function setCompressHandler(fn) {
    compressHandler = fn;
}

export function setAfterSummaryHook(fn) {
    afterSummaryHooks.push(fn);
}

function runAfterHooks(index) {
    for (const fn of afterSummaryHooks) {
        try { fn(index); } catch (e) { console.error(LOG_PREFIX, e); }
    }
}

export function setCoarseHandler(fn) {
    coarseHandler = fn;
}

/** 排一個粗略補建工作：把這幾層（連續的舊樓層）直接寫成一章。 */
export function enqueueCoarse(indices) {
    if (!isActive() || !coarseHandler || !indices.length) return false;
    queue.push({ kind: 'coarse', indices: [...indices], chatId: chatKey() });
    indices.forEach((i) => coarseQueued.add(i));
    notify(null);
    drain();
    return true;
}

/**
 * 排一個一般工作（v0.13.34，寫日記用）：和摘要共用同一個隊伍，不會和正常生成、摘要同時呼叫模型。
 * run 是 async 函式；換了聊天就不跑。
 */
export function enqueueTask(run, { label = 'task' } = {}) {
    if (!isActive()) return false;
    queue.push({ kind: 'task', run, label, chatId: chatKey() });
    notify(null);
    drain();
    return true;
}

/** 隊伍裡還有幾個某種工作（例如還有幾段日記要寫）。 */
export function queuedTasks(label) {
    return queue.filter((q) => q.kind === 'task' && q.label === label).length + (runningTask === label ? 1 : 0);
}

/** 拿掉隊伍裡某種還沒開始的工作（暫停寫日記）。 */
export function dropTasks(label) {
    const before = queue.length;
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].kind === 'task' && queue[i].label === label) queue.splice(i, 1);
    if (queue.length !== before) notify(null);
}

export function isCompressing() {
    return running === 'compress';
}

/** 排一個壓縮工作（target：要重新壓縮的章／卷 id；null＝檢查並壓縮所有到期的）。 */
export function enqueueCompress(target = null) {
    if (!isActive() || !compressHandler) return false;
    if (queue.some((q) => q.kind === 'compress' && q.target === target)) return true;
    queue.push({ kind: 'compress', target, chatId: chatKey() });
    notify(null);
    drain();
    return true;
}

export function cancelQueue() {
    queue.length = 0;
    queued.clear();
    coarseQueued.clear();
    notify(null);
}

export function mainBusy() {
    return mainBusySince > 0 && Date.now() - mainBusySince < MAIN_BUSY_TIMEOUT_MS;
}

export function setHolding(on) {
    holding = Boolean(on);
    if (holding) drain();
}

/** 等到排隊和進行中的摘要都結束（最多等 timeoutMs）。 */
export function waitForIdle(timeoutMs = 5 * 60 * 1000) {
    if (!pendingCount()) return Promise.resolve(true);
    return new Promise((resolve) => {
        const timer = setTimeout(() => { listeners.delete(check); resolve(false); }, timeoutMs);
        function check() {
            if (pendingCount()) return;
            clearTimeout(timer);
            listeners.delete(check);
            resolve(true);
        }
        listeners.add(check);
    });
}

async function drain() {
    if (running !== null) return;
    if (usesMain() && mainBusy() && !holding) return;
    // 摘要、壓縮先做，一般工作（寫日記）排在它們後面（不然新樓層的摘要要等幾十段日記）。
    const first = queue.findIndex((q) => q.kind !== 'task');
    const item = first >= 0 ? queue.splice(first, 1)[0] : queue.shift();
    if (!item) return;
    if (item.kind === 'coarse') item.indices.forEach((i) => coarseQueued.delete(i));
    else if (item.kind !== 'compress' && item.kind !== 'task') queued.delete(item.index);
    if (item.chatId !== chatKey()) {
        drain();
        return;
    }
    if (item.kind === 'task') {
        running = 'task';
        runningTask = item.label;
        notify(null);
        try {
            await item.run();
        } catch (e) {
            console.error(LOG_PREFIX, '工作出錯', item.label, e);
        } finally {
            running = null;
            runningTask = null;
            notify(null);
            setTimeout(drain, 0);
        }
        return;
    }
    if (item.kind === 'compress') {
        running = 'compress';
        notify(null);
        try {
            await compressHandler?.(item.target);
        } catch (e) {
            console.error(LOG_PREFIX, '壓縮出錯', e);
        } finally {
            running = null;
            notify(null);
            setTimeout(drain, 0);
        }
        return;
    }
    if (item.kind === 'coarse') {
        running = 'coarse';
        runningCoarse = new Set(item.indices);
        notify(null);
        try {
            await coarseHandler?.(item.indices);
        } catch (e) {
            console.error(LOG_PREFIX, '粗略補建出錯', e);
        } finally {
            running = null;
            runningCoarse = new Set();
            notify(null);
            runAfterHooks(null);
            setTimeout(drain, 0);
        }
        return;
    }
    running = item.index;
    notify(item.index);
    try {
        await (item.side ? readSideFloor(item.index) : summarizeFloor(item.index));
    } finally {
        running = null;
        notify(item.index);
        runAfterHooks(item.index);
        setTimeout(drain, 0);
    }
}

// ===== 組提示詞 =====

function fillTemplate(template, vars) {
    // 只換我們自己的變數；{{char}} {{user}} 以外的酒館巨集原樣留著。
    return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

/** 目標 token 數換算成提示詞裡的「約 N 字／N words」。用這段原文自己的字數／token 比例來換算。 */
function lengthUnits(content, tokens, targetTokens) {
    const zh = currentLocale().startsWith('zh');
    const units = zh ? content.replace(/\s/g, '').length : content.split(/\s+/).filter(Boolean).length;
    const perToken = units / Math.max(tokens, 1);
    return Math.max(10, Math.round((targetTokens * perToken) / 10) * 10);
}

/** 往前找最近一個有時間、地點或日期的已摘要樓層，讓模型延續。 */
function previousSceneText(index) {
    const useTime = isTracked('time');
    const useLocation = isTracked('location');
    const useDate = calendarOn();
    // 時間、地點、日期都沒勾，就不需要「上一層」這段。
    if (!useTime && !useLocation && !useDate) return '';
    const chat = getChat();
    for (let i = index - 1; i >= 0; i--) {
        if (!isAiMessage(chat[i])) continue;
        const e = getEntry(i);
        const time = useTime ? e?.time : '';
        const location = useLocation ? e?.location : '';
        const date = useDate ? normDate(e?.date) : '';
        if (e?.status === 'ok' && (time || location || date)) {
            const parts = [];
            if (useTime) parts.push(t('prompt.previousTime', { time: time || '—' }));
            if (useLocation) parts.push(t('prompt.previousLocation', { location: location || '—' }));
            if (useDate && date) parts.push(t('prompt.previousDate', { date }));
            return `${t('prompt.previousLabel')}${parts.join('｜')}`;
        }
    }
    return `${t('prompt.previousLabel')}${t('prompt.noPrevious')}`;
}

/** 往前找最近一個有日期的樓層（行事曆的日期要延續它）。 */
export function previousDate(index) {
    const chat = getChat();
    for (let i = index - 1; i >= 0; i--) {
        if (!isAiMessage(chat[i])) continue;
        const d = normDate(getEntry(i)?.date);
        if (d) return d;
    }
    return '';
}

/** 記事清單（連標題）；沒勾任何記事類型就是空的。 */
function notesSection(notesBefore) {
    if (!trackedNoteTypes().length) return '';
    return `${t('prompt.notesLabel')}\n${formatNotesForPrompt(notesBefore)}`;
}

export async function buildL1Prompt(index, { side = false } = {}) {
    const s = getSettings();
    const c = ctx();
    const src = floorSource(index);
    // 給模型看「這一層之前」的記事；重做舊樓層時不會把之後的變化算進來。
    const notesBefore = replay({ upTo: index }).notes;
    const parts = [];
    // 思維鏈、狀態欄等先拿掉（設定 › 摘要時跳過的內容）。
    if (s.summary.includeUser) {
        for (const u of src.users) parts.push(`${u.name ?? c?.name1 ?? 'User'}: ${cleanForSummary(u.mes)}`);
    }
    parts.push(`${src.ai.name ?? c?.name2 ?? 'Character'}: ${cleanForSummary(src.ai.mes)}`);
    // 小劇場（番外）：不算正文，另外附上，讓模型只挑有意義的收進回憶錄。
    const theater = !side && memoriesOn() && s.memories?.auto ? extractTheater(src.ai.mes) : '';
    // 只當參考的標籤（狀態欄）：抽出日期、時間、地點那幾行另外附上。
    const ref = side ? '' : extractRef(src.ai.mes);
    // ⭐ 小劇場：整層都是番外，標明一下。
    const content = (side ? `${t('prompt.theaterLabel')}\n` : '') + parts.join('\n\n') + (theater ? `\n\n${t('prompt.theaterLabel')}\n${theater}` : '') + (ref ? `\n\n${t('prompt.refLabel')}\n${ref}` : '');

    const tokens = await countTokens(content);
    const ratio = (s.summary.ratioMin + s.summary.ratioMax) / 200;
    const targetTokens = Math.min(s.summary.maxTokens, Math.max(s.summary.minTokens, Math.round(tokens * ratio)));
    const length = lengthUnits(content, tokens, targetTokens);
    const { rules, format } = buildL1Parts({ length, char: c?.name2 ?? '', user: c?.name1 ?? '', previousDate: previousDate(index), theater: Boolean(theater), side });
    const prompt = fillTemplate(getTemplate('l1'), {
        char: c?.name2 ?? '',
        user: c?.name1 ?? '',
        length,
        content,
        rules,
        format,
        notes: notesSection(notesBefore),
        previous: side ? '' : previousSceneText(index),
    }).replace(/\n{3,}/g, '\n\n'); // 空掉的段落不要留下一堆空行
    // 摘要本身＋時間、地點、人物＋記事 JSON 的空間要給夠，不然 JSON 會被截斷；
    // 會先「思考」的模型也會吃掉一部分額度。只按實際用到的計費，給多不會多花錢。
    return { prompt, hash: src.hash, notesBefore, maxTokens: Math.max(2000, targetTokens * 2 + 1500) };
}

// ===== 解析結果 =====

export function parseL1(raw) {
    const text = String(raw ?? '').trim();
    if (!text) throw new ApiError('empty');
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    // 模型沒照 JSON 格式，但給了一段純文字：直接當摘要用。
    if (cleaned.indexOf('{') === -1) return { time: '', location: '', characters: [], summary: cleaned, ops: [], repaired: false };
    // 被截斷或格式有小錯也盡量救回（json.js）。
    const parsed = parseJsonLenient(cleaned, { accept: (v) => typeof v?.summary === 'string' && v.summary.trim() !== '' });
    const obj = parsed?.value;
    if (typeof obj?.summary === 'string' && obj.summary.trim()) {
        return {
            ...cleanScene(obj),
            summary: obj.summary.trim(),
            ops: Array.isArray(obj.ops) ? obj.ops : [],
            date: obj.date ?? '',
            events: obj.events ?? [],
            keepsakes: obj.keepsakes ?? [],
            repaired: parsed.repaired,
        };
    }
    // 救不回來：錯誤訊息附上頭尾，方便看出是在哪裡斷掉的。
    const detail = text.length > 200 ? `${text.slice(0, 100)} … ${text.slice(-80)}` : text;
    throw new ApiError('parse', detail);
}

/** 時間、地點、出場人物：整理成固定格式。 */
export function cleanScene(obj) {
    const str = (v) => String(v ?? '').trim().slice(0, 100);
    let chars = obj?.characters;
    if (typeof chars === 'string') chars = chars.split(/[,，、;；]/);
    chars = Array.isArray(chars) ? [...new Set(chars.map(str).filter(Boolean))].slice(0, 12) : [];
    return { time: str(obj?.time), location: str(obj?.location), characters: chars };
}

// ===== 摘要一層 =====

// 版本（v0.13.12，使用者要求：重做後不滿意可以回到上一版，也方便比較不同模型）：
// 重做或手動修改時，把原本的版本存進 entry.history（新的在前，最多 HISTORY_MAX 個）。
// 每個版本記著是誰寫的（by：模型名稱，手動改的是 manual）。粗略補建的樓層沒有單層摘要，不存。
const HISTORY_MAX = 5;

function snapshot(entry) {
    if (!entry || entry.status !== 'ok' || !entry.summary || entry.coarse) return null;
    const { history, ...rest } = entry;
    return rest;
}

/** 新的 entry 接上舊版本：舊的那一版放最前面。 */
function withHistory(next, prev) {
    const old = snapshot(prev);
    const list = [...(old ? [old] : []), ...(prev?.history ?? [])].slice(0, HISTORY_MAX);
    return list.length ? { ...next, history: list } : next;
}

/** 這一層的其他版本（新的在前）。 */
export function floorVersions(index) {
    const e = getEntry(index);
    return Array.isArray(e?.history) ? e.history : [];
}

/** 換成第 k 個舊版本；現在的這一版存回版本裡（可以再換回來）。 */
export function restoreVersion(index, k) {
    const cur = getEntry(index);
    const list = floorVersions(index);
    const ver = list[k];
    if (!ver) return false;
    const rest = list.filter((_, j) => j !== k);
    const curSnap = snapshot(cur);
    const history = [...(curSnap ? [curSnap] : []), ...rest].slice(0, HISTORY_MAX);
    // at 換成現在：這一層的內容變了，所在的章會變過期（照常）。hash 用那一版的（原文改過就會顯示過期）。
    setEntry(index, { ...ver, at: Date.now(), ...(history.length ? { history } : {}) });
    saveChatSoon();
    notify(index);
    return true;
}

async function summarizeFloor(index) {
    const chatId = chatKey();
    const msg = getChat()[index];
    if (!isAiMessage(msg)) return;
    const stillHere = () => chatKey() === chatId && getChat()[index] === msg;
    let hash = floorSource(index).hash;
    try {
        const built = await buildL1Prompt(index);
        hash = built.hash;
        const raw = await generateText(built.prompt, { maxTokens: built.maxTokens, purpose: 'l1' });
        const parsed = parseL1(raw);
        if (!stillHere()) return;
        // 對照這一層之前的記事整理變化：配上 id、去掉重複新增和找不到的。
        const prev = getEntry(index);
        let ops = normalizeModelOps(parsed.ops, built.notesBefore, prev?.ops, { types: trackedNoteTypes() });
        // 粗略補建時，整段的記事變化記在這一段的最後一層；改成逐層細摘時保留下來，不然會不見。
        // 這些變化標著 block，重做幾次都會留著。
        const blockOps = Array.isArray(prev?.ops) ? prev.ops.filter((op) => op.block) : [];
        if (blockOps.length) ops = [...blockOps, ...ops.filter((op) => !blockOps.some((o) => o.id === op.id && o.op === 'add'))];
        // 沒勾的欄位模型不會回報；沿用舊值，重新勾起來時資料還在。
        const keep = (key, field) => (isTracked(key) ? parsed[field] : (prev?.[field] ?? parsed[field]));
        // 摘要途中原文被改的話，hash 對不上，會自動顯示成「過期」。
        setEntry(index, withHistory({
            v: 2, status: 'ok', time: keep('time', 'time'), location: keep('location', 'location'),
            characters: keep('cast', 'characters'), summary: parsed.summary, ops, hash, at: Date.now(), by: modelLabel(),
            // 行事曆：沒開的話沿用舊的，重新打開時資料還在。
            ...(calendarOn()
                ? { date: normDate(parsed.date) || previousDate(index), events: cleanEvents(parsed.events) }
                : { date: prev?.date ?? '', events: prev?.events ?? [] }),
            // 回憶錄：模型挑的值得珍藏的時刻（沒開的話沿用舊的）。
            keepsakes: memoriesOn() && getSettings().memories?.auto ? cleanKeepsakes(parsed.keepsakes) : (prev?.keepsakes ?? []),
            // 回覆被截斷、是救回來的：摘要或記事可能不完整，畫面上會提醒。
            ...(parsed.repaired ? { repaired: true } : {}),
        }, prev));
    } catch (e) {
        console.warn(LOG_PREFIX, `第 ${index} 層摘要失敗`, e);
        if (!stillHere()) return;
        const message = errorText(e);
        const previous = getEntry(index);
        setEntry(index, withHistory({
            v: 2, status: 'fail', error: message, hash, at: Date.now(),
            // 保留舊內容，讓使用者手動寫時可以從它改起。失敗的樓層不套用記事變化。
            time: previous?.time ?? '', location: previous?.location ?? '',
            characters: previous?.characters ?? [], summary: previous?.summary ?? '',
        }, previous));
        toast(t('toast.summaryFailed', { n: index, error: message }), 'error');
    }
    saveChatSoon();
}

// ===== ⭐ 小劇場 =====
// v0.13.15，使用者要求：「跳過」分成兩種。👻 跳過：不摘要、不呼叫模型。⭐ 小劇場：整層是番外，
// 不寫進正劇摘要、原文也不再送（和跳過一樣），但讀一次，把回憶（keepsakes）和之後正劇也算數的約定／待辦（只新增）記下。
// entry：{ status: 'side', summary（一句話，只給使用者看，不送給角色、不壓縮）, ops, keepsakes, prev（原本的 entry，取消時換回來）}。
// 讀取失敗也還是 'side'（照樣不送），帶 error，可以重新讀。

/** 跳過、小劇場前原本的 entry（取消時換回來）。 */
function baseEntry(e) {
    return e?.status === 'skip' || e?.status === 'side' ? (e.prev ?? null) : (e ?? null);
}

async function readSideFloor(index) {
    const chatId = chatKey();
    const msg = getChat()[index];
    if (!isAiMessage(msg)) return;
    // 讀的途中被取消小劇場（或改成跳過）就不寫回去。
    const stillHere = () => chatKey() === chatId && getChat()[index] === msg && getEntry(index)?.status === 'side';
    let hash = floorSource(index).hash;
    const base = () => baseEntry(getEntry(index));
    try {
        const built = await buildL1Prompt(index, { side: true });
        hash = built.hash;
        const raw = await generateText(built.prompt, { maxTokens: built.maxTokens, purpose: 'side' });
        const parsed = parseL1(raw);
        if (!stillHere()) return;
        const types = trackedNoteTypes().filter((x) => x === 'promise' || x === 'todo');
        // 只收新增的約定、待辦；其他記事不讓小劇場動。
        const ops = normalizeModelOps((parsed.ops ?? []).filter((op) => op?.op === 'add'), built.notesBefore, [], { types })
            .filter((op) => op.op === 'add' && types.includes(op.type));
        const keepsakes = memoriesOn() && getSettings().memories?.auto
            ? cleanKeepsakes(parsed.keepsakes).map((m) => ({ ...m, theater: true }))
            : [];
        setEntry(index, { v: 2, status: 'side', summary: parsed.summary, ops, keepsakes, hash, at: Date.now(), by: modelLabel(), prev: base() });
    } catch (e) {
        console.warn(LOG_PREFIX, `第 ${index} 層小劇場讀取失敗`, e);
        if (!stillHere()) return;
        const message = errorText(e);
        setEntry(index, { v: 2, status: 'side', error: message, summary: '', ops: [], keepsakes: [], hash, at: Date.now(), prev: base() });
        toast(t('toast.summaryFailed', { n: index, error: message }), 'error');
    }
    saveChatSoon();
}

/** 設成 ⭐ 小劇場：先標起來（馬上不送），再排隊讀一次。 */
export function sideFloor(index) {
    const prev = getEntry(index);
    if (prev?.status !== 'side') {
        setEntry(index, { v: 2, status: 'side', summary: '', ops: [], keepsakes: [], hash: floorSource(index).hash, at: Date.now(), pending: true, prev: baseEntry(prev) });
        saveChatSoon();
    }
    notify(index);
    return enqueue(index, { side: true });
}

export function unsideFloor(index) {
    const e = getEntry(index);
    if (e?.status !== 'side') return;
    setEntry(index, e.prev ?? null);
    saveChatSoon();
    notify(index);
}

// ===== 手動操作 =====

export function skipFloor(index) {
    const prev = getEntry(index);
    if (prev?.status === 'skip') return;
    setEntry(index, { v: 2, status: 'skip', hash: floorSource(index).hash, prev: baseEntry(prev) });
    saveChatSoon();
    notify(index);
}

export function unskipFloor(index) {
    const e = getEntry(index);
    if (e?.status !== 'skip') return;
    setEntry(index, e.prev ?? null);
    saveChatSoon();
    notify(index);
}

/** 使用者自己寫或修改摘要（時間、地點、人物、摘要）。原本的記事變化保留。 */
export function writeSummary(index, fields) {
    const summary = String(fields?.summary ?? '').trim();
    if (!summary) return false;
    const prev = getEntry(index);
    const ops = prev?.status === 'ok' && Array.isArray(prev.ops) ? prev.ops : [];
    const events = prev?.status === 'ok' && Array.isArray(prev.events) ? prev.events : [];
    const keepsakes = prev?.status === 'ok' && Array.isArray(prev.keepsakes) ? prev.keepsakes : [];
    const date = fields?.date !== undefined ? normDate(fields.date) : (prev?.date ?? '');
    setEntry(index, withHistory({
        v: 2, status: 'ok', ...cleanScene(fields), summary, ops, events, date, keepsakes,
        hash: floorSource(index).hash, at: Date.now(), manual: true, by: 'manual',
    }, prev));
    saveChatSoon();
    notify(index);
    return true;
}

/** 還沒摘要的舊樓層。「開始下回前」模式不含最新一層，它要等定案。 */
export function unsummarizedIndices() {
    const last = getSettings().summary.mode === 'before' ? lastAiIndex() : -1;
    const out = [];
    getChat().forEach((m, i) => {
        if (i !== last && isAiMessage(m) && floorStatus(i) === 'none') out.push(i);
    });
    return out;
}

// ===== 事件 =====

function onMessageSent(id) {
    if (!isActive() || getSettings().summary.mode !== 'before') return;
    const chat = getChat();
    const from = Number.isInteger(id) ? id : chat.length - 1;
    for (let i = from - 1; i >= 0; i--) {
        if (isAiMessage(chat[i])) {
            // 只自動摘要「從沒摘要過」的；過期和失敗要使用者決定。
            if (floorStatus(i) === 'none') enqueue(i);
            return;
        }
    }
}

function onGenerationStarted(type, options, dryRun) {
    if (dryRun) return;
    mainBusySince = Date.now();
}

function onGenerationDone() {
    mainBusySince = 0;
    drain();
}

/** AI 回覆完成（新回覆、重新生成、swipe、繼續寫都會觸發）。 */
function onMessageReceived(id) {
    if (isActive() && getSettings().summary.mode === 'after') {
        const chat = getChat();
        const index = Number.isInteger(id) ? id : chat.length - 1;
        const status = isAiMessage(chat[index]) ? floorStatus(index) : null;
        // 「過期」在這裡是剛被「繼續寫」接長了，不是使用者手動改的，直接重摘。
        if (status === 'none' || status === 'stale') enqueue(index);
    }
    onGenerationDone();
}

function onChatChanged() {
    queue.length = 0;
    queued.clear();
    mainBusySince = 0;
    notify(null);
}

function onMessagesShifted() {
    // 刪除訊息後索引會位移，排隊中的工作全部作廢。
    if (queue.length) cancelQueue();
}

export function initSummarizer() {
    const c = ctx();
    if (!c?.eventSource || !c.eventTypes) return;
    const ev = c.eventTypes;
    c.eventSource.on(ev.MESSAGE_SENT, onMessageSent);
    c.eventSource.on(ev.GENERATION_STARTED, onGenerationStarted);
    c.eventSource.on(ev.GENERATION_ENDED, onGenerationDone);
    c.eventSource.on(ev.GENERATION_STOPPED, onGenerationDone);
    c.eventSource.on(ev.MESSAGE_RECEIVED, onMessageReceived);
    c.eventSource.on(ev.CHAT_CHANGED, onChatChanged);
    c.eventSource.on(ev.MESSAGE_DELETED, onMessagesShifted);
}
