// 外觀（v0.13.22，使用者要求）：「跟隨酒館主題」或「📒 日系手帳」；
// v0.13.24 加上白天換色版：🌱 小草淡綠（day-grass）、☁️ 白雲淺藍（day-cloud）、🌸 櫻花粉色（day-blossom）；
// v0.13.23 加上夜間護眼的手帳：🌿 淡綠（night-mint）、💧 淺藍（night-sky）、🌸 粉色（night-sakura）。
// <html> 的 class：手帳一律有 .lp-theme-techo；夜間另外有 .lp-techo-night 和 .lp-techo-mint／sky／sakura。
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
export const THEMES = ['tavern', 'techo', 'day-grass', 'day-cloud', 'day-blossom', 'night-mint', 'night-sky', 'night-sakura'];
const NIGHT = { 'night-mint': 'mint', 'night-sky': 'sky', 'night-sakura': 'sakura' };
// v0.13.24：白天的換色版（🌱 小草淡綠、☁️ 白雲淺藍、🌸 櫻花粉色）。
const DAY = { 'day-grass': 'grass', 'day-cloud': 'cloud', 'day-blossom': 'blossom' };

export function applyTheme() {
    if (typeof document === 'undefined') return;
    const ui = getSettings().ui ?? {};
    const theme = THEMES.includes(ui.theme) ? ui.theme : 'tavern';
    const techo = theme !== 'tavern';
    const night = NIGHT[theme] ?? null;
    const root = document.documentElement;
    root.classList.toggle('lp-theme-techo', techo);
    root.classList.toggle('lp-theme-techo-blocks', techo && Boolean(ui.themeBlocks));
    root.classList.toggle('lp-techo-night', Boolean(night));
    for (const v of Object.values(NIGHT)) root.classList.toggle(`lp-techo-${v}`, night === v);
    const day = DAY[theme] ?? null;
    for (const v of Object.values(DAY)) root.classList.toggle(`lp-techo-${v}`, day === v);
    if (techo) loadFont();
}
