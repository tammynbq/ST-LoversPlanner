// 好幾組 API（v0.13.35）：另外存幾組 API、每種工作用哪一組、失敗時改用另一組；Key 不進備份。
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
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|status of 500/.test(m.text())) errors.push('console: ' + m.text()); });
const hits = [];
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
for (const host of ['cheap', 'good', 'down']) {
  await page.route(`https://${host}.test/v1/**`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    hits.push(host);
    if (host === 'down') return route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":{"message":"down"}}' });
    if (route.request().url().endsWith('/models')) return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ data: [{ id: `${host}-model` }] }) });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ choices: [{ message: { content: host.toUpperCase() } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) });
  });
}
await page.addInitScript(() => {
  window.__chat = Array.from({ length: 4 }, (_, i) => ({ name: i % 2 ? '沈言' : '小雨', is_user: !(i % 2), mes: `第${i}則`, send_date: `d${i}`, extra: {} }));
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, ui: { seenVersion: '9.9.9' } } };
});
await page.goto(URL);
await page.waitForFunction(() => Boolean(globalThis.loversPlannerInterceptor));
await page.evaluate(() => { window.__generateRaw = async () => 'MAIN'; document.getElementById('extensionsMenu').style.display = ''; document.getElementById('lp_wand_entry').click(); });
await page.click('[data-tab="settings"]');
await page.click('details[data-sec="model"] > summary');
// 預設：自訂 API＝便宜那組
await page.click('input[data-path="source"][value="custom"]');
await page.fill('#lp-custom-url', 'https://cheap.test/v1');
await page.fill('#lp-custom-model', 'cheap-model');
await page.click('[data-action="save-custom"]');
// 新增一組「細膩」
await page.click('[data-action="profile-add"]');
await page.fill('#lp-profile-name', '🦉 細膩');
await page.fill('#lp-profile-url', 'https://good.test/v1/chat/completions');
await page.click('[data-action="fetch-models"][data-api="profile"]');
await page.waitForFunction(() => document.querySelector('#lp-profile-model option[value="good-model"]'));
await page.selectOption('#lp-profile-model', 'good-model');
await page.click('[data-action="test-profile"]');
await page.waitForFunction(() => document.querySelector('[data-role="profile-status"]')?.textContent.includes('GOOD'));
check('test a group', true);
await page.click('[data-action="save-profile"]');
let s = await page.evaluate(() => SillyTavern.getContext().extensionSettings.lovers_planner);
const pid = s.profiles?.[0]?.id;
check('group saved with name, cleaned url and model', s.profiles.length === 1 && s.profiles[0].name === '🦉 細膩' && s.profiles[0].url === 'https://good.test/v1' && s.profiles[0].model === 'good-model', JSON.stringify(s.profiles));
check('default custom kept its timeout', s.custom.url === 'https://cheap.test/v1' && Number(s.custom.timeout) > 0, JSON.stringify(s.custom));
await page.click('[data-action="profile-close"]');
check('list shows the group', (await page.textContent('[data-role="profiles"]')).includes('🦉 細膩') && (await page.textContent('[data-role="profiles"]')).includes('good-model'));

// 每種工作用哪一組：壓縮用細膩、寫日記用主 API
await page.selectOption('select[data-route="compress"]', pid);
await page.selectOption('select[data-route="diary"]', 'main');
const opts = await page.$$eval('select[data-route="l1"] option', (els) => els.map((e) => e.textContent.trim()));
check('route options', opts[0].startsWith('跟預設') && opts.includes('酒館主 API') && opts.includes('🦉 細膩'), JSON.stringify(opts));
const run = (purpose) => page.evaluate(async (purpose) => { const llm = await import('/src/llm.js'); const text = await llm.generateText('你好', { purpose }); return { text, label: llm.modelLabel() }; }, purpose);
let r = await run('l1');
check('floor summaries use the default group', r.text === 'CHEAP' && r.label === 'cheap-model', JSON.stringify(r));
r = await run('compress');
check('compression uses the careful group', r.text === 'GOOD' && r.label === 'good-model', JSON.stringify(r));
r = await run('diary');
check('diary uses the main API', r.text === 'MAIN', JSON.stringify(r));
check('main API use detected for warnings and the queue', await page.evaluate(async () => { const llm = await import('/src/llm.js'); return llm.usesMain('diary') && !llm.usesMain('l1') && llm.usesMain(); }));
await page.screenshot({ path: `${OUT}/profiles.png`, fullPage: true });

// 失敗時改用另一組
await page.evaluate(() => { const st = SillyTavern.getContext().extensionSettings.lovers_planner; st.custom.url = 'https://down.test/v1'; });
await page.selectOption('select[data-route="fallback"]', pid);
hits.length = 0;
r = await run('l1');
check('falls back to the other group', r.text === 'GOOD' && r.label === 'good-model' && hits.includes('down') && hits.at(-1) === 'good', JSON.stringify({ r, hits }));
const usage = await page.evaluate(async () => (await import('/src/usage.js')).recentUsage(3).map((x) => `${x.model}:${x.ok}`));
check('usage records the failed call and the fallback', usage[0] === 'good-model:true' && usage[1] === 'cheap-model:false', JSON.stringify(usage));
await page.selectOption('select[data-route="fallback"]', '');
let failed = await page.evaluate(async () => { try { await (await import('/src/llm.js')).generateText('x', { purpose: 'l1' }); return false; } catch (e) { return true; } });
check('no fallback: the error comes through', failed);

// 備份不帶 Key；導入沿用這台裝置的 Key
await page.evaluate(() => { SillyTavern.getContext().extensionSettings.lovers_planner.profiles[0].key = 'secret-key'; });
const bk = await page.evaluate(async () => {
  const b = await import('/src/backup.js');
  const data = b.buildBackup({ settings: true });
  const copy = JSON.parse(JSON.stringify(data));
  const res = b.importBackup(copy, { mode: 'replace', settings: true });
  return { exported: data.settings.profiles[0].key, after: SillyTavern.getContext().extensionSettings.lovers_planner.profiles[0].key };
});
check('profile keys stay out of backups and survive import', bk.exported === '' && bk.after === 'secret-key', JSON.stringify(bk));

// 刪掉一組：用到它的工作改回跟預設
await page.click('[data-action="profile-delete"]');
s = await page.evaluate(() => SillyTavern.getContext().extensionSettings.lovers_planner);
check('delete resets routes', !s.profiles.length && s.routes.compress === 'inherit' && s.routes.diary === 'main', JSON.stringify(s.routes));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));
for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
