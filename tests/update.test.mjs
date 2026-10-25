// 更新後自動重新整理：版本變了才重新整理、忙的時候等、保留輸入框、同一版只重新整理一次、可以關掉。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });

let fakeVersion = null; // null＝照實際的 manifest
await page.route('**/manifest.json*', async (route) => {
  const res = await route.fetch();
  const json = await res.json();
  if (fakeVersion) json.version = fakeVersion;
  await route.fulfill({ response: res, body: JSON.stringify(json) });
});
await page.addInitScript(() => { window.__chat = [{ name: '沈言', is_user: false, mes: 'hi', send_date: 'd0', extra: {} }]; });
let loads = 0;
page.on('load', () => { loads++; });
await page.goto(URL);
await page.waitForFunction(() => document.getElementById('lp_wand_entry'));
await sleep(500);
const startLoads = loads;
const check1 = () => page.evaluate(async () => (await import('/src/update.js')).checkForUpdate());

// 1. 版本沒變：不動
let v = await check1();
check('same version: no reload', v && loads === startLoads, String(v));

// 2. 生成中：先等
await page.evaluate(() => window.__emit('generation_started'));
await page.fill('#send_textarea', '還沒送出的話');
fakeVersion = '9.9.9';
await check1();
await sleep(4500);
check('waits while generating', loads === startLoads);
await page.evaluate(() => window.__emit('generation_ended'));
await page.waitForFunction(() => document.getElementById('lp_wand_entry') && performance.getEntriesByType('navigation')[0]?.type === 'reload', null, { timeout: 10000 }).catch(() => {});
check('reloads after generation ends', loads === startLoads + 1, String(loads - startLoads));
await page.waitForFunction(() => document.getElementById('send_textarea')?.value, null, { timeout: 5000 }).catch(() => {});
check('draft restored', (await page.inputValue('#send_textarea')) === '還沒送出的話');

// 3. 重新整理後版本一樣是 9.9.9：不會再重新整理
await sleep(500);
v = await check1();
await sleep(3500);
check('no reload loop', loads === startLoads + 1, String(v));

// 4. 大視窗開著時等；關掉才重新整理
fakeVersion = '10.0.0';
await page.evaluate(() => { document.getElementById('lp_wand_entry').style.display = ''; });
await page.click('#lp_wand_entry');
await check1();
await sleep(4500);
check('waits while panel open', loads === startLoads + 1);
await page.keyboard.press('Escape');
await page.waitForFunction(() => performance.getEntriesByType('navigation')[0] && document.readyState === 'complete', null, { timeout: 10000 });
await sleep(3500);
check('reloads after panel closed', loads === startLoads + 2, String(loads - startLoads));

// 5. 關掉設定就不重新整理
await page.waitForFunction(() => document.getElementById('lp_wand_entry'));
await page.evaluate(() => { SillyTavern.getContext().extensionSettings.lovers_planner.update.autoReload = false; });
fakeVersion = '11.0.0';
v = await check1();
await sleep(4000);
check('setting off: no reload', v === null && loads === startLoads + 2);

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const line of results) console.log(line);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
