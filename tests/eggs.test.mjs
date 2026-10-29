// 小彩蛋（v0.13.31）：那年今日、紀念日花瓣、里程碑、連點📔五下。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

// 98 個 AI 樓層（偶數）＋使用者發言（奇數）。日期：第 2 層 2025-03-05，最後一層 2026-03-05。
const CHAT = [];
for (let i = 0; i < 196; i++) CHAT.push({ name: i % 2 ? '小雨' : '沈言', is_user: Boolean(i % 2), mes: `第${i}則`, send_date: `d${i}`, extra: {} });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__toasts = [];
  window.toastr = { success: (m) => window.__toasts.push(m), info: (m) => window.__toasts.push(m), warning: (m) => window.__toasts.push(m), error: (m) => window.__toasts.push(m) };
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, ui: { seenVersion: '9.9.9' }, calendar: { enabled: true } } };
}, CHAT);
await page.goto(URL);
await page.waitForFunction(() => Boolean(globalThis.loversPlannerInterceptor));
await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  for (let i = 0; i < window.__chat.length; i += 2) {
    const date = i === 2 ? '2025-03-05' : i === 4 ? '2025-11-05' : i === window.__chat.length - 2 ? '2026-03-05' : '2025-06-01';
    setEntry(i, { v: 2, status: 'ok', date, summary: i === 2 ? '兩人第一次約會，在河邊散步。' : `第${i}層`, ops: [], hash: floorSource(i).hash, at: i });
  }
  (await import('/src/notes.js')).invalidateNotes();
  await window.__emit('chat_id_changed');
});
const openPanel = async () => {
  await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; document.getElementById('lp_wand_entry').click(); });
  await page.waitForSelector('.lp-panel');
};
const closePanel = () => page.evaluate(() => document.querySelector('[data-action="close"]')?.click());

// ===== ① 那年今日：一年前同一天的摘要 =====
await openPanel();
let day = await page.textContent('[data-role="onthisday"]').catch(() => '');
check('one year ago from a summary', day.includes('1 年前的今天') && day.includes('2025-03-05') && day.includes('第一次約會'), day);
check('no remind button for a plain summary', !(await page.$('[data-action="egg-remind"]')));
// 回憶錄裡有同一天的：優先用回憶，可以讓角色想起
await page.evaluate(async () => (await import('/src/memories.js')).addMemory({ title: '第一次約會', content: '在河邊散步，他偷偷牽了她的手。', floor: 2 }));
await closePanel(); await openPanel();
day = await page.textContent('[data-role="onthisday"]');
check('memory preferred', day.includes('偷偷牽了她的手'), day);
await page.screenshot({ path: `${OUT}/eggs-day.png` });
await page.click('[data-action="egg-remind"]');
const pinned = await page.evaluate(async () => { const m = await import('/src/memories.js'); return m.listMemories().find((x) => x.key === m.nextPinned())?.title; });
check('remind pins the memory for next turn', pinned === '第一次約會', String(pinned));
check('card hidden after remind', !(await page.$('[data-role="onthisday"]')));
await closePanel(); await openPanel();
check('stays hidden the same story day', !(await page.$('[data-role="onthisday"]')));

// 幾個月前（回憶錄才算）：故事往前到 2026-04-05
await page.evaluate(async () => {
  const { floorSource, setEntry, getEntry } = await import('/src/chat.js');
  const i = window.__chat.length - 2;
  setEntry(i, { ...getEntry(i), date: '2026-04-05', hash: floorSource(i).hash });
  (await import('/src/memories.js')).addMemory({ title: '看煙火', content: '一起看了跨年煙火。', floor: 4 });
});
await closePanel(); await openPanel();
day = await page.textContent('[data-role="onthisday"]').catch(() => '');
check('months ago from the memory book', day.includes('5 個月前的今天') && day.includes('看煙火'), day);
await page.click('[data-action="egg-dismiss"]');
check('dismiss hides it', !(await page.$('[data-role="onthisday"]')));

// ===== ② 紀念日：標題下面寫今天，飄一次花瓣 =====
await page.evaluate(async () => (await import('/src/calendar.js')).addManualEvent({ type: 'anniversary', date: '04-05', title: '交往紀念日' }));
await closePanel(); await openPanel();
check('anniversary line', (await page.textContent('[data-role="anniversary"]').catch(() => '')).includes('交往紀念日'));
check('petals the first time', Boolean(await page.$('.lp-burst:not(.lp-burst-up)')));
await page.waitForTimeout(5500);
await closePanel(); await openPanel();
check('petals only once per story day', !(await page.$('.lp-burst:not(.lp-burst-up)')));

// ===== ③ 里程碑：98 → 100 層 =====
const addAi = () => page.evaluate(async () => {
  const chat = window.__chat;
  chat.push({ name: '小雨', is_user: true, mes: 'u', send_date: `n${chat.length}`, extra: {} });
  chat.push({ name: '沈言', is_user: false, mes: 'a', send_date: `n${chat.length}`, extra: {} });
  await window.__emit('message_received', chat.length - 1);
});
await page.evaluate(() => { window.__toasts.length = 0; });
await addAi();
check('no celebration before 100', !(await page.evaluate(() => window.__toasts.some((x) => x.includes('層故事')))));
await addAi();
const toasts = await page.evaluate(() => window.__toasts);
check('celebrates 100 floors with the start date', toasts.some((x) => x.includes('100 層故事') && x.includes('2025-06-01')), JSON.stringify(toasts));
await page.evaluate(() => { window.__toasts.length = 0; });
await addAi();
check('only once per milestone', !(await page.evaluate(() => window.__toasts.some((x) => x.includes('層故事')))));
// 換到已經超過里程碑的聊天：不補慶祝
const late = await page.evaluate(async () => {
  window.__chat = Array.from({ length: 1200 }, (_, i) => ({ name: i % 2 ? '小雨' : '沈言', is_user: Boolean(i % 2), mes: 'x', send_date: `z${i}`, extra: {} }));
  window.__chatMetadata = {};
  window.__chatId = 'other';
  await window.__emit('chat_id_changed');
  window.__toasts.length = 0;
  window.__chat.push({ name: '沈言', is_user: false, mes: 'a', send_date: 'z9999', extra: {} });
  await window.__emit('message_received', window.__chat.length - 1);
  return { toasts: window.__toasts.slice(), m: SillyTavern.getContext().chatMetadata.lovers_planner?.eggs?.milestone };
});
check('no late celebration when a chat is already past it', !late.toasts.some((x) => x.includes('層故事')) && late.m === 500, JSON.stringify(late));

// ===== ④ 連點📔五下 =====
await page.evaluate(() => { window.__toasts.length = 0; });
// 測試頁沒有 Font Awesome，圖示是 0 寬，直接送點擊。
const tap = () => page.evaluate(() => document.querySelector('.lp-title-icon').click());
for (let k = 0; k < 4; k++) await tap();
check('four clicks: nothing yet', !(await page.evaluate(() => window.__toasts.length)));
await tap();
check('five clicks: hearts and a line', Boolean(await page.$('.lp-burst-up')) && (await page.evaluate(() => window.__toasts.length)) === 1, JSON.stringify(await page.evaluate(() => window.__toasts)));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
