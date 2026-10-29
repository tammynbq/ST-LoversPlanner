// 更新通知（v0.13.30）：更新後打開大視窗最上面有「更新了什麼」，魔術棒選單和擴充設定有 NEW；
// 按「知道了」就不再出現；新安裝的不跳；設定 › 一般有全部更新紀錄。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
const CHAT = Array.from({ length: 4 }, (_, i) => ({ name: i % 2 ? '沈言' : '小雨', is_user: !(i % 2), mes: `第${i}則`, send_date: `d${i}`, extra: {} }));

const browser = await chromium.launch();
async function open(preset, { lang } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
  await page.addInitScript(({ chat, preset }) => { window.__chat = chat; if (preset) window.__presetSettings = preset; }, { chat: CHAT, preset });
  await page.goto(URL);
  await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry')));
  if (lang) await page.evaluate(async (lang) => { SillyTavern.getContext().extensionSettings.lovers_planner.language = lang; (await import('/src/ui/entry.js')).relabelEntries(); }, lang);
  return page;
}
const openPanel = async (page) => {
  await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; document.getElementById('lp_wand_entry').click(); });
  await page.waitForSelector('.lp-panel');
};
const version = await (async () => { const p = await open(null); const v = await p.evaluate(async () => (await import('/src/version.js')).VERSION); await p.close(); return v; })();

// ===== 1. 有這個功能之前就裝了（沒有 seenVersion）：只顯示這一版 =====
let page = await open({ lovers_planner: { settingsVersion: 5 } });
check('NEW on the wand entry', (await page.textContent('#lp_wand_entry')).includes('NEW'));
check('NEW on the settings drawer', (await page.textContent('#lp_settings_drawer')).includes('NEW'));
await openPanel(page);
// 內容跟著 CHANGES 走（每一版都會換）：最新一版的第一條、上一版的版本號和第一條。
const C = await page.evaluate(async () => { const { CHANGES } = await import('/src/changelog.js'); const f = (c) => (c.new ?? c.fix)['zh-TW'][0].slice(0, 12); return { now: f(CHANGES[0]), prevV: CHANGES[1].v, prev: f(CHANGES[1]) }; });
let card = await page.textContent('[data-role="whatsnew"]');
check('card shows this version', card.includes('戀人手帳更新了') && card.includes(`v${version}`) && card.includes(C.now) && !card.includes(C.prev), card.slice(0, 160));
await page.screenshot({ path: `${OUT}/whatsnew.png` });
await page.click('[data-action="whatsnew-all"]');
card = await page.textContent('[data-role="whatsnew"]');
check('see all expands older versions', card.includes(`v${C.prevV}`) && card.includes(C.prev) && card.includes('收起更新紀錄'), card.slice(0, 200));
await page.click('[data-action="whatsnew-ok"]');
check('got it hides the card', !(await page.$('[data-role="whatsnew"]')));
check('got it removes NEW', !(await page.textContent('#lp_wand_entry')).includes('NEW') && !(await page.textContent('#lp_settings_drawer')).includes('NEW'));
check('seen version saved', await page.evaluate(() => SillyTavern.getContext().extensionSettings.lovers_planner.ui.seenVersion) === version);
// 設定 › 一般有全部更新紀錄
await page.click('[data-tab="settings"]');
const log = await page.$eval('[data-role="changelog"]', (el) => { el.open = true; return el.textContent; });
check('changelog in settings', log.includes('更新紀錄') && log.includes(`v${version}`) && log.includes('v0.13.18'), log.slice(0, 120));
await page.close();

// ===== 2. 跳過幾版才更新：列出看過之後的每一版 =====
page = await open({ lovers_planner: { settingsVersion: 5, ui: { seenVersion: '0.13.27' } } });
await openPanel(page);
card = await page.textContent('[data-role="whatsnew"]');
check('lists every version since last seen', card.includes(`v0.13.27 → v${version}`) && card.includes('v0.13.29') && card.includes('v0.13.28') && !card.includes('v0.13.27\n') && !card.includes('小劇場排隊'), card.slice(0, 240));
await page.close();

// ===== 3. 已經看過這一版：不跳 =====
page = await open({ lovers_planner: { settingsVersion: 5, ui: { seenVersion: version } } });
check('no NEW once seen', !(await page.textContent('#lp_wand_entry')).includes('NEW'));
await openPanel(page);
check('no card once seen', !(await page.$('[data-role="whatsnew"]')));
await page.close();

// ===== 4. 新安裝：不跳，直接記成看過 =====
page = await open(null);
check('fresh install: no NEW', !(await page.textContent('#lp_wand_entry')).includes('NEW'));
await openPanel(page);
check('fresh install: no card', !(await page.$('[data-role="whatsnew"]')));
check('fresh install: marked seen', await page.evaluate(() => SillyTavern.getContext().extensionSettings.lovers_planner?.ui?.seenVersion) === version);
await page.close();

// ===== 5. 英文 =====
page = await open({ lovers_planner: { settingsVersion: 5, language: 'en' } });
await openPanel(page);
card = await page.textContent('[data-role="whatsnew"]');
check('english card', card.includes("Lover's Planner was updated") && card.includes(await page.evaluate(async () => (await import('/src/changelog.js')).CHANGES[0].new.en[0].slice(0, 12))) && card.includes('Got it'), card.slice(0, 160));
const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));
// 每一版三種語言都有寫
const langs = await page.evaluate(async () => (await import('/src/changelog.js')).CHANGES.filter((c) => [c.new, c.fix].filter(Boolean).some((x) => !x['zh-TW']?.length || !x['zh-CN']?.length || !x.en?.length)).map((c) => c.v));
check('every changelog entry has all three languages', !langs.length, JSON.stringify(langs));
await page.close();

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
