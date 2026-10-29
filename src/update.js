// 更新後自動重新整理（使用者要求）。
//
// 在擴充管理裡按「更新」只會換掉檔案，頁面跑的還是舊程式，要重新整理才會用到新版。
// 所以每隔一陣子讀一次 manifest.json：版本和載入時不一樣，就等手邊的事做完（生成、摘要、
// 大視窗開著）再自動重新整理。輸入框裡還沒送出的字先存起來，重新整理後放回去。

import { LOG_PREFIX, toast } from './util.js';
import { getSettings } from './settings.js';
import { t } from './i18n.js';
import { mainBusy, pendingCount } from './summarize.js';
import { isPanelOpen } from './ui/panel.js';

const MANIFEST_URL = new URL('../manifest.json', import.meta.url).href;
const CHECK_MS = 10000;
const BUSY_RETRY_MS = 2000;
/** 提示之後等多久才重新整理（也讓設定、聊天的延遲存檔有時間寫完）。 */
const RELOAD_DELAY_MS = 3000;
const DRAFT_KEY = 'lovers_planner_reload_draft';
const RELOADED_KEY = 'lovers_planner_reloaded_for';

let loadedVersion = null;
let pendingVersion = null;
let reloadTimer = null;

async function readVersion() {
    try {
        const res = await fetch(`${MANIFEST_URL}?_=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return null;
        const v = (await res.json())?.version;
        return typeof v === 'string' ? v : null;
    } catch (e) {
        return null;
    }
}

function storage() {
    try { return globalThis.sessionStorage ?? null; } catch (e) { return null; }
}

function busy() {
    return mainBusy() || pendingCount({ tasks: true }) > 0 || isPanelOpen();
}

function reloadNow() {
    reloadTimer = null;
    if (busy()) {
        reloadTimer = setTimeout(reloadNow, BUSY_RETRY_MS);
        return;
    }
    const s = storage();
    try {
        const draft = document.getElementById('send_textarea')?.value ?? '';
        if (draft) s?.setItem(DRAFT_KEY, draft);
        // 同一個版本只自動重新整理一次，萬一快取讓舊程式又被載入，也不會一直重新整理。
        s?.setItem(RELOADED_KEY, pendingVersion);
    } catch (e) { /* 存不了就算了 */ }
    console.log(LOG_PREFIX, `更新到 ${pendingVersion}，重新整理`);
    globalThis.location.reload();
}

/** 這次載入的版本（manifest.json 的 version）。 */
export function getLoadedVersion() {
    return loadedVersion;
}

/** 讀一次 manifest；版本變了就排定重新整理。回傳讀到的版本。 */
export async function checkForUpdate() {
    if (!getSettings().update?.autoReload || pendingVersion) return null;
    const v = await readVersion();
    if (!v || !loadedVersion || v === loadedVersion) return v;
    if (storage()?.getItem(RELOADED_KEY) === v) return v;
    pendingVersion = v;
    toast(t('update.reloading', { version: v }), 'info');
    if (!reloadTimer) reloadTimer = setTimeout(reloadNow, RELOAD_DELAY_MS);
    return v;
}

/** 重新整理前存起來的輸入框內容，放回去。 */
function restoreDraft() {
    const s = storage();
    const draft = s?.getItem(DRAFT_KEY);
    if (!draft) return;
    s.removeItem(DRAFT_KEY);
    const box = document.getElementById('send_textarea');
    if (box && !box.value) {
        box.value = draft;
        box.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

export async function initUpdateWatch() {
    restoreDraft();
    loadedVersion = await readVersion();
    if (!loadedVersion) return;
    console.debug(LOG_PREFIX, `版本 ${loadedVersion}`);
    const check = () => {
        if (document.visibilityState === 'visible') checkForUpdate();
    };
    setInterval(check, CHECK_MS);
    document.addEventListener('visibilitychange', check);
    globalThis.addEventListener?.('focus', check);
}
