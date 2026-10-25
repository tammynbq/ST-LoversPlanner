// 標籤佔多少：掃描範圍（最新 2 層／30 層／整個聊天）、每個標籤的 token 和樓層、補建卡片列出還會送出的標籤。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

// 40 個 AI 樓層（1,3,…,79）。舊的（1～39）有 <peeling_process>，全部都有 <horae>，最新兩層有 <status>。
const LONG = '他在心裡一層一層剝開自己的情緒，'.repeat(20);
const CHAT = [];
for (let i = 0; i < 80; i++) {
  const ai = i % 2 === 1;
  let mes = `${ai ? 'AI' : 'U'}${i} 今天也在山門練劍。`;
  if (ai) {
    mes += `<horae>時間：第${i}天｜地點：山門</horae>`;
    if (i < 40) mes += `<peeling_process>${LONG}</peeling_process>`;
    if (i > 75) mes += '<status>好感 +1</status>';
  }
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes, send_date: `d${i}`, extra: {} });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, recall: { notes: false } } };
}, CHAT);
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

// ===== 1. scanTags 的統計 =====
const stats = await page.evaluate(async () => {
  const { scanTags } = await import('/src/filter.js');
  return scanTags([{ index: 3, text: '<a1>一二三四五六</a1><a1>七八</a1>' }, { index: 9, text: '<a1>九</a1><open>沒有結尾' }, 'x<b2>abcdefgh</b2>']);
});
const a1 = stats.find((x) => x.name === 'a1');
check('count and floors', a1?.count === 3 && a1.floors === 2, JSON.stringify(a1));
check('first / last floor', a1?.first === 3 && a1.last === 9);
check('tokens of the inside', a1?.tokens === 5 + 2 + 1, String(a1?.tokens));
check('unclosed tag counts 0 tokens', stats.find((x) => x.name === 'open')?.tokens === 0);
check('plain strings still work', stats.find((x) => x.name === 'b2')?.tokens === 2 && stats.find((x) => x.name === 'b2').first === null);

const openPanel = async (tab) => {
  await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
  await page.click('#lp_wand_entry');
  if (tab) await page.click(`[data-tab="${tab}"]`);
};
const rows = () => page.$$eval('[data-role="tag-scan"] [data-tag-row]', (els) => els.map((e) => e.dataset.tagRow));

// ===== 2. 設定頁：掃描範圍 =====
await openPanel('settings');
if (!(await page.isVisible('[data-role="tag-scan"]'))) await page.click('details[data-sec="filter"] > summary');
let tags = await rows();
check('latest 2: old-only tag not found', tags.includes('horae') && tags.includes('status') && !tags.includes('peeling_process'), tags.join());
await page.selectOption('[data-role="tag-scope"]', 'all');
tags = await rows();
check('whole chat finds old tags', tags.includes('peeling_process'), tags.join());
check('sorted by tokens', tags[0] === 'peeling_process', tags.join());
const pp = await page.textContent('[data-tag-row="peeling_process"]');
check('shows tokens and floor range', /tokens/.test(pp) && pp.includes('20 層') && pp.includes('#1～#39'), pp.replace(/\s+/g, ' '));
await page.selectOption('[data-role="tag-scope"]', 'recent');
tags = await rows();
check('latest 30: floors 21–79 only', tags.includes('peeling_process') && (await page.textContent('[data-tag-row="peeling_process"]')).includes('#21～#39'));
await page.screenshot({ path: `${OUT}/tags-scan.png` });
await page.keyboard.press('Escape');

// ===== 3. 補建卡片：還會送出的標籤 =====
await openPanel('summary');
await page.click('[data-action="backfill-ask"]');
const estimate = async () => Number((await page.textContent('[data-role="cu-estimate"]')).match(/約 ([\d,]+) tokens/)[1].replace(/,/g, ''));
const before = await estimate();
// 預估要照過濾後的內容算：只把最新兩層的 <status> 打開來讀，預估應該變多。
const withStatus = await page.evaluate(async () => {
  const c = await import('/src/catchup.js');
  const s = SillyTavern.getContext().extensionSettings.lovers_planner;
  const plan = () => c.planCatchup({ from: 1, to: 79, fineFrom: 1, block: 10 }).tokens;
  const off = plan();
  s.filter.status = false;
  const on = plan();
  s.filter.status = true;
  return { off, on };
});
check('estimate applies the filter', withStatus.on > withStatus.off, JSON.stringify(withStatus));
const cuRows = () => page.$$eval('[data-role="cu-tags"] [data-tag-row]', (els) => els.map((e) => e.dataset.tagRow));
let cu = await cuRows();
check('lists tags still sent, biggest first', cu[0] === 'peeling_process' && cu.includes('horae'), cu.join());
check('built-in skipped tags not listed', !cu.includes('status'), cu.join());
check('title shows the total', /還會送出的標籤：2 個，約 [\d,]+ tokens/.test(await page.textContent('[data-role="cu-tags"] summary')));
await page.click('[data-role="cu-tags"] summary');
await page.selectOption('[data-role="cu-tags"] [data-tag="peeling_process"]', 'skip');
const after = await estimate();
check('skipping lowers the estimate', after < before - 3000, `${before} → ${after}`);
cu = await cuRows();
check('skipped tag leaves the list', !cu.includes('peeling_process') && cu.includes('horae'), cu.join());
check('saved into the skip list', await page.evaluate(() => SillyTavern.getContext().extensionSettings.lovers_planner.filter.tags.includes('peeling_process')));
check('list stays open after the change', await page.evaluate(() => document.querySelector('[data-role="cu-tags"]')?.open === true));
// 改範圍：只剩新的樓層 → 只有 horae
await page.selectOption('[data-role="cu-tags"] [data-tag="peeling_process"]', 'read').catch(() => {});
await page.evaluate(async () => (await import('/src/filter.js')).setTagMode('peeling_process', 'read'));
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.fill('[data-cu="from"]', '41');
await page.dispatchEvent('[data-cu="from"]', 'input');
cu = await cuRows();
check('range change updates the list', cu.length === 1 && cu[0] === 'horae', cu.join());
await page.screenshot({ path: `${OUT}/tags-catchup.png` });

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const line of results) console.log(line);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
