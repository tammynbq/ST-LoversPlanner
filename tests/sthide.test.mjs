// 用酒館的「隱藏」標起已摘要的舊樓層（預設關）：開了就標、最新幾層不標、摘要照送、過期就取消、
// 使用者自己隱藏的不碰、關掉全部取消。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

// 8 個 AI 樓層（1,3,…,15），前面各有一句使用者發言；最後再一句使用者發言（16）。
const CHAT = [];
for (let i = 0; i < 17; i++) {
  const ai = i % 2 === 1;
  CHAT.push({ name: ai ? '白起' : '米米', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i}`, send_date: `d${i}`, extra: {} });
}
CHAT[2].is_system = true; // 使用者自己隱藏的

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, recall: { notes: false, memory: false }, compress: { auto: false } } };
}, CHAT);
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  for (let i = 1; i < 16; i += 2) setEntry(i, { v: 2, status: 'ok', time: '', location: '', characters: [], summary: `第${i}層`, ops: [], hash: floorSource(i).hash, at: 1000 + i });
});
const hiddenNow = () => page.evaluate(() => window.__chat.map((m, i) => (m.is_system ? i : -1)).filter((i) => i >= 0));
const sync = () => page.evaluate(async () => (await import('/src/sthide.js')).syncStHide());

// ===== 1. 預設關 =====
await sync();
check('off by default: nothing hidden', JSON.stringify(await hiddenNow()) === '[2]');

// ===== 2. 從設定頁打開 =====
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="settings"]');
await page.click('details[data-sec="hide"] > summary');
await page.check('input[data-path="hide.stHide"]');
let h = await hiddenNow();
// 最新 2 個 AI 樓層（13、15）和它們前面的發言（12、14）、最後一句（16）不藏
check('summarized old floors hidden, latest kept', JSON.stringify(h) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), JSON.stringify(h));
check('screen marked too', await page.evaluate(() => document.querySelector('#chat .mes[mesid="5"]')?.getAttribute('is_system') === 'true'));
check('count shown', (await page.textContent('[data-role="st-hidden"]')).includes('11 則'));
check('user-hidden one not tracked', await page.evaluate(() => !SillyTavern.getContext().chatMetadata.lovers_planner.stHidden.includes('d2')));

// 送出：摘要照送、原文只有最新幾層
const r = await page.evaluate(() => window.__runInterceptor('normal'));
check('summaries still sent', r.injection.value.includes('第1層') && r.injection.value.includes('第11層') && !r.injection.value.includes('第13層'), r.injection.value);
check('only the latest floors as text', JSON.stringify(r.kept) === JSON.stringify(['d12', 'd13', 'd14', 'd15', 'd16']), JSON.stringify(r.kept));

// ===== 3. 過期就取消隱藏 =====
await page.evaluate(() => { window.__chat[5].mes = 'AI5 改過了'; });
await sync();
h = await hiddenNow();
check('stale floor and its message unhidden, others stay', JSON.stringify(h) === JSON.stringify([0, 1, 2, 3, 6, 7, 8, 9, 10, 11]), JSON.stringify(h));

// ===== 4. 新的樓層：舊的往外推、跟著藏起來 =====
await page.evaluate(async () => {
  window.__chat.push({ name: '白起', is_user: false, mes: 'AI17', send_date: 'd17', extra: {} });
  window.__chat.push({ name: '米米', is_user: true, mes: 'U18', send_date: 'd18', extra: {} });
  const { floorSource, setEntry } = await import('/src/chat.js');
  setEntry(17, { v: 2, status: 'ok', time: '', location: '', characters: [], summary: '第17層', ops: [], hash: floorSource(17).hash, at: 1017 });
});
await sync();
h = await hiddenNow();
check('floor pushed out of the latest window gets hidden', h.includes(13) && h.includes(12) && !h.includes(15), JSON.stringify(h));

// ===== 5. 關掉：自己標的全部取消，使用者自己的留著 =====
await page.uncheck('input[data-path="hide.stHide"]');
h = await hiddenNow();
check('off unhides only ours', JSON.stringify(h) === '[2]', JSON.stringify(h));
check('record cleared', await page.evaluate(() => (SillyTavern.getContext().chatMetadata.lovers_planner.stHidden ?? []).length === 0));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
