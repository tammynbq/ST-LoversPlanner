// 呼叫模型：依設定走主 API（酒館目前的連線）或自訂 API。

import { ctx } from './util.js';
import { getSettings } from './settings.js';
import { ApiError, chatCompletion } from './api/custom.js';

export async function generateText(prompt, { maxTokens = 512 } = {}) {
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
