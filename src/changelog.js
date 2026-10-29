// 更新通知（v0.13.30，使用者要求）：更新後打開大視窗，最上面有一張「更新了什麼」的卡片，魔術棒選單上有 NEW。
// 按「知道了」記下看過的版本（settings.ui.seenVersion），下次有新版本才再出現。
// 只有 notes 裡寫了東西的版本才算「有消息」；只修小錯、使用者感覺不到的版本不寫，就不會跳通知。
// 用使用者看得懂的話寫，不寫程式術語。新的放最前面。

import { getSettings, saveSettings } from './settings.js';
import { currentLocale } from './i18n.js';
import { VERSION } from './version.js';

export const CHANGES = [
    {
        v: '0.13.30',
        new: {
            'zh-TW': [
                '🔍 每則 AI 回覆下面的摘要區塊可以點開「這一回送了什麼」：送了哪些記事、向量和關鍵字找回哪些舊樓層（相似度多少）、想起哪條回憶，還有向量有沒有正常運作。',
                '🎉 更新之後打開戀人手帳，會看到這張「更新了什麼」的卡片。',
            ],
            'zh-CN': [
                '🔍 每条 AI 回复下面的摘要区块可以点开「这一回发送了什么」：发送了哪些记事、向量和关键词找回哪些旧楼层（相似度多少）、想起哪条回忆，还有向量有没有正常运作。',
                '🎉 更新之后打开恋人手帐，会看到这张「更新了什么」的卡片。',
            ],
            en: [
                '🔍 Each AI reply\'s summary block now has "What was sent this turn": which notes were sent, which older floors vectors and keywords recalled (with similarity), which memory was brought up, and whether vectors worked.',
                '🎉 After an update, opening Lover\'s Planner shows this "What\'s new" card.',
            ],
        },
    },
    {
        v: '0.13.29',
        fix: {
            'zh-TW': ['3000 多則的長聊天打開會卡住好幾分鐘，修好了。'],
            'zh-CN': ['3000 多条的长聊天打开会卡住好几分钟，修好了。'],
            en: ['Opening a chat with 3000+ messages no longer freezes for minutes.'],
        },
    },
    {
        v: '0.13.28',
        fix: {
            'zh-TW': ['長聊天打開、送出、切換大視窗分頁都變快很多。'],
            'zh-CN': ['长聊天打开、发送、切换大窗口分页都变快很多。'],
            en: ['Long chats open, send and switch panel tabs much faster.'],
        },
    },
    {
        v: '0.13.27',
        fix: {
            'zh-TW': ['⭐ 小劇場排隊時換聊天，會變成「標了但沒讀」：現在摘要區塊會說明，🩺 檢查也會列出，可以一鍵補讀。'],
            'zh-CN': ['⭐ 小剧场排队时换聊天，会变成「标了但没读」：现在摘要区块会说明，🩺 检查也会列出，可以一键补读。'],
            en: ['A ⭐ side scene queued while switching chats could end up marked but unread. The block now says so, and 🩺 Checkup lists it with a one-click re-read.'],
        },
    },
    {
        v: '0.13.26',
        new: {
            'zh-TW': ['🌱 草地綠、☁️ 天空藍改成完整的主題（小山丘、幸運草、藍天白雲）。'],
            'zh-CN': ['🌱 草地绿、☁️ 天空蓝改成完整的主题（小山丘、幸运草、蓝天白云）。'],
            en: ['🌱 Meadow green and ☁️ sky blue are now full themes (hills and clovers, blue sky and clouds).'],
        },
    },
    {
        v: '0.13.25',
        new: {
            'zh-TW': ['🌸 花朵粉色主題：花圈標題列、花瓣分頁、壓花貼紙。'],
            'zh-CN': ['🌸 花朵粉色主题：花圈标题栏、花瓣分页、压花贴纸。'],
            en: ['🌸 Blossom pink theme: flower-wreath header, petal tabs, pressed-flower stickers.'],
        },
    },
    {
        v: '0.13.22',
        new: {
            'zh-TW': ['📔 外觀可以選日系手帳主題，聊天裡的摘要區塊也能一起換。'],
            'zh-CN': ['📔 外观可以选日系手账主题，聊天里的摘要区块也能一起换。'],
            en: ['📔 A Japanese planner theme, optionally applied to the summary blocks in chat too.'],
        },
    },
    {
        v: '0.13.20',
        new: {
            'zh-TW': ['💝 回憶錄可以帶到同角色的新聊天（複製帶走或即時共用）。'],
            'zh-CN': ['💝 回忆录可以带到同角色的新聊天（复制带走或实时共享）。'],
            en: ['💝 The memory book can be carried into new chats with the same character (copy or share live).'],
        },
    },
    {
        v: '0.13.19',
        new: {
            'zh-TW': ['🌍 配角可以從世界書填寫。'],
            'zh-CN': ['🌍 配角可以从世界书填写。'],
            en: ['🌍 Supporting characters can be filled in from the lorebook.'],
        },
    },
    {
        v: '0.13.18',
        new: {
            'zh-TW': ['約定記得更完整（要做什麼、什麼時候、誰答應誰），行程也併進約定。'],
            'zh-CN': ['约定记得更完整（要做什么、什么时候、谁答应谁），行程也并进约定。'],
            en: ['Promises are recorded in more detail (what, when, who promised whom), and plans are merged into promises.'],
        },
    },
];

/** 比較版本號：a 比 b 新回傳正數。 */
export function compareVersions(a, b) {
    const pa = String(a).split('.').map((x) => Number(x) || 0);
    const pb = String(b).split('.').map((x) => Number(x) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d) return d;
    }
    return 0;
}

const pick = (byLocale) => (byLocale ? (byLocale[currentLocale()] ?? byLocale['zh-TW'] ?? []) : []);

/** 一個版本的內容：{ v, news: [...], fixes: [...] }（照目前語言）。 */
export function entryText(entry) {
    return { v: entry.v, news: pick(entry.new), fixes: pick(entry.fix) };
}

/** 看過的版本；空字串表示有這個功能之前就裝了（只顯示這一版的）。 */
export function seenVersion() {
    return getSettings().ui?.seenVersion ?? '';
}

/** 還沒看過的更新（新的在前）。沒有就回傳空陣列。 */
export function unseenChanges() {
    const seen = seenVersion();
    if (seen && compareVersions(seen, VERSION) >= 0) return [];
    return CHANGES
        .filter((c) => compareVersions(c.v, VERSION) <= 0 && (seen ? compareVersions(c.v, seen) > 0 : c.v === VERSION))
        .map(entryText)
        .filter((c) => c.news.length || c.fixes.length);
}

export function hasNews() {
    return unseenChanges().length > 0;
}

const listeners = new Set();
export function onSeenChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** 按了「知道了」。 */
export function markSeen() {
    const s = getSettings();
    s.ui = { ...(s.ui ?? {}), seenVersion: VERSION };
    saveSettings();
    for (const fn of listeners) fn();
}

export function allChanges() {
    return CHANGES.filter((c) => compareVersions(c.v, VERSION) <= 0).map(entryText);
}
