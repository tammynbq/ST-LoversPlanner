// 系統提示詞：成人虛構故事的說明（預設開）＋自訂前言；主 API 用 systemPrompt、自訂 API 用 system 訊息；關掉就不送；設定頁。
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
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i}`, send_date: `d${i}`, extra: {} });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, recall: { notes: false, memory: false }, compress: { auto: false } } };
}, CHAT);
// 假的自訂 API：記下送了什麼。
const bodies = [];
await page.route('https://api.example.com/v1/chat/completions', async (route) => {
  bodies.push(JSON.parse(route.request().postData()));
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ choices: [{ message: { content: '{"summary":"自訂 API 的摘要","ops":[]}' } }] }) });
});
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

const summarize = (i) => page.evaluate(async (i) => {
  const { enqueue, pendingCount } = await import('/src/summarize.js');
  window.__prompts.length = 0;
  enqueue(i);
  const t0 = Date.now();
  while (pendingCount() && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 100));
  return window.__prompts[window.__prompts.length - 1] ?? null;
}, i);
const settings = (patch) => page.evaluate((patch) => {
  const s = SillyTavern.getContext().extensionSettings.lovers_planner;
  for (const [k, v] of Object.entries(patch)) s[k] = typeof v === 'object' && !Array.isArray(v) ? { ...s[k], ...v } : v;
}, patch);

// ===== 1. 主 API：預設開 =====
let sent = await summarize(1);
check('note on by default (main API systemPrompt)', sent?.systemPrompt?.includes('所有角色都是成年人') && sent.systemPrompt.includes('不露骨'), JSON.stringify(sent?.systemPrompt));
check('user prompt unchanged', sent.prompt.includes('AI1') && !sent.prompt.includes('所有角色都是成年人'));

await settings({ model: { preface: '你是專業的成人小說編輯。' } });
sent = await summarize(3);
check('preface after the note', sent.systemPrompt.indexOf('所有角色都是成年人') < sent.systemPrompt.indexOf('你是專業的成人小說編輯。'), sent.systemPrompt);

await settings({ model: { adultNote: false, preface: '' } });
sent = await summarize(5);
check('nothing extra when both off', sent && !('systemPrompt' in sent), JSON.stringify(Object.keys(sent ?? {})));

// ===== 2. 自訂 API：system 訊息 =====
await settings({ model: { adultNote: true, preface: '自訂前言' }, source: 'custom', custom: { url: 'https://api.example.com/v1', key: 'k', model: 'm' } });
await summarize(7);
const body = bodies[bodies.length - 1];
check('custom API gets a system message first', body?.messages?.[0]?.role === 'system' && body.messages[0].content.includes('所有角色都是成年人') && body.messages[0].content.includes('自訂前言') && body.messages[1]?.role === 'user', JSON.stringify(body?.messages?.map((m) => m.role)));
check('custom API summary saved', await page.evaluate(() => window.__chat[7].extra.lovers_planner?.summary === '自訂 API 的摘要'));
await settings({ source: 'main' });

// ===== 3. 設定頁 =====
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="settings"]');
if (!(await page.isVisible('input[data-path="model.adultNote"]'))) await page.click('details[data-sec="model"] > summary');
check('note checkbox in settings', await page.isChecked('input[data-path="model.adultNote"]'));
await page.fill('#lp-preface', '新的前言');
await page.locator('#lp-preface').blur();
check('preface saved', await page.evaluate(() => SillyTavern.getContext().extensionSettings.lovers_planner.model.preface === '新的前言'));
await page.screenshot({ path: `${OUT}/system.png` });

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
