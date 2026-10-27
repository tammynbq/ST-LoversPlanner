// 自訂 API（OpenAI 相容格式）：拉取模型、呼叫模型、測試連接。
//
// TauriTavern 不會代理跨網域請求，對方沒開 CORS 時直接 fetch 會失敗。
// 所以先直接連；遇到網路／CORS 錯誤，再改走酒館後端的轉發
// （/api/backends/chat-completions/*，同源，由宿主處理），
// 用 custom_include_headers 帶上我們自己的 Key。

import { ctx } from '../util.js';

/** 預設等多久（拉模型清單、測試連接）。呼叫模型用設定的 custom.timeout（v0.13.10 起預設 120 秒）。 */
const TIMEOUT_MS = 30000;

export class ApiError extends Error {
    /**
     * @param {'need_url'|'need_custom'|'no_main'|'http'|'network'|'timeout'|'bad_response'|'empty'|'empty_notice'|'empty_length'|'parse'} code
     */
    constructor(code, message = '', status = 0) {
        super(message || code);
        this.code = code;
        this.status = status;
        this.detail = message;
    }
}

/** 整理網址：去掉結尾的斜線，以及使用者誤貼的 /chat/completions、/models。 */
export function normalizeBaseUrl(url) {
    return String(url || '').trim()
        .replace(/\/+$/, '')
        .replace(/\/(chat\/completions|completions|models)$/, '');
}

export function authHeaders(key) {
    return key ? { Authorization: `Bearer ${key}` } : {};
}

/** 給酒館後端的額外標頭（YAML 格式）。 */
function includeHeadersYaml(key) {
    return key ? `Authorization: ${JSON.stringify(`Bearer ${key}`)}` : '';
}

function backendHeaders() {
    try {
        const h = ctx()?.getRequestHeaders?.();
        if (h) return h;
    } catch (e) { /* 舊版沒有 */ }
    return { 'Content-Type': 'application/json' };
}

export async function fetchJson(url, options, timeoutMs = TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(url, { ...options, signal: controller.signal });
    } catch (e) {
        if (e?.name === 'AbortError') throw new ApiError('timeout');
        // 連不上、DNS 錯誤、被 CORS 擋，瀏覽器都只給 TypeError。
        throw new ApiError('network', e?.message);
    } finally {
        clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) throw new ApiError('http', errorDetail(text), res.status);
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new ApiError('bad_response', text.slice(0, 120));
    }
}

function errorDetail(text) {
    try {
        const j = JSON.parse(text);
        const msg = j?.error?.message ?? j?.message ?? j?.error;
        if (typeof msg === 'string') return msg.slice(0, 160);
    } catch (e) { /* 不是 JSON */ }
    return String(text || '').slice(0, 160);
}

/** 先直接連，網路／CORS 錯誤時改走酒館後端。回傳 { json, via }。 */
async function withFallback(direct, backend) {
    try {
        return { json: await direct(), via: 'direct' };
    } catch (e) {
        if (!(e instanceof ApiError) || e.code !== 'network') throw e;
    }
    return { json: await backend(), via: 'backend' };
}

export function parseModels(json) {
    const list = Array.isArray(json) ? json : (json?.data ?? json?.models ?? []);
    if (!Array.isArray(list)) return [];
    const ids = list
        .map((m) => (typeof m === 'string' ? m : (m?.id ?? m?.name)))
        .filter((id) => typeof id === 'string' && id.trim());
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** 拉取模型清單。 */
export async function listModels({ url, key }) {
    const base = normalizeBaseUrl(url);
    if (!base) throw new ApiError('need_url');
    const { json, via } = await withFallback(
        () => fetchJson(`${base}/models`, { headers: authHeaders(key) }),
        () => fetchJson('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: backendHeaders(),
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: base,
                custom_include_headers: includeHeadersYaml(key),
            }),
        }),
    );
    if (json?.error) throw new ApiError('http', typeof json.error === 'string' ? json.error : '', 0);
    return { models: parseModels(json), via };
}

/** 呼叫模型，回傳文字。 */
export async function chatCompletion({ url, key, model, timeout }, messages, { maxTokens = 512, temperature } = {}) {
    // 會先「思考」的模型、比較慢的服務商常常要超過 30 秒（使用者回報部的壓縮常逾時）。
    const wait = Math.min(600, Math.max(30, Number(timeout) || 120)) * 1000;
    const base = normalizeBaseUrl(url);
    if (!base) throw new ApiError('need_url');
    const body = { model, messages, max_tokens: maxTokens, stream: false };
    if (temperature !== undefined) body.temperature = temperature;
    const { json, via } = await withFallback(
        () => fetchJson(`${base}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders(key) },
            body: JSON.stringify(body),
        }, wait),
        () => fetchJson('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: backendHeaders(),
            body: JSON.stringify({
                ...body,
                chat_completion_source: 'custom',
                custom_url: base,
                custom_include_headers: includeHeadersYaml(key),
            }),
        }, wait),
    );
    if (json?.error) {
        const msg = json.error?.message ?? (typeof json.error === 'string' ? json.error : '');
        throw new ApiError('http', msg, 0);
    }
    const choice = json?.choices?.[0];
    const text = choice?.message?.content ?? choice?.text;
    // 額度用完了、內容卻是空的：會思考的模型把額度都花在思考上了（llm.js 會加倍額度再試）。
    if ((text === null || text === undefined || (typeof text === 'string' && !text.trim())) && choice?.finish_reason === 'length') {
        throw new ApiError('empty_length');
    }
    if (typeof text !== 'string') throw new ApiError('bad_response', JSON.stringify(json).slice(0, 120));
    // 服務商回報的實際用量（調用紀錄用）；沒有就是 null。
    const u = json?.usage;
    const usage = u && (Number.isFinite(u.prompt_tokens) || Number.isFinite(u.completion_tokens))
        ? { input: Number(u.prompt_tokens) || 0, output: Number(u.completion_tokens) || 0 } : null;
    return { text, via, usage };
}

/**
 * 測試連接：有選模型就真的叫模型回一句話；沒選模型就只拉模型清單。
 * 回傳 { kind: 'reply', reply, via } 或 { kind: 'models', count, via }。
 */
export async function testConnection(cfg) {
    if (cfg.model) {
        const { text, via } = await chatCompletion(cfg, [{ role: 'user', content: 'Reply with the single word: OK' }], { maxTokens: 16 });
        return { kind: 'reply', reply: text.trim().slice(0, 40), via };
    }
    const { models, via } = await listModels(cfg);
    return { kind: 'models', count: models.length, via };
}
