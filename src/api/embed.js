// 向量模型（OpenAI 相容的 /embeddings）：把文字轉成向量，用來找「意思相近」的記事和舊回憶。
//
// 只直接連：酒館後端沒有通用的 embeddings 轉發，所以對方要允許跨網域連線（CORS）。

import { ApiError, authHeaders, fetchJson, normalizeBaseUrl } from './custom.js';

/** 一次最多送幾段文字（太多容易逾時或超過對方上限）。 */
const BATCH = 32;

/** 把一批文字轉成向量，回傳和 inputs 同順序的 number[][]。 */
export async function embedTexts({ url, key, model }, inputs) {
    const base = normalizeBaseUrl(url).replace(/\/embeddings$/, '');
    if (!base) throw new ApiError('need_url');
    if (!model) throw new ApiError('need_model');
    const out = [];
    for (let k = 0; k < inputs.length; k += BATCH) {
        const chunk = inputs.slice(k, k + BATCH);
        const json = await fetchJson(`${base}/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders(key) },
            body: JSON.stringify({ model, input: chunk }),
        });
        const list = Array.isArray(json?.data) ? [...json.data] : null;
        if (!list || list.length !== chunk.length) throw new ApiError('bad_response', JSON.stringify(json).slice(0, 120));
        list.sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
        for (const item of list) {
            const v = item?.embedding;
            if (!Array.isArray(v) || !v.length) throw new ApiError('bad_response', JSON.stringify(item).slice(0, 120));
            out.push(v);
        }
    }
    return out;
}

/** 測試連接：轉一句話，回傳向量的維度。 */
export async function testEmbedding(cfg) {
    const [v] = await embedTexts(cfg, ['戀人手帳 Lover\'s Planner']);
    return { dims: v.length };
}

export function cosine(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
