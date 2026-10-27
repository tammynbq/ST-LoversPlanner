// 花費紀錄：每次呼叫都記（用途、模型、送出／回覆、秒數、成功或失敗）；主 API 估計（≈）、自訂 API 用實際用量；
// 重試每次都算；設定頁的統計和最近幾次；清空要確認；備份不帶。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

const CHAT = [];
for (let i = 0; i < 8; i++) {
  const ai = i % 2 === 1;
  CHAT.push({ name: ai ? '白起' : '米米', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i} 今天也在一起`, send_date: `d${i}`, extra: {} });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, recall: { notes: false, memory: false }, compress: { auto: false } } };
}, CHAT);
await page.route('https://api.example.com/v1/chat/completions', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ choices: [{ message: { content: '{"summary":"自訂的","ops":[]}' } }], usage: { prompt_tokens: 1234, completion_tokens: 56 } }) });
});
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

const summarize = (i) => page.evaluate(async (i) => {
  const { enqueue, pendingCount } = await import('/src/summarize.js');
  enqueue(i);
  const t0 = Date.now();
  while (pendingCount() && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 100));
}, i);
const recent = () => page.evaluate(async () => (await import('/src/usage.js')).recentUsage(20));

// 主 API：估計
await page.evaluate(() => { window.__model = 'main-model'; });
await summarize(1);
let r = await recent();
check('main API call logged as an estimate', r.length === 1 && r[0].purpose === 'l1' && r[0].model.includes('main-model') && r[0].est && r[0].input > 0 && r[0].output > 0 && r[0].ok, JSON.stringify(r[0]));

// 自訂 API：實際用量
await page.evaluate(() => Object.assign(SillyTavern.getContext().extensionSettings.lovers_planner, { source: 'custom', custom: { url: 'https://api.example.com/v1', key: 'k', model: 'deepseek-chat', timeout: 120 } }));
await summarize(3);
r = await recent();
check('custom API uses real usage', r[0].model === 'deepseek-chat' && r[0].input === 1234 && r[0].output === 56 && !r[0].est, JSON.stringify(r[0]));

// 失敗、重試：每一次都算
await page.evaluate(() => {
  Object.assign(SillyTavern.getContext().extensionSettings.lovers_planner, { source: 'main' });
  window.__generateRaw = async () => '';
});
await summarize(5);
r = await recent();
check('each retry logged as a failed call', r.slice(0, 3).every((x) => !x.ok && x.purpose === 'l1') && r.length === 5, JSON.stringify(r.map((x) => x.ok)));

// 統計
const sum = await page.evaluate(async () => {
  const u = await import('/src/usage.js');
  return u.usageSummary(u.localDay());
});
check('totals', sum.total.calls === 5 && sum.total.fails === 3 && sum.byModel.some((m) => m.model === 'deepseek-chat' && m.input === 1234), JSON.stringify(sum.total));
check('by purpose', sum.byPurpose.length === 1 && sum.byPurpose[0].purpose === 'l1' && sum.byPurpose[0].calls === 5);

// 設定頁
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="settings"]');
await page.click('details[data-sec="usage"] > summary');
const today = await page.textContent('[data-role="usage-today"]');
check('today card', today.includes('5 次呼叫') && today.includes('失敗 3 次'), today.replace(/\s+/g, ' '));
const tables = await page.textContent('details[data-sec="usage"]');
check('tables by model and purpose', tables.includes('deepseek-chat') && tables.includes('單層摘要') && tables.includes('60%'), tables.replace(/\s+/g, ' ').slice(0, 400));
await page.click('details[data-sec="usage"] .lp-preview-raw > summary');
check('recent list', (await page.textContent('[data-role="usage-recent"]')).includes('deepseek-chat・1,234/56') && (await page.textContent('[data-role="usage-recent"]')).includes('失敗 空回'));
await page.screenshot({ path: `${OUT}/usage.png` });

// 備份不帶花費紀錄
check('backup has no usage', await page.evaluate(async () => !('usage' in (await import('/src/backup.js')).buildBackup({ settings: true }).settings)));

// 清空要確認
await page.click('[data-action="usage-clear"]');
check('clear asks first', (await page.evaluate(async () => (await import('/src/usage.js')).recentUsage().length)) === 5);
await page.click('[data-action="usage-clear"]');
check('cleared', (await page.evaluate(async () => (await import('/src/usage.js')).recentUsage().length)) === 0 && (await page.textContent('details[data-sec="usage"]')).includes('還沒有紀錄'));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
