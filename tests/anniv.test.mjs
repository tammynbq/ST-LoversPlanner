// 🎂 紀念日清單（v0.13.32）：行事曆分頁列出全部紀念日（同一個日子＋名稱併成一組）、還有幾天，直接新增、改、刪。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
const CHAT = Array.from({ length: 8 }, (_, i) => ({ name: i % 2 ? '小雨' : '沈言', is_user: Boolean(i % 2), mes: `第${i}則`, send_date: `d${i}`, extra: {} }));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => { window.__chat = chat; window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, ui: { seenVersion: '9.9.9' } } }; }, CHAT);
await page.goto(URL);
await page.waitForFunction(() => Boolean(globalThis.loversPlannerInterceptor));
await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  // 故事的今天是 2026-12-01；劇情裡記到兩次「交往紀念日 12/12」、一次「小雨的生日 3/5」。
  setEntry(0, { v: 2, status: 'ok', date: '2026-11-20', summary: 'a', ops: [], hash: floorSource(0).hash, at: 1, events: [{ type: 'anniversary', date: '12-12', title: '交往紀念日' }] });
  setEntry(2, { v: 2, status: 'ok', date: '2026-11-25', summary: 'b', ops: [], hash: floorSource(2).hash, at: 2, events: [{ type: 'anniversary', date: '12-12', title: '交往紀念日' }, { type: 'anniversary', date: '03-05', title: '小雨的生日' }] });
  setEntry(4, { v: 2, status: 'ok', date: '2026-12-01', summary: 'c', ops: [], hash: floorSource(4).hash, at: 3 });
  document.getElementById('extensionsMenu').style.display = '';
  document.getElementById('lp_wand_entry').click();
});
await page.click('[data-tab="notes"]');
await page.waitForSelector('[data-role="anniv"]', { state: 'attached' });
const list = () => page.$$eval('.lp-anniv-item', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
let items = await list();
check('grouped and sorted by days left', items.length === 2 && items[0].includes('交往紀念日') && items[0].includes('還有 11 天') && items[0].includes('記到 2 次') && items[1].includes('小雨的生日') && items[1].includes('3/5'), JSON.stringify(items));
check('source shown', items[0].includes('劇情裡記到的'));
await page.screenshot({ path: `${OUT}/anniv.png` });

// 新增（不用先點月曆）
await page.fill('[data-role="anniv-month"]', '12');
await page.fill('[data-role="anniv-day"]', '1');
await page.fill('[data-role="anniv-title"]', '第一次見面');
await page.click('[data-action="anniv-save"]');
items = await list();
check('add without picking a day', items[0].includes('第一次見面') && items[0].includes('就是今天') && items[0].includes('自己加的'), JSON.stringify(items));
check('shows on the calendar too', await page.evaluate(async () => { const c = await import('/src/calendar.js'); return c.dayInfo(c.buildCalendar(), '2026-12-01').anniversaries.some((x) => x.title === '第一次見面'); }));

// 檢查輸入
await page.fill('[data-role="anniv-month"]', '2');
await page.fill('[data-role="anniv-day"]', '30');
await page.fill('[data-role="anniv-title"]', '不存在的日子');
await page.click('[data-action="anniv-save"]');
check('invalid date rejected', (await page.textContent('[data-role="anniv-msg"]')).includes('日期不對') && (await list()).length === 3);

// 改：劇情記到的兩次一起換成一條
await page.click('.lp-anniv-item:has-text("交往紀念日") [data-action="anniv-edit"]');
check('edit fills the form', await page.inputValue('[data-role="anniv-title"]') === '交往紀念日' && await page.inputValue('[data-role="anniv-month"]') === '12' && await page.inputValue('[data-role="anniv-day"]') === '12');
await page.fill('[data-role="anniv-day"]', '13');
await page.click('[data-action="anniv-save"]');
items = await list();
check('edit replaces the whole group', items.some((x) => x.includes('交往紀念日') && x.includes('12/13') && !x.includes('記到')) && !items.some((x) => x.includes('12/12')), JSON.stringify(items));

// 刪
await page.click('.lp-anniv-item:has-text("小雨的生日") [data-action="anniv-remove"]');
items = await list();
check('remove', !items.some((x) => x.includes('小雨的生日')) && items.length === 2, JSON.stringify(items));

// 沒有紀念日時的說明
await page.evaluate(async () => { const c = await import('/src/calendar.js'); for (const x of c.buildCalendar().items.filter((i) => i.type === 'anniversary')) c.removeEvent(x); });
await page.click('[data-tab="notes"]');
check('empty hint', (await page.textContent('[data-role="anniv"]')).includes('還沒有紀念日'));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));
for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
