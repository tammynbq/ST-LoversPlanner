// 自訂 API：拉取模型、測試連接、儲存。用 Playwright 攔截網路請求，模擬三種對方伺服器：
//   ok.example     有開 CORS，直接連
//   nocors.example 沒開 CORS，要改走酒館後端轉發
//   bad.example    Key 錯誤（401）
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const BASE = `http://127.0.0.1:${process.env.PORT ?? 8765}`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const backendCalls = [];
const directAuth = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.route('https://ok.example/**', async (route) => {
  const req = route.request();
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  directAuth.push(req.headers().authorization);
  if (req.url().endsWith('/models')) return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'zeta-mini' }, { id: 'alpha-large' }] }) });
  if (req.url().endsWith('/chat/completions')) {
    const body = req.postDataJSON();
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: `OK from ${body.model}` } }] }) });
  }
  return route.fulfill({ status: 404, headers: CORS, body: 'not found' });
});
// 被 CORS 擋時瀏覽器只給 TypeError；Playwright 攔截的回應不受 CORS 檢查，所以用中斷連線模擬。
await page.route('https://nocors.example/**', (route) => route.abort('failed'));
await page.route('https://bad.example/**', async (route) => {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  return route.fulfill({ status: 401, headers: CORS, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Invalid API key' } }) });
});
await page.route(`${BASE}/api/backends/chat-completions/**`, async (route) => {
  const body = route.request().postDataJSON();
  backendCalls.push({ url: route.request().url(), body });
  if (route.request().url().endsWith('/status')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'proxied-model' }] }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'OK via backend' } }] }) });
});

await page.goto(`${BASE}/tests/harness.html`);
await page.waitForFunction(() => document.getElementById('lp_wand_entry'));
await page.click('#lp_wand_entry');
await page.click('[data-tab="settings"]');
await page.click('details[data-sec="model"] > summary');
await page.click('input[data-path="source"][value="custom"]');

const order = await page.$$eval('.lp-custom .lp-label', (els) => els.map((e) => e.textContent.trim()));
check('field order URL → Key → model', JSON.stringify(order) === JSON.stringify(['API URL 地址', 'API Key', '模型']), JSON.stringify(order));
check('buttons', (await page.isVisible('[data-action="test-custom"]')) && (await page.isVisible('[data-action="save-custom"]')) && (await page.isVisible('[data-action="fetch-models"]')));

// 沒填網址就測試
await page.click('[data-action="test-custom"]');
await page.waitForSelector('.lp-error-text');
check('need url error', (await page.textContent('.lp-error-text')).includes('URL'));

// 直接連：拉取模型
await page.fill('#lp-custom-url', 'https://ok.example/v1/chat/completions');
await page.fill('#lp-custom-key', 'sk-test-123');
await page.click('[data-action="fetch-models"]');
await page.waitForSelector('select#lp-custom-model');
const opts = await page.$$eval('#lp-custom-model option', (os) => os.map((o) => o.value));
check('models fetched & sorted', JSON.stringify(opts) === JSON.stringify(['', 'alpha-large', 'zeta-mini', '__manual__']), JSON.stringify(opts));
check('auth header sent directly', directAuth.includes('Bearer sk-test-123'));
check('url normalized for request', backendCalls.length === 0);
check('models status text', (await page.textContent('[data-role="custom-status"]')).includes('2 個模型'));
check('key still in field after rerender', (await page.inputValue('#lp-custom-key')) === 'sk-test-123');

// 顯示／隱藏 Key
check('key hidden by default', (await page.getAttribute('#lp-custom-key', 'type')) === 'password');
await page.click('[data-action="toggle-key"]');
check('key shown', (await page.getAttribute('#lp-custom-key', 'type')) === 'text');

// 選模型 → 測試（真的叫模型）
await page.selectOption('#lp-custom-model', 'zeta-mini');
await page.click('[data-action="test-custom"]');
await page.waitForSelector('.lp-ok-text');
check('test calls model', (await page.textContent('.lp-ok-text')).includes('OK from zeta-mini'));
check('not saved yet', await page.evaluate(() => window.__extSettings.lovers_planner.custom.model === ''));
check('dirty shown', (await page.textContent('[data-role="custom-status"]')).includes('未儲存'));
await page.screenshot({ path: `${OUT}/custom-1-direct.png` });

// 儲存
await page.click('[data-action="save-custom"]');
const saved = await page.evaluate(() => window.__extSettings.lovers_planner.custom);
check('saved', saved.url === 'https://ok.example/v1' && saved.key === 'sk-test-123' && saved.model === 'zeta-mini', JSON.stringify(saved));
check('saved text, no dirty', (await page.textContent('[data-role="custom-status"]')).trim() === '已儲存');
check('select keeps saved model', (await page.inputValue('#lp-custom-model')) === 'zeta-mini');

// 手動輸入
await page.selectOption('#lp-custom-model', '__manual__');
check('manual input', (await page.getAttribute('#lp-custom-model', 'type')) === 'text');

// 沒開 CORS → 走酒館後端
await page.fill('#lp-custom-url', 'https://nocors.example/v1');
await page.click('[data-action="fetch-models"]');
await page.waitForSelector('select#lp-custom-model');
const st = backendCalls.find((c) => c.url.endsWith('/status'));
check('fallback to backend for models', Boolean(st));
check('backend gets url + our key', st && st.body.custom_url === 'https://nocors.example/v1' && st.body.custom_include_headers === 'Authorization: "Bearer sk-test-123"', JSON.stringify(st?.body));
check('fallback marked in status', (await page.textContent('[data-role="custom-status"]')).includes('經由酒館轉發'));
await page.selectOption('#lp-custom-model', 'proxied-model');
await page.click('[data-action="test-custom"]');
await page.waitForSelector('.lp-ok-text');
const gen = backendCalls.find((c) => c.url.endsWith('/generate'));
check('fallback to backend for chat', gen && gen.body.chat_completion_source === 'custom' && gen.body.model === 'proxied-model' && gen.body.stream === false);
check('backend reply shown', (await page.textContent('.lp-ok-text')).includes('OK via backend'));

// 401
await page.selectOption('#lp-custom-model', '__manual__');
await page.fill('#lp-custom-url', 'https://bad.example/v1');
await page.click('[data-action="fetch-models"]');
await page.waitForSelector('.lp-error-text');
check('401 message', (await page.textContent('.lp-error-text')).includes('401'));
await page.screenshot({ path: `${OUT}/custom-2-error.png` });

// 關掉沒儲存 → 下次打開恢復成已儲存的內容
await page.keyboard.press('Escape');
await page.click('.lp-drawer-open');
await page.click('[data-tab="settings"]');
if (!(await page.isVisible('#lp-custom-url'))) await page.click('details[data-sec="model"] > summary');
check('draft reset on reopen', (await page.inputValue('#lp-custom-url')) === 'https://ok.example/v1');

// 淺色主題
await page.evaluate(() => {
  const r = document.documentElement.style;
  r.setProperty('--SmartThemeBodyColor', 'rgb(60,50,40)');
  r.setProperty('--SmartThemeBlurTintColor', 'rgb(232,228,220)');
  r.setProperty('--SmartThemeEmColor', 'rgb(150,90,60)');
  document.body.style.background = '#ddd';
});
await page.click('[data-tab="summary"]');
await page.click('[data-tab="settings"]');
await page.screenshot({ path: `${OUT}/custom-3-light.png` });

console.log(results.join('\n'));
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
