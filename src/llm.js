// 呼叫模型：依設定走主 API（酒館目前的連線）或自訂 API。

import { ctx } from './util.js';
import { getSettings } from './settings.js';
import { t } from './i18n.js';
import { recordUsage, roughTokens } from './usage.js';
import { ApiError, chatCompletion } from './api/custom.js';

/** 回覆是空的、或只有服務商自己的通知時，自動重試幾次（間隔）。 */
const EMPTY_RETRY_MS = [2000, 6000];
/** 額度被思考用光時，加倍再試，最多到這麼多。 */
const MAX_TOKENS_CAP = 16000;

/**
 * 有些 API 服務商在模型回了空的內容時，會自己塞一段通知（HTML 註解、<style>、<div>，例如「响应内容为空，本条免费」）。
 * 這種不能當成摘要：拿掉 HTML 註解、<style>、<script> 之後，
 * 什麼都不剩、或剩下的是 HTML 排版而且沒有 JSON（我們的提示詞不會讓模型回 HTML），就當成「空的回覆」。
 * 有正常內容、後面又被附上通知的，只拿掉註解和 <style>／<script>，其他照舊交給呼叫的地方解析。
 */
export function cleanReply(raw) {
    const text = String(raw ?? '');
    const stripped = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<(style|script)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '').trim();
    const visible = stripped.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const htmlOnly = /<(div|span|p|a|br|font|img|table)\b/i.test(stripped) && !stripped.includes('{');
    if (!visible || htmlOnly) {
        // 給使用者看的：服務商說了什麼（看得出是誰回的）。
        const comments = [...text.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1].trim()).filter(Boolean).join(' ');
        const notice = (comments || visible).slice(0, 120);
        throw new ApiError(notice ? 'empty_notice' : 'empty', notice);
    }
    return stripped;
}

function isEmptyError(e) {
    return e instanceof ApiError && (e.code === 'empty' || e.code === 'empty_notice');
}

/**
 * 呼叫模型。自動重試：空的回覆（最多 2 次）；額度被思考用光（加倍額度再試，最多 2 次）；逾時（1 次）。
 */
export async function generateText(prompt, opts = {}) {
    const first = targetId(opts.purpose);
    try {
        return await generateWith(prompt, { ...opts, target: first });
    } catch (e) {
        // 失敗時改用另一組（v0.13.35，使用者要求）：連不上、逾時、空回都換；格式不對（parse）不換。
        const backup = getSettings().fallback;
        if (!backup || backup === first || !canFallback(e)) throw e;
        console.warn('[LoversPlanner] 改用備援的 API', { from: first, to: backup, error: e?.code ?? e?.message });
        return generateWith(prompt, { ...opts, target: backup });
    }
}

function canFallback(e) {
    if (!(e instanceof ApiError)) return true;
    return !['parse'].includes(e.code);
}

async function generateWith(prompt, opts) {
    let maxTokens = opts.maxTokens ?? 512;
    let empty = 0;
    let longer = 0;
    let timeouts = 0;
    for (;;) {
        try {
            return await generateOnce(prompt, { ...opts, maxTokens });
        } catch (e) {
            if (e instanceof ApiError && e.code === 'empty_length' && longer < 2 && maxTokens < MAX_TOKENS_CAP) {
                longer++;
                maxTokens = Math.min(MAX_TOKENS_CAP, maxTokens * 2);
                continue;
            }
            if (e instanceof ApiError && e.code === 'timeout' && timeouts < 1) {
                timeouts++;
                continue;
            }
            if (!isEmptyError(e) || empty >= EMPTY_RETRY_MS.length) throw e;
            await new Promise((r) => setTimeout(r, EMPTY_RETRY_MS[empty++]));
        }
    }
}

// ===== 好幾組 API、每種工作用哪一組（v0.13.35，使用者要求） =====
// 'main' 酒館主 API；'custom' 原本那組自訂 API（settings.custom）；其他是 settings.profiles 裡的 id。
// settings.routes[工作] 是 'inherit'（跟預設：settings.source）或上面其中一個；settings.fallback 是失敗時改用的那組（空的＝不改用）。

export const ROUTES = ['l1', 'compress', 'catchup', 'diary', 'diaryCompress', 'other'];
const ROUTE_OF = { l1: 'l1', side: 'l1', compress: 'compress', catchup: 'catchup', diary: 'diary', diaryCompress: 'diaryCompress' };

/** 調用用途 → 工作（設定裡的那一列）。 */
export function routeKey(purpose) {
    return ROUTE_OF[purpose] ?? 'other';
}

/** 這種工作現在用哪一組（'main'、'custom' 或某一組的 id）。 */
export function targetId(purpose = 'other') {
    const s = getSettings();
    const r = s.routes?.[routeKey(purpose)];
    if (r && r !== 'inherit') return r;
    return s.source === 'custom' ? 'custom' : 'main';
}

