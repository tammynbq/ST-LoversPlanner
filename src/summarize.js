// L1 單層摘要：排隊、組提示詞、呼叫模型、解析結果、寫回訊息。
//
// 自動模式：使用者送出下一句時，才摘要上一個 AI 樓層（那時才算定案，swipe 不會浪費額度）。
// 走主 API 時，等酒館這一輪生成結束才開始，避免和正常生成搶同一條連線。

import { ctx, hasCharacterChat, isGroupChat, LOG_PREFIX, toast } from './util.js';
import { getSettings } from './settings.js';
import { currentLocale, t } from './i18n.js';
import { getTemplate } from './prompts.js';
import { ApiError } from './api/custom.js';
import { countTokens, generateText } from './llm.js';
import { errorText } from './errors.js';
import {
    chatKey, floorSource, floorStatus, getChat, getEntry, isAiMessage, lastAiIndex, saveChatSoon, setEntry,
} from './chat.js';

/** 主 API 正在生成時，超過這麼久沒收到結束事件就當作已經結束（避免卡住）。 */
const MAIN_BUSY_TIMEOUT_MS = 3 * 60 * 1000;

const queue = []; // { index, chatId }
const queued = new Set();
let running = null; // 正在摘要的 index
let mainBusySince = 0;
const listeners = new Set();

export function onSummaryChange(fn) {
    listeners.add(fn);
}

function notify(index) {
    for (const fn of listeners) {
        try { fn(index); } catch (e) { console.error(LOG_PREFIX, e); }
    }
}

export function isActive() {
    return getSettings().enabled && hasCharacterChat() && !isGroupChat();
}

/** 畫面用的狀態：存起來的狀態，再加上「排隊中／摘要中」。 */
export function floorState(index) {
    if (running === index) return 'busy';
    if (queued.has(index)) return 'queued';
    return floorStatus(index);
}

export function pendingCount() {
    return queue.length + (running === null ? 0 : 1);
}

export function enqueue(index, { front = false } = {}) {
    if (!isActive() || !isAiMessage(getChat()[index])) return false;
    if (queued.has(index) || running === index) return true;
    const item = { index, chatId: chatKey() };
    if (front) queue.unshift(item);
    else queue.push(item);
    queued.add(index);
    notify(index);
    drain();
    return true;
}

export function cancelQueue() {
    queue.length = 0;
    queued.clear();
    notify(null);
}

function mainBusy() {
    return mainBusySince > 0 && Date.now() - mainBusySince < MAIN_BUSY_TIMEOUT_MS;
}

async function drain() {
    if (running !== null) return;
    if (getSettings().source === 'main' && mainBusy()) return;
    const item = queue.shift();
    if (!item) return;
    queued.delete(item.index);
    if (item.chatId !== chatKey()) {
        drain();
        return;
    }
    running = item.index;
    notify(item.index);
    try {
        await summarizeFloor(item.index);
    } finally {
        running = null;
        notify(item.index);
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

export async function buildL1Prompt(index) {
    const s = getSettings();
    const c = ctx();
    const src = floorSource(index);
    const parts = [];
    if (s.summary.includeUser) {
        for (const u of src.users) parts.push(`${u.name ?? c?.name1 ?? 'User'}: ${u.mes}`);
    }
    parts.push(`${src.ai.name ?? c?.name2 ?? 'Character'}: ${src.ai.mes}`);
    const content = parts.join('\n\n');

    const tokens = await countTokens(content);
    const ratio = (s.summary.ratioMin + s.summary.ratioMax) / 200;
    const targetTokens = Math.min(s.summary.maxTokens, Math.max(s.summary.minTokens, Math.round(tokens * ratio)));
    const prompt = fillTemplate(getTemplate('l1'), {
        char: c?.name2 ?? '',
        user: c?.name1 ?? '',
        length: lengthUnits(content, tokens, targetTokens),
        content,
        notes: t('prompt.noNotes'),
    });
    // 摘要本身 + 記事 JSON 的空間。
    return { prompt, hash: src.hash, maxTokens: targetTokens * 2 + 400 };
}

// ===== 解析結果 =====

export function parseL1(raw) {
    const text = String(raw ?? '').trim();
    if (!text) throw new ApiError('empty');
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try {
            const obj = JSON.parse(cleaned.slice(start, end + 1));
            if (typeof obj?.summary === 'string' && obj.summary.trim()) {
                return { summary: obj.summary.trim(), ops: Array.isArray(obj.ops) ? obj.ops : [] };
            }
        } catch (e) { /* 往下判斷 */ }
    }
    // 模型沒照 JSON 格式，但給了一段純文字：直接當摘要用。
    if (start === -1) return { summary: cleaned, ops: [] };
    throw new ApiError('parse', text.slice(0, 120));
}

// ===== 摘要一層 =====

async function summarizeFloor(index) {
    const chatId = chatKey();
    const msg = getChat()[index];
    if (!isAiMessage(msg)) return;
    const stillHere = () => chatKey() === chatId && getChat()[index] === msg;
    let hash = floorSource(index).hash;
    try {
        const built = await buildL1Prompt(index);
        hash = built.hash;
        const raw = await generateText(built.prompt, { maxTokens: built.maxTokens });
        const { summary, ops } = parseL1(raw);
        if (!stillHere()) return;
        // 摘要途中原文被改的話，hash 對不上，會自動顯示成「過期」。
        setEntry(index, { v: 1, status: 'ok', summary, ops, hash, at: Date.now() });
    } catch (e) {
        console.warn(LOG_PREFIX, `第 ${index} 層摘要失敗`, e);
        if (!stillHere()) return;
        const message = errorText(e);
        const previous = getEntry(index);
        setEntry(index, {
            v: 1, status: 'fail', error: message, hash, at: Date.now(),
            // 保留舊摘要，讓使用者手動寫時可以從它改起。
            summary: previous?.summary ?? '',
        });
        toast(t('toast.summaryFailed', { n: index, error: message }), 'error');
    }
    saveChatSoon();
}

// ===== 手動操作 =====

export function skipFloor(index) {
    const prev = getEntry(index);
    if (prev?.status === 'skip') return;
    setEntry(index, { v: 1, status: 'skip', hash: floorSource(index).hash, prev: prev ?? null });
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

/** 使用者自己寫或修改摘要。 */
export function writeSummary(index, text) {
    const summary = String(text ?? '').trim();
    if (!summary) return false;
    setEntry(index, { v: 1, status: 'ok', summary, ops: [], hash: floorSource(index).hash, at: Date.now(), manual: true });
    saveChatSoon();
    notify(index);
    return true;
}

/** 還沒摘要的舊樓層（不含最新一層，它要等定案）。 */
export function unsummarizedIndices() {
    const last = lastAiIndex();
    const out = [];
    getChat().forEach((m, i) => {
        if (i !== last && isAiMessage(m) && floorStatus(i) === 'none') out.push(i);
    });
    return out;
}

// ===== 事件 =====

function onMessageSent(id) {
    if (!isActive() || getSettings().summary.mode !== 'auto') return;
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
    c.eventSource.on(ev.MESSAGE_RECEIVED, onGenerationDone);
    c.eventSource.on(ev.CHAT_CHANGED, onChatChanged);
    c.eventSource.on(ev.MESSAGE_DELETED, onMessagesShifted);
}
