import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));
const OUT = process.argv[2] ?? '.';
const browser = await chromium.launch();
const errors = [];
const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

async function newPage(viewport, init = '') {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  if (init) await page.addInitScript(init);
  await page.goto(`http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`);
  await page.waitForFunction(() => document.getElementById('lp_wand_entry'));
  return page;
}

const page = await newPage({ width: 1200, height: 860 });
check('wand label', (await page.textContent('#lp_wand_entry')).trim() === '戀人手帳');
check('drawer button', (await page.textContent('.lp-drawer-open')).trim() === '打開戀人手帳');
check('settings merged', await page.evaluate(() => window.__extSettings.lovers_planner?.summary?.ratioMax === 6));
check('default mode is before', await page.evaluate(() => window.__extSettings.lovers_planner.summary.mode === 'before'));
const miss = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys consistent', Object.keys(miss).length === 0, JSON.stringify(miss));

await page.click('#lp_wand_entry');
check('panel opens', await page.isVisible('.lp-panel'));
check('subtitle', (await page.textContent('.lp-title')).includes('沈言 / 雨天的約定'));
await page.screenshot({ path: `${OUT}/1-summary.png` });

await page.click('[data-tab="settings"]');
for (const sec of ['model', 'summary', 'compress', 'hide', 'scope', 'inject', 'advanced']) {
  await page.click(`details[data-sec="${sec}"] > summary`);
}
await page.screenshot({ path: `${OUT}/2-settings.png`, fullPage: false });

// 包含使用者發言 → 關掉出現警告
await page.click('input[data-path="summary.includeUser"]');
check('includeUser warning', await page.isVisible('.lp-callout'));
check('sections stay open after rerender', await page.evaluate(() => document.querySelector('details[data-sec="advanced"]').open));

// 自訂 API
await page.click('input[data-path="source"][value="custom"]');
await page.fill('#lp-custom-url', 'https://api.example.com/v1/');
check('custom url not saved before Save', await page.evaluate(() => window.__extSettings.lovers_planner.custom.url === ''));
check('dirty indicator', (await page.textContent('[data-role="custom-status"]')).includes('未儲存'));
await page.click('[data-action="save-custom"]');
check('custom url saved (normalized)', await page.evaluate(() => window.__extSettings.lovers_planner.custom.url === 'https://api.example.com/v1'));
check('model hint updates', (await page.textContent('details[data-sec="model"] .lp-sec-hint')).includes('自訂'));

// 數字範圍連動
await page.fill('input[data-path="summary.ratioMin"]', '20');
await page.press('input[data-path="summary.ratioMin"]', 'Tab');
check('range pair fix', await page.evaluate(() => { const s = window.__extSettings.lovers_planner.summary; return s.ratioMin === 20 && s.ratioMax === 20; }));
check('range input updated', (await page.inputValue('input[data-path="summary.ratioMax"]')) === '20');
await page.fill('input[data-path="summary.minTokens"]', '99999');
await page.press('input[data-path="summary.minTokens"]', 'Tab');
check('clamp', await page.evaluate(() => window.__extSettings.lovers_planner.summary.minTokens === 4000));

// 記憶範圍
await page.click('input[data-scope="char"][data-kind="todos"][value="share"]');
check('character scope saved', await page.evaluate(() => window.__extSettings.lovers_planner.characters['shenyan.png'].scope.todos === 'share'));
await page.click('input[data-scope="chat"][data-kind="items"][value="own"]');
check('chat scope saved', await page.evaluate(() => window.__chatMetadata.lovers_planner.scope.items === 'own' && window.__chatMetadata.lovers_planner.scope.todos === 'inherit'));

// 提示詞模板：改 → 已修改 → 恢復預設（要確認）
check('reset disabled when default', await page.isDisabled('[data-action="reset-ask"]'));
await page.click('.lp-template');
await page.keyboard.type('測試');
check('modified chip', await page.isVisible('[data-role="tpl-modified"]'));
check('prompt saved', await page.evaluate(() => typeof window.__extSettings.lovers_planner.prompts.l1 === 'string'));
await page.click('[data-action="reset-ask"]');
check('confirm shown', await page.isVisible('[data-action="reset-yes"]'));
await page.click('[data-action="reset-no"]');
check('cancel keeps edit', await page.evaluate(() => typeof window.__extSettings.lovers_planner.prompts.l1 === 'string'));
await page.click('[data-action="reset-ask"]');
await page.click('[data-action="reset-yes"]');
check('reset done', await page.evaluate(() => window.__extSettings.lovers_planner.prompts.l1 === null) && await page.isVisible('.lp-ok-text'));
check('textarea back to default', !(await page.inputValue('.lp-template')).includes('測試'));
await page.click('[data-tpl="l2"]');
check('switch template', (await page.inputValue('.lp-template')).includes('章節總結'));
await page.screenshot({ path: `${OUT}/3-advanced.png` });

