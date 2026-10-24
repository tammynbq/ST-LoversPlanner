// 把錯誤轉成給使用者看的訊息（目前介面語言）。

import { t } from './i18n.js';
import { ApiError } from './api/custom.js';

export function errorText(e) {
    // 酒館主 API 丟出來的錯誤通常已經是一句可讀的話，直接顯示。
    if (!(e instanceof ApiError)) return String(e?.message ?? e);
    if (e.code === 'http') {
        if (e.status === 401) return t('err.401');
        if (e.status === 404) return t('err.404');
        const detail = [e.status ? `HTTP ${e.status}` : '', e.detail].filter(Boolean).join(' · ');
        return t('err.http', { detail });
    }
    return t(`err.${e.code}`, { detail: e.detail });
}
