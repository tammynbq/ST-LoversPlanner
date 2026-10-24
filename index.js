// 戀人手帳（Lover's Planner）入口。
// 規格與進度：SPEC.md。

import { ctx, LOG_PREFIX } from './src/util.js';
import { initSettings } from './src/settings.js';
import { initSummarizer } from './src/summarize.js';
import { mountSettingsDrawer, mountWandEntry, relabelEntries } from './src/ui/entry.js';
import { initMessageBlocks, renderAllBlocks } from './src/ui/message.js';
import { refreshPanel, setPanelHooks } from './src/ui/panel.js';

function onSettingChanged(path) {
    if (path === 'language') relabelEntries();
    // 這些設定會改變聊天畫面上摘要區塊的樣子或提示。
    if (['language', 'enabled', 'summary.mode'].includes(path)) renderAllBlocks();
}

async function start() {
    // TauriTavern 要等宿主就緒；一般 SillyTavern 沒有這個物件，直接往下走。
    try {
        await (globalThis.__TAURITAVERN__?.ready ?? globalThis.__TAURITAVERN_MAIN_READY__);
    } catch (e) {
        console.warn(LOG_PREFIX, '等待 TauriTavern 就緒失敗，繼續載入', e);
    }

    initSettings();
    setPanelHooks({ onSettingChanged });
    mountWandEntry();
    mountSettingsDrawer();
    initSummarizer();
    initMessageBlocks();
    renderAllBlocks();

    const c = ctx();
    if (c?.eventSource && c.eventTypes) {
        c.eventSource.on(c.eventTypes.CHAT_CHANGED, refreshPanel);
    }
    console.log(LOG_PREFIX, '已載入');
}

jQuery(async () => {
    try {
        await start();
    } catch (e) {
        console.error(LOG_PREFIX, '載入失敗', e);
    }
});
