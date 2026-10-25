// 摘要分頁多選：點選、全選列出的、選一段、摘要／重新摘要（要確認）／跳過／取消跳過、多選壓成一章（要連續、要已摘要）、
// 自動壓縮不跨過手動的章、換聊天清掉選取。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

// 30 個 AI 樓層（1,3,…,59）。1～19 已摘要，21～59 還沒。
const CHAT = [];
for (let i = 0; i < 60; i++) {
  const ai = i % 2 === 1;
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i} 的內容`, send_date: `d${i}`, extra: {} });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, recall: { notes: false, memory: false }, compress: { auto: false, l1PerL2: 4 } } };
  const make = (html) => { const el = document.createElement('div'); el.className = 'fake-toast'; el.innerHTML = html; document.body.appendChild(el); return { 0: el, remove: () => el.remove() }; };
  window.toastr = { info: make, success: make, error: make, warning: make };
}, CHAT);
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  for (let i = 1; i < 20; i += 2) setEntry(i, { v: 2, status: 'ok', time: `第${i}天`, location: '山門', characters: [], summary: `第${i}層的事`, ops: [], hash: floorSource(i).hash, at: 1000 + i });
  window.__calls = [];
  window.__generateRaw = async ({ prompt }) => {
    if (prompt.includes('章節總結')) { window.__calls.push('chapter'); return '手動的一章'; }
    window.__calls.push('l1');
    return JSON.stringify({ summary: '新的摘要', ops: [] });
  };
});
const idle = async () => {
  let quiet = 0;
  for (let k = 0; k < 200 && quiet < 2; k++) {
    await new Promise((r) => setTimeout(r, 100));
    const n = await page.evaluate(async () => (await import('/src/summarize.js')).pendingCount());
    quiet = n === 0 ? quiet + 1 : 0;
  }
};
const openPanel = async () => {
  await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
  await page.click('#lp_wand_entry');
  await page.click('[data-tab="summary"]');
};
const status = (i) => page.evaluate(async (i) => (await import('/src/chat.js')).floorStatus(i), i);
const picked = () => page.$$eval('[data-action="sum-pick"][aria-pressed="true"]', (els) => els.map((e) => Number(e.dataset.index)).sort((a, b) => a - b));
const lastToast = () => page.evaluate(() => [...document.querySelectorAll('.fake-toast')].pop()?.textContent ?? '');

await openPanel();
await page.click('[data-action="sum-select"]');
check('select mode shows the bar', await page.isVisible('[data-role="bulk"]'));
check('hint before picking', (await page.textContent('[data-role="bulk-count"]')).includes('點樓層'));
await page.click('[data-action="sum-filter"][data-filter="ok"]');
for (const i of [3, 5]) await page.click(`[data-action="sum-pick"][data-index="${i}"]`);
check('tap picks floors', JSON.stringify(await picked()) === '[3,5]', JSON.stringify(await picked()));
check('count shown', (await page.textContent('[data-role="bulk-count"]')).includes('已選 2 層'));
await page.click('[data-action="sum-pick"][data-index="5"]');
check('tap again unpicks', JSON.stringify(await picked()) === '[3]');
await page.screenshot({ path: `${OUT}/bulk-select.png` });

// ===== 跳過／取消跳過 =====
await page.click('[data-action="sum-pick"][data-index="5"]');
await page.click('[data-action="bulk-skip"]');
check('bulk skip', (await status(3)) === 'skip' && (await status(5)) === 'skip');
check('selection cleared after action', (await picked()).length === 0);
check('toast after skip', (await lastToast()).includes('已跳過 2 層'));
await page.click('[data-action="sum-filter"][data-filter="skip"]');
await page.click('[data-action="bulk-all"]');
await page.click('[data-action="bulk-unskip"]');
check('bulk unskip restores', (await status(3)) === 'ok' && (await status(5)) === 'ok');

// ===== 選一段＋摘要（只選列出來的：未摘要篩選） =====
await page.click('[data-action="sum-filter"][data-filter="none"]');
check('range folded by default', !(await page.isVisible('[data-bulk="from"]')));
check('no actions before picking', (await page.$$('.lp-bulk-acts button')).length === 0);
await page.click('[data-role="bulk-range"] > summary');
await page.fill('[data-bulk="from"]', '20');
await page.fill('[data-bulk="to"]', '27');
await page.click('[data-action="bulk-range"]');
check('range picks listed floors only', JSON.stringify(await picked()) === '[21,23,25,27]', JSON.stringify(await picked()));
await page.click('[data-action="bulk-summarize"]');
await idle();
check('bulk summarize', (await Promise.all([21, 23, 25, 27].map(status))).every((s) => s === 'ok') && (await status(29)) === 'none');

// ===== 重新摘要要按兩次 =====
await page.click('[data-action="sum-filter"][data-filter="ok"]');
await page.click('[data-action="sum-pick"][data-index="1"]');
const callsBefore = await page.evaluate(() => window.__calls.length);
await page.click('[data-action="bulk-redo"]');
check('redo asks first', (await page.textContent('[data-action="bulk-redo"]')).includes('確定') && (await page.evaluate(() => window.__calls.length)) === callsBefore);
await page.click('[data-action="bulk-redo"]');
await idle();
check('redo after confirm', (await page.evaluate(() => window.__calls.length)) === callsBefore + 1);

// ===== 壓成一章 =====
await page.click('[data-action="sum-pick"][data-index="7"]');
await page.click('[data-action="sum-pick"][data-index="11"]');
check('gap blocks compress', await page.isDisabled('[data-action="bulk-compress"]') && (await page.textContent('[data-role="bulk-why"]')).includes('連續'));
// 中間的第 9 層跳過就可以
await page.evaluate(async () => (await import('/src/summarize.js')).skipFloor(9));
await page.click('[data-action="sum-pick"][data-index="7"]'); // 重畫一次（取消再選）
await page.click('[data-action="sum-pick"][data-index="7"]');
check('skipped floor in between is fine', !(await page.isDisabled('[data-action="bulk-compress"]')), await page.textContent('[data-role="bulk"]'));
await page.click('[data-action="bulk-compress"]');
await idle();
let chapters = await page.evaluate(async () => (await import('/src/compress.js')).getChapters().map((c) => c.memberIdx));
check('manual chapter made', chapters.length === 1 && JSON.stringify(chapters[0]) === '[7,11]', JSON.stringify(chapters));
// 已經在章裡的不能再壓
await page.click('[data-action="sum-pick"][data-index="7"]');
await page.click('[data-action="sum-pick"][data-index="13"]');
check('claimed floors blocked', await page.isDisabled('[data-action="bulk-compress"]') && (await page.textContent('[data-role="bulk-why"]')).includes('別的章'));
await page.click('[data-action="bulk-none"]');
// 未摘要的不能壓
await page.click('[data-action="sum-filter"][data-filter="all"]');
check('unsummarized blocked', (await page.evaluate(async () => (await import('/src/compress.js')).checkManualChapter([29, 31]).error)) === 'state');

// ===== 自動壓縮不跨過手動的章：1、3、5 在章前面，13 之後的另外湊 =====
await page.evaluate(async () => {
  const s = SillyTavern.getContext().extensionSettings.lovers_planner;
  const { floorSource, setEntry } = await import('/src/chat.js');
  for (let i = 29; i < 60; i += 2) setEntry(i, { v: 2, status: 'ok', time: '', location: '', characters: [], summary: `第${i}層的事`, ops: [], hash: floorSource(i).hash, at: 2000 + i });
  s.compress.auto = true;
  await (await import('/src/compress.js')).runCompression(null);
});
chapters = await page.evaluate(async () => (await import('/src/compress.js')).getChapters().map((c) => c.memberIdx));
const crosses = chapters.some((m) => m.some((i) => i < 7) && m.some((i) => i > 11));
check('auto chapters do not cross the manual one', !crosses && chapters.some((m) => m[0] === 13), JSON.stringify(chapters));

// ===== 換聊天清掉選取 =====
await page.click('[data-action="sum-filter"][data-filter="ok"]');
await page.click('[data-action="sum-pick"][data-index="1"]');
await page.evaluate(() => { window.__chatId = 'other'; });
await page.click('[data-action="sum-filter"][data-filter="ok"]');
check('selection cleared on chat change', (await picked()).length === 0);

await page.click('[data-action="sum-select"]');
check('done leaves select mode', !(await page.isVisible('[data-role="bulk"]')) && (await page.$$('[data-action="sum-pick"]')).length === 0);

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const line of results) console.log(line);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
