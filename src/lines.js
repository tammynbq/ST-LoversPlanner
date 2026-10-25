// 摘要的一行格式：［時間｜地點｜人物］摘要。注入和壓縮共用。

import { isTracked } from './settings.js';

/** label：放在最前面的標籤（例如「第 3 章」），沒有就不放。 */
export function sceneLine(entry, label = '') {
    // 沒勾選要記錄的欄位不放進去。
    const head = [
        label,
        isTracked('time') ? entry.time : '',
        isTracked('location') ? entry.location : '',
        isTracked('cast') ? (entry.characters ?? []).join('、') : '',
    ].filter(Boolean).join('｜');
    return head ? `［${head}］${entry.summary}` : entry.summary;
}
