// 美化主題：工具列 z-index 開到最大、body 加了 transform（會讓 position: fixed 失效）。大視窗還是要完整顯示在最上面。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript(() => {
  window.__chat = Array.from({ length: 40 }, (_, i) => ({ name: i % 2 ? '沈言' : '小雨', is_user: !(i % 2), mes: `第${i}則`, send_date: `d${i}`, extra: {} }));
});
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry')), null, { timeout: 15000 });
// 模擬美化主題
await page.evaluate(() => {
  document.body.style.transform = 'translateZ(0)';
  document.body.style.minHeight = '3000px';
  const bar = document.createElement('div');
  bar.id = 'theme-bar';
  bar.style.cssText = 'position:fixed;left:0;right:0;top:60px;height:120px;z-index:2147483647;background:pink';
  document.body.appendChild(bar);
  window.scrollTo(0, 1500);
});
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; document.getElementById('lp_wand_entry').click(); });
await page.waitForSelector('.lp-panel');
const hit = await page.evaluate(() => {
  const at = (x, y) => document.elementFromPoint(x, y)?.closest('.lp-panel') ? 'panel' : (document.elementFromPoint(x, y)?.id || document.elementFromPoint(x, y)?.className || '?');
  return { top: at(195, 100), tabs: at(195, 150), middle: at(195, 450), bottom: at(195, 820) };
});
check('panel above the theme bar', hit.top === 'panel' && hit.tabs === 'panel', JSON.stringify(hit));
check('panel fills the screen even with a transformed body', hit.middle === 'panel' && hit.bottom === 'panel', JSON.stringify(hit));
const rect = await page.evaluate(() => { const r = document.querySelector('.lp-panel').getBoundingClientRect(); return [r.top, r.height]; });
check('panel at the top of the viewport', Math.abs(rect[0]) < 2 && rect[1] > 800, JSON.stringify(rect));
check('on the top layer', await page.evaluate(() => document.querySelector('.lp-overlay').matches(':popover-open')));
await page.screenshot({ path: `${OUT}/theme-mobile.png` });
// 分頁還能點、Esc 能關
await page.click('[data-tab="settings"]');
check('tabs clickable', await page.isVisible('details[data-sec="general"]'));
await page.keyboard.press('Escape');
check('closes', !(await page.$('.lp-overlay')));
// 再開一次也正常
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; document.getElementById('lp_wand_entry').click(); });
check('reopens on the top layer', await page.evaluate(() => document.querySelector('.lp-overlay')?.matches(':popover-open')));

// ===== 沒有 popover 的舊瀏覽器＋主題把聊天區放在最上面：自我檢查要救回來 =====
const page2 = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
page2.on('pageerror', (e) => errors.push('pageerror2: ' + e.message));
await page2.addInitScript(() => {
  delete HTMLElement.prototype.showPopover;
  window.__chat = Array.from({ length: 4 }, (_, i) => ({ name: i % 2 ? '沈言' : '小雨', is_user: !(i % 2), mes: `第${i}則`, send_date: `d${i}`, extra: {} }));
});
await page2.goto(URL);
await page2.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry')), null, { timeout: 15000 });
await page2.evaluate(() => {
  document.body.style.transform = 'translateZ(0)';
  const sheld = document.createElement('div');
  sheld.id = 'sheld';
  sheld.style.cssText = 'position:fixed;left:0;right:0;top:100px;bottom:0;z-index:2147483647;background:#eee';
  document.body.appendChild(sheld);
  document.getElementById('extensionsMenu').style.display = '';
  document.getElementById('lp_wand_entry').click();
});
await page2.waitForTimeout(400);
const hit2 = await page2.evaluate(() => {
  const el = document.elementFromPoint(195, 500);
  return { panel: Boolean(el?.closest('.lp-panel')), parent: document.querySelector('.lp-overlay')?.parentElement?.tagName };
});
check('self-check rescues a covered window (no popover)', hit2.panel && hit2.parent === 'HTML', JSON.stringify(hit2));
await page2.screenshot({ path: `${OUT}/theme-rescued.png` });
await page2.close();

// ===== 窄螢幕：按鈕不能被擠成一個字寬的直條（主題把 .menu_button 設成 min-content 也一樣） =====
const page3 = await browser.newPage({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
await page3.addInitScript(() => {
  window.__chat = Array.from({ length: 6 }, (_, i) => ({ name: i % 2 ? '沈言' : '小雨', is_user: !(i % 2), mes: `第${i}則`, send_date: `d${i}`, extra: {} }));
  window.__presetSettings = { lovers_planner: { language: 'zh-CN' } };
});
await page3.goto(URL);
await page3.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry')), null, { timeout: 15000 });
await page3.addStyleTag({ content: '.menu_button { width: min-content; }' });
await page3.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; document.getElementById('lp_wand_entry').click(); });
await page3.click('[data-tab="summary"]');
const tall = await page3.$$eval('.lp-panel .lp-btn', (els) => els.filter((b) => b.offsetParent).map((b) => [b.textContent.trim(), Math.round(b.getBoundingClientRect().height)]).filter(([, h]) => h > 60));
check('buttons stay on one line on a narrow screen', tall.length === 0, JSON.stringify(tall));
await page3.screenshot({ path: `${OUT}/theme-narrow.png` });
await page3.close();

// 程式版本和 manifest 一致；擴充設定裡顯示版本
const versions = await page.evaluate(async () => {
  const { VERSION } = await import('/src/version.js');
  const manifest = await (await fetch('/manifest.json', { cache: 'no-store' })).json();
  return { VERSION, manifest: manifest.version, drawer: document.querySelector('#lp_settings_drawer .lp-version')?.textContent };
});
check('code version matches manifest', versions.VERSION === versions.manifest, JSON.stringify(versions));
check('drawer shows the running version', versions.drawer === `v${versions.VERSION}`, JSON.stringify(versions));

for (const line of results) console.log(line);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
