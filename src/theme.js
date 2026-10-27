// 外觀（v0.13.22，使用者要求）：「跟隨酒館主題」或「📒 日系手帳」。
// 手帳風的樣式在 style.css（.lp-theme-techo 開頭的那一段），這裡只負責在 <html> 加上 class，
// 以及第一次用到時載入圓體字型「粉圓」Huninn（Google Fonts，有繁體中文；載不到就用系統字型，不影響使用）。

import { getSettings } from './settings.js';

const FONT_URL = 'https://fonts.googleapis.com/css2?family=Huninn&display=swap';
let fontLoaded = false;

function loadFont() {
    if (fontLoaded || typeof document === 'undefined') return;
    fontLoaded = true;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = FONT_URL;
    link.dataset.lpFont = '1';
    document.head.appendChild(link);
}

/** 照設定切換外觀（大視窗每次重畫、設定改了、啟動時呼叫；重複呼叫沒關係）。 */
export function applyTheme() {
    if (typeof document === 'undefined') return;
    const ui = getSettings().ui ?? {};
    const techo = ui.theme === 'techo';
    const root = document.documentElement;
    root.classList.toggle('lp-theme-techo', techo);
    root.classList.toggle('lp-theme-techo-blocks', techo && Boolean(ui.themeBlocks));
    if (techo) loadFont();
}
