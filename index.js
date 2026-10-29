// 戀人手帳（Lover's Planner）入口。
// 規格與進度：SPEC.md。

import { ctx, LOG_PREFIX } from './src/util.js';
import { initSettings } from './src/settings.js';
import { initSummarizer } from './src/summarize.js';
import { initNotes } from './src/notes.js';
import { clearInjection, initHiding } from './src/hide.js';
import { initCompression } from './src/compress.js';
import { initAttention } from './src/ui/attention.js';
import { mountSettingsDrawer, mountWandEntry, relabelEntries } from './src/ui/entry.js';
import { initMessageBlocks, renderAllBlocks } from './src/ui/message.js';
import { refreshPanel, setPanelHooks } from './src/ui/panel.js';
import { initUpdateWatch } from './src/update.js';
import { initCarry, onChatOpened } from './src/carry.js';
import { initCatchup } from './src/catchup.js';
import { scheduleStHide, syncStHide } from './src/sthide.js';
import { onSummaryChange } from './src/summarize.js';
import { mergePlans } from './src/planmerge.js';
import { applyTheme } from './src/theme.js';
import { initSent } from './src/sent.js';
import { initEggs } from './src/eggs.js';

function onSettingChanged(path) {
    if (path === 'language') relabelEntries();
    // 這些設定會改變聊天畫面上摘要區塊的樣子或提示。
    if (['language', 'enabled', 'summary.mode', 'hide.markHidden'].includes(path) || path.startsWith('track.') || path.startsWith('calendar.')) renderAllBlocks();
    if (path === 'enabled') clearInjection();
    // 用酒館的隱藏標起舊樓層：開關或停用時馬上同步（關掉就全部取消）。
    if (path === 'hide.stHide' || path === 'enabled') {
        syncStHide();
        renderAllBlocks();
    }
}

async function start() {
    // TauriTavern 要等宿主就緒；一般 SillyTavern 沒有這個物件，直接往下走。
    try {
        await (globalThis.__TAURITAVERN__?.ready ?? globalThis.__TAURITAVERN_MAIN_READY__);
    } catch (e) {
        console.warn(LOG_PREFIX, '等待 TauriTavern 就緒失敗，繼續載入', e);
    }

    initSettings();
    applyTheme();
    setPanelHooks({ onSettingChanged });
    mountWandEntry();
    mountSettingsDrawer();
    initNotes();
    initSummarizer();
    initHiding();
    initCompression();
    initCarry();
    initCatchup();
    initAttention();
    initSent();
    initEggs();
    initMessageBlocks();
    renderAllBlocks();
    initUpdateWatch();
    // 啟動時已經開著的聊天，也走一次「打開聊天」的流程。
    onChatOpened().catch((e) => console.error(LOG_PREFIX, e));
    try { mergePlans(); } catch (e) { console.error(LOG_PREFIX, e); }

    const c = ctx();
    if (c?.eventSource && c.eventTypes) {
        c.eventSource.on(c.eventTypes.CHAT_CHANGED, refreshPanel);
        // 換聊天時清掉上一個聊天的注入；下一次生成時攔截器會重新算。
        c.eventSource.on(c.eventTypes.CHAT_CHANGED, clearInjection);
        c.eventSource.on(c.eventTypes.CHAT_CHANGED, scheduleStHide);
        // 以前的行程轉成約定（每個聊天一次，v0.13.18）。
        c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => { try { mergePlans(); } catch (e) { console.error(LOG_PREFIX, e); } });
    }
    // 摘要、壓縮變了：用酒館隱藏標起來的樓層跟著同步。
    onSummaryChange(scheduleStHide);
    scheduleStHide();
    console.log(LOG_PREFIX, '已載入');
}

jQuery(async () => {
    try {
        await start();
    } catch (e) {
        console.error(LOG_PREFIX, '載入失敗', e);
    }
});
