// 手機寬度（390px）的各分頁截圖，排版用：PORT=8815 node tests/screens.mjs <輸出資料夾>（不是測試，不算進全部測試）。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));
const OUT = process.argv[2];
const CHAT = [];
for (let i = 0; i < 40; i++) { const ai = i % 2 === 1; CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i} 今天也在一起，聊了很多事情。`, send_date: `d${i}`, extra: {} }); }
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.addInitScript((theme) => { window.__theme = theme; }, process.env.THEME ?? 'tavern');
await page.addInitScript((chat) => { window.__chat = chat; window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, recall: { notes: false, memory: false }, compress: { auto: false }, calendar: { enabled: true, track: { period: true, intimacy: true, anniversary: true } }, ui: { theme: window.__theme ?? 'tavern', themeBlocks: true } } }; }, CHAT);
await page.goto(`http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`);
await page.waitForFunction(() => Boolean(globalThis.loversPlannerInterceptor));
await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  for (let i = 1; i < 36; i += 2) setEntry(i, { v: 2, status: i === 9 ? 'skip' : 'ok', time: '晚上', location: '恋语市・家', characters: ['沈言', '小雨'], summary: `第${i}層：兩人一起吃晚餐，聊了工作上的事，沈言說週末要帶她去看海。`, ops: i === 1 ? [
    { op: 'add', id: 'c_s', type: 'character', data: { name: '沈言', identity: '外科醫生', age: '28', appearance: '黑髮、戴眼鏡', status: '感冒中', relUser: '戀人' } },
    { op: 'add', id: 'c_l', type: 'character', data: { name: '林曉', identity: '護理師', relUser: '同事' } },
    { op: 'add', id: 'i_r', type: 'item', data: { name: '戒指', quantity: '1', holder: '小雨' } },
    { op: 'add', id: 'p_s', type: 'promise', data: { title: '看海', content: '週末一起去看海', with: '沈言答應小雨', due: '2025-03-08' } },
    { op: 'add', id: 't_c', type: 'todo', data: { title: '生日驚喜', content: '偷偷準備生日驚喜', due: '2025-03-12' } },
  ] : [], hash: floorSource(i).hash, at: i, date: `2025-03-0${Math.min(9, 1 + Math.floor(i / 8))}`, events: i === 3 ? [{ type: 'intimacy', count: 1 }, { type: 'anniversary', date: '03-10', title: '交往紀念日' }] : [],
    keepsakes: i === 5 ? [{ title: '第一次牽手', content: '在公園裡第一次牽手。' }] : [] });
  (await import('/src/notes.js')).invalidateNotes();
  document.getElementById('extensionsMenu').style.display = '';
});
await page.click('#lp_wand_entry');
await page.evaluate(async () => { const { addMemory } = await import('/src/memories.js'); addMemory({ title: '雨中告白', content: '沈言在雨中告白。', floor: 7 }); addMemory({ title: '看海', content: '一起去看海。', floor: 11 }); });
for (const tab of ['summary', 'characters', 'items', 'notes', 'memories', 'done', 'settings']) {
  await page.click(`[data-tab="${tab}"]`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${tab}.png` });
}
await page.click('[data-tab="summary"]');
await page.evaluate(() => document.querySelector('.lp-group button')?.click());
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/summary-open.png`, fullPage: false });
await page.evaluate(() => document.querySelector('.lp-panel, #lp_panel, [data-role="panel"]')?.scrollBy?.(0, 400));
await b.close();