/** 某一組的設定（url、key、model、name）；主 API 是 null；找不到是 undefined。 */
export function targetConfig(id) {
    const s = getSettings();
    if (id === 'main') return null;
    if (id === 'custom') return { ...s.custom, name: s.customName || '' };
    return (s.profiles ?? []).find((p) => p.id === id);
}

/** 有沒有哪種工作（或備援）會用到酒館主 API（摘要隊伍要等正常生成結束）。給 purpose 就只看那一種。 */
export function usesMain(purpose) {
    if (purpose) return targetId(purpose) === 'main';
    return ROUTES.some((k) => targetId(k) === 'main') || getSettings().fallback === 'main';
}

let lastLabel = '';

/**
 * 每次呼叫模型時放在最前面的系統提示詞（v0.13.4，使用者要求）：
 *   adultNote：說明這是成年人、雙方同意的虛構故事，親密段落照實、簡短、不露骨地記下（模型比較不會拒絕或回空）；
 *   preface：使用者自訂的前言（例如自己預設裡的說明）。
 * 注意：服務商在 API 那層擋掉的，提示詞救不了，只能換模型或服務商。
 */
export function systemText() {
    const s = getSettings().model ?? {};
    return [s.adultNote ? t('prompt.adultNote') : '', String(s.preface ?? '').trim()].filter(Boolean).join('\n\n');
}

/** 呼叫一次模型，回傳整理過的回覆（cleanReply），並記進調用紀錄（成功、失敗、空回都記；重試的每一次都算一次呼叫）。 */
async function generateOnce(prompt, { maxTokens = 512, purpose = 'other', target = targetId(purpose) } = {}) {
    const s = getSettings();
    const system = systemText();
    const cfg = targetConfig(target);
    const model = labelFor(target);
    const started = Date.now();
    const sentGuess = roughTokens(system) + roughTokens(prompt);
    let usage = null;
    let text = '';
    try {
        if (target !== 'main') {
            if (!cfg?.url || !cfg?.model) throw new ApiError('need_custom');
            const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
            // 等待時間大家共用「自訂 API」那裡的設定。
            const r = await chatCompletion({ ...cfg, timeout: s.custom?.timeout }, messages, { maxTokens });
            usage = r.usage;
            text = r.text;
        } else {
            const c = ctx();
            if (typeof c?.generateRaw !== 'function') throw new ApiError('no_main');
            // generateRaw 不帶聊天紀錄和角色設定，只送我們給的提示詞（systemPrompt 是我們的系統提示詞）。
            text = await c.generateRaw({ prompt, ...(system ? { systemPrompt: system } : {}), responseLength: maxTokens, trimNames: false });
        }
        const clean = cleanReply(text);
        lastLabel = model;
        recordUsage({ purpose, model, input: usage?.input ?? sentGuess, output: usage?.output ?? roughTokens(text), est: !usage, ms: Date.now() - started, ok: true });
        return clean;
    } catch (e) {
        // 還沒送出去就失敗的（沒設定好）不算呼叫。
        if (!(e instanceof ApiError && ['need_custom', 'no_main', 'need_url'].includes(e.code))) {
            recordUsage({ purpose, model, input: usage?.input ?? sentGuess, output: usage?.output ?? roughTokens(text), est: !usage, ms: Date.now() - started, ok: false, error: e?.code ?? e?.message ?? String(e) });
        }
        throw e;
    }
}

/** 某一組的顯示名稱（記在摘要、調用紀錄上）。 */
export function labelFor(id) {
    if (id !== 'main') {
        const cfg = targetConfig(id);
        return cfg?.model || cfg?.name || t('model.custom');
    }
    let name = '';
    try { name = ctx()?.getChatCompletionModel?.() ?? ''; } catch (e) { /* 舊版沒有 */ }
    return name ? `${t('model.main')}・${name}` : t('model.main');
}

/**
 * 現在是哪個模型在摘要（記在摘要上，方便比較不同模型寫的版本）。
 * 給 purpose：那種工作會用的；沒給：剛剛實際回覆的那一個（失敗改用備援時也對），還沒呼叫過就用預設那組。
 */
export function modelLabel(purpose) {
    if (purpose) return labelFor(targetId(purpose));
    return lastLabel || labelFor(targetId('other'));
}

/** 估算 token 數：優先用酒館的分詞器，沒有就粗估。 */
export async function countTokens(text) {
    try {
        const n = await ctx()?.getTokenCountAsync?.(text);
        if (Number.isFinite(n) && n > 0) return n;
    } catch (e) { /* 改用粗估 */ }
    const cjk = (text.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
    return Math.max(1, Math.ceil(cjk / 1.2 + (text.length - cjk) / 4));
}
