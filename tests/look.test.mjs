// 外觀（v0.13.22）：設定 › 一般 › 外觀 切成「日系手帳」→ <html> 加 class、載入字型；「摘要區塊也套用」另外勾；切回來拿掉。
// 「隱藏 👻」等 ui 設定重新整理後還在（以前 ui 不在預設值裡會被丟掉）。
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
for (let i = 0; i < 4; i++) CHAT.push({ name: i % 2 ? '沈言' : '小雨', is_user: !(i % 2), mes: `${i}`, send_date: `d${i}`, extra: {} });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon') && !m.text().includes('fonts.g')) errors.push('console: ' + m.text()); });
await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '/* font */' }));
await page.addInitScript((chat) => {
  window.__chat = chat;
  // 舊版存下的設定：ui 裡有 hideSkip
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, ui: { hideSkip: true } } };
}, CHAT);
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

const cls = () => page.evaluate(() => document.documentElement.className);
check('ui settings survive reload (hideSkip kept)', await page.evaluate(() => SillyTavern.getContext().extensionSettings.lovers_planner.ui?.hideSkip === true));
check('default: follow the tavern', !(await cls()).includes('lp-theme-techo'));

await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="settings"]');
check('blocks option hidden until planner chosen', !(await page.$('input[data-path="ui.themeBlocks"]')));
await page.selectOption('#lp-theme', 'techo');
await page.waitForFunction(() => document.documentElement.classList.contains('lp-theme-techo'));
check('planner class on <html>', (await cls()).includes('lp-theme-techo') && !(await cls()).includes('lp-theme-techo-blocks'));
check('font loaded once', await page.evaluate(() => document.querySelectorAll('link[data-lp-font]').length === 1 && document.querySelector('link[data-lp-font]').href.includes('Huninn')));
const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.lp-panel')).backgroundColor);
check('paper background', bg === 'rgb(251, 245, 234)', bg);
await page.check('input[data-path="ui.themeBlocks"]');
await page.waitForFunction(() => document.documentElement.classList.contains('lp-theme-techo-blocks'));
check('blocks class', (await cls()).includes('lp-theme-techo-blocks'));
await page.screenshot({ path: `${OUT}/theme.png` });
// 夜間護眼（v0.13.23）：淡綠、淺藍、粉色
for (const [v, bgWant] of [['night-mint', 'rgb(29, 39, 35)'], ['night-sky', 'rgb(28, 35, 44)'], ['night-sakura', 'rgb(38, 30, 34)']]) {
  await page.selectOption('#lp-theme', v);
  await page.waitForFunction((v) => document.documentElement.classList.contains(`lp-techo-${v.slice(6)}`), v);
  const c = await cls();
  const bgNow = await page.evaluate(() => getComputedStyle(document.querySelector('.lp-panel')).backgroundColor);
  check(`${v}: classes and dark paper`, c.includes('lp-theme-techo') && c.includes('lp-techo-night') && bgNow === bgWant && ['mint', 'sky', 'sakura'].filter((x) => c.includes(`lp-techo-${x}`)).length === 1, `${c} ${bgNow}`);
  await page.screenshot({ path: `${OUT}/look-${v}.png` });
}
await page.selectOption('#lp-theme', 'techo');
check('back to day planner drops night classes', !(await cls()).includes('lp-techo-night') && (await cls()).includes('lp-theme-techo'));
await page.selectOption('#lp-theme', 'tavern');
await page.waitForFunction(() => !document.documentElement.classList.contains('lp-theme-techo'));
check('back to tavern removes all', !(await cls()).includes('lp-theme-techo') && !(await cls()).includes('lp-techo-'));
check('font not added again', await page.evaluate(() => document.querySelectorAll('link[data-lp-font]').length === 1));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