// 換語言
await page.selectOption('#lp-lang', 'en');
check('panel in English', (await page.textContent('[data-tab="settings"]')).trim() === 'Settings');
check('wand relabel', (await page.textContent('#lp_wand_entry')).trim() === "Lover's Planner");
check('default template follows language', (await page.inputValue('.lp-template')).includes('chapter summary'));
await page.selectOption('#lp-lang', 'zh-CN');
check('panel in zh-CN', (await page.textContent('[data-tab="settings"]')).trim() === '设置');
await page.selectOption('#lp-lang', 'auto');

// 關閉：Esc、背景
await page.keyboard.press('Escape');
check('esc closes', !(await page.isVisible('.lp-overlay')));
await page.click('.lp-drawer-open');
await page.mouse.click(5, 5);
check('backdrop closes', !(await page.isVisible('.lp-overlay')));

// 關掉插件 → 提示
await page.click('.lp-drawer-open');
await page.click('[data-tab="settings"]');
await page.click('input[data-path="enabled"]');
check('disabled banner', (await page.textContent('.lp-banner')).includes('關閉'));
await page.close();

// 手機 + 群組聊天
const mobile = await newPage({ width: 390, height: 844 }, 'window.__group = true;');
await mobile.click('#lp_wand_entry');
check('group banner', (await mobile.textContent('.lp-banner')).includes('群組'));
await mobile.screenshot({ path: `${OUT}/4-mobile-group.png` });
await mobile.click('[data-tab="settings"]');
await mobile.click('details[data-sec="scope"] > summary');
await mobile.click('details[data-sec="model"] > summary');
await mobile.click('input[data-path="source"][value="custom"]');
const overflow = await mobile.evaluate(() => document.querySelector('.lp-body').scrollWidth > document.querySelector('.lp-body').clientWidth);
check('no horizontal overflow on phone', !overflow);
await mobile.screenshot({ path: `${OUT}/5-mobile-settings.png` });

// 舊版設定的轉換：還是舊預設長度的換成新預設；自己改過的不動
const old = await newPage({ width: 800, height: 600 }, 'window.__presetSettings = { lovers_planner: { summary: { mode: "auto", ratioMin: 5, ratioMax: 10, minTokens: 30, maxTokens: 300 }, inject: { position: "in_chat", depth: 4 } } };');
check('migrate old defaults', await old.evaluate(() => { const s = window.__extSettings.lovers_planner; return s.summary.ratioMin === 3 && s.summary.ratioMax === 6 && s.summary.maxTokens === 150 && s.summary.mode === 'before' && s.inject.position === 'before_recent' && s.settingsVersion === 5 && s.compress.l2PerL3 === 5 && s.compress.higherPer === 5 && s.recall.vector.url === 'https://api.siliconflow.cn/v1' && s.recall.vector.model === 'BAAI/bge-m3'; }));
const v2 = await newPage({ width: 800, height: 600 }, 'window.__presetSettings = { lovers_planner: { settingsVersion: 2, inject: { position: "in_chat", depth: 6 } } };');
check('keep customized injection', await v2.evaluate(() => window.__extSettings.lovers_planner.inject.position === 'in_chat'));
const custom = await newPage({ width: 800, height: 600 }, 'window.__presetSettings = { lovers_planner: { summary: { ratioMin: 8, ratioMax: 12, maxTokens: 400 } } };');
check('keep customized length', await custom.evaluate(() => { const s = window.__extSettings.lovers_planner.summary; return s.ratioMin === 8 && s.ratioMax === 12 && s.maxTokens === 400; }));

// 英文瀏覽器、酒館沒有語言設定
const en = await newPage({ width: 1000, height: 700 }, 'window.__locale = "en";');
check('english host', (await en.textContent('#lp_wand_entry')).trim() === "Lover's Planner");

console.log(results.join('\n'));
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
