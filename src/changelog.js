// 更新通知（v0.13.30，使用者要求）：更新後打開大視窗，最上面有一張「更新了什麼」的卡片，魔術棒選單上有 NEW。
// 按「知道了」記下看過的版本（settings.ui.seenVersion），下次有新版本才再出現。
// 只有 notes 裡寫了東西的版本才算「有消息」；只修小錯、使用者感覺不到的版本不寫，就不會跳通知。
// 用使用者看得懂的話寫，不寫程式術語。新的放最前面。

import { getSettings, saveSettings } from './settings.js';
import { currentLocale } from './i18n.js';
import { VERSION } from './version.js';

export const CHANGES = [
    {
        v: '0.13.35',
        new: {
            'zh-TW': ['🔀 可以多存幾組 API，再選每種工作用哪一組（例如單層摘要用便宜的、壓縮和日記再壓一次用細膩的），還能設定「失敗時改用」另一組自動再試一次。在設定 › 模型來源。'],
            'zh-CN': ['🔀 可以多存几组 API，再选每种工作用哪一组（例如单层摘要用便宜的、压缩和日记再压一次用细腻的），还能设定「失败时改用」另一组自动再试一次。在设置 › 模型来源。'],
            en: ['🔀 Save several API groups and choose which job uses which (e.g. a cheap one for floor summaries, a careful one for compression and diary re-compress), plus a fallback group that is retried automatically on failure. In Settings › Model source.'],
        },
    },
    {
        v: '0.13.34',
        new: {
            'zh-TW': [
                '📖 日記：舊聊天整理讀完之後，可以把每一天寫成一篇日記（太長的一天分段寫）。已經有摘要的樓層用摘要，不用重讀原文，省很多。',
                '✍️ 日記寫法可以選「自然」（像回憶，有心情）或「精簡」（像紀錄）；每一天也能單獨換寫法重寫。OOC 不會寫進日記。',
                '🗜️ 再壓一次：先勾要留的重點、選壓到多少，原版一直留著，壓得不好可以換回來；也可以把超過多少字的日子一起壓。',
            ],
            'zh-CN': [
                '📖 日记：旧聊天整理读完之后，可以把每一天写成一篇日记（太长的一天分段写）。已经有摘要的楼层用摘要，不用重读原文，省很多。',
                '✍️ 日记写法可以选「自然」（像回忆，有心情）或「精简」（像记录）；每一天也能单独换写法重写。OOC 不会写进日记。',
                '🗜️ 再压一次：先勾要留的重点、选压到多少，原版一直留着，压得不好可以换回来；也可以把超过多少字的日子一起压。',
            ],
            en: [
                '📖 Diary: after reading old chats, each day can be written as a diary entry (long days in parts). Floors that already have a summary send the summary instead of the original, which saves a lot.',
                '✍️ Choose a natural (like a memory, with feelings) or concise (like a record) style, and rewrite single days in the other style. OOC is never written into the diary.',
                '🗜️ Re-compress: tick the points to keep and pick how short; the original is always kept so you can switch back. Days over a length can be compressed together.',
            ],
        },
    },
    {
        v: '0.13.33',
        new: {
            'zh-TW': ['📦 舊聊天整理（日記的第一步）：摘要分頁可以直接讀同角色的舊聊天（不會打開、不會卡），照故事日期分天、看每天多大，還能把生理期、親熱、紀念日帶進現在的聊天。'],
            'zh-CN': ['📦 旧聊天整理（日记的第一步）：摘要分页可以直接读同角色的旧聊天（不会打开、不会卡），照故事日期分天、看每天多大，还能把生理期、亲热、纪念日带进现在的聊天。'],
            en: ['📦 Old chats (first step toward diaries): the Summary tab can read this character\'s old chats without opening them, group them by story date with sizes, and bring periods, intimacy and anniversaries into this chat.'],
        },
        fix: {
            'zh-TW': ['開同角色的新聊天時，生理期、親熱、紀念日以前不會跟著帶過去，現在會了（跟著摘要一起帶）。'],
            'zh-CN': ['开同角色的新聊天时，生理期、亲热、纪念日以前不会跟着带过去，现在会了（跟着摘要一起带）。'],
            en: ['Periods, intimacy and anniversaries now carry over to new chats with the same character (together with the summary).'],
        },
    },
    {
        v: '0.13.32',
        new: {
            'zh-TW': ['🎂 「行事曆／約定」分頁多了紀念日清單：看得到全部紀念日、生日和還有幾天，可以直接新增、改、刪（不用先點月曆）。'],
            'zh-CN': ['🎂 「行事历／约定」分页多了纪念日清单：看得到全部纪念日、生日和还有几天，可以直接新增、改、删（不用先点月历）。'],
            en: ['🎂 The Calendar tab now lists all anniversaries and birthdays with days left, and you can add, edit or delete them directly.'],
        },
    },
    {
        v: '0.13.31',
        new: {
            'zh-TW': [
                '📖 那年今日：故事裡的今天碰到以前的同一天，會跳出當時的回憶，還可以讓角色想起來。',
                '🎂 紀念日、生日那天打開戀人手帳，會飄一陣花瓣。',
                '🎉 一起寫到 100、500、1000…層時，有個小慶祝。',
                '🤫 還有一個藏起來的小彩蛋，找找看～',
            ],
            'zh-CN': [
                '📖 那年今日：故事里的今天碰到以前的同一天，会跳出当时的回忆，还可以让角色想起来。',
                '🎂 纪念日、生日那天打开恋人手帐，会飘一阵花瓣。',
                '🎉 一起写到 100、500、1000…层时，有个小庆祝。',
                '🤫 还有一个藏起来的小彩蛋，找找看～',
            ],
            en: [
                '📖 On this day: when the story reaches the same date as before, the memory from back then pops up, and you can let the character remember it.',
                '🎂 On anniversaries and birthdays, petals drift down when you open Lover\'s Planner.',
                '🎉 A small celebration at 100, 500, 1000… floors.',
                '🤫 There is also a hidden easter egg. Try to find it~',
            ],
        },
    },
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
