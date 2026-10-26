// 呼叫模型：依設定走主 API（酒館目前的連線）或自訂 API。

import { ctx } from './util.js';
import { getSettings } from './settings.js';
import { ApiError, chatCompletion } from './api/custom.js';

/** 回覆是空的、或只有服務商自己的通知時，自動重試幾次（間隔）。 */
const EMPTY_RETRY_MS = [2000, 6000];

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

export async function generateText(prompt, opts = {}) {
    for (let k = 0; ; k++) {
        try {
            return cleanReply(await generateOnce(prompt, opts));
        } catch (e) {
            if (!isEmptyError(e) || k >= EMPTY_RETRY_MS.length) throw e;
            await new Promise((r) => setTimeout(r, EMPTY_RETRY_MS[k]));
        }
    }
}

async function generateOnce(prompt, { maxTokens = 512 } = {}) {
    const s = getSettings();
    if (s.source === 'custom') {
        if (!s.custom.url || !s.custom.model) throw new ApiError('need_custom');
        const { text } = await chatCompletion(s.custom, [{ role: 'user', content: prompt }], { maxTokens });
        return text;
    }
    const c = ctx();
    if (typeof c?.generateRaw !== 'function') throw new ApiError('no_main');
    // generateRaw 不帶聊天紀錄和角色設定，只送我們給的提示詞。
    return await c.generateRaw({ prompt, responseLength: maxTokens, trimNames: false });
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
