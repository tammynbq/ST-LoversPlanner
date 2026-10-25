// 摘要時跳過的內容：思維鏈、狀態欄、HTML／程式碼、自訂標籤、只看正文標籤；送去摘要的提示詞、設定頁的試試看。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

const AI = `<thinking>
先想想沈言該怎麼回應……
</thinking>
<content>沈言把傘遞給小雨。<div class="x">「別淋濕了。」</div></content>
<status>好感度：80</status>
\`\`\`html
<b>面板</b>
\`\`\`
<details><summary>小劇場</summary>番外內容</details>
<吐槽>作者的話</吐槽>`;
const CHAT = [
  { name: '小雨', is_user: true, mes: '下雨了。', send_date: 'd0', extra: {} },
  { name: '沈言', is_user: false, mes: AI, send_date: 'd1', extra: {} },
  { name: '小雨', is_user: true, mes: '謝謝。', send_date: 'd2', extra: {} },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => { window.__chat = chat; }, CHAT);
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

const clean = (text, rules) => page.evaluate(async ({ text, rules }) => (await import('/src/filter.js')).cleanForSummary(text, rules), { text, rules });
const base = { thinking: true, status: true, html: true, tags: '', only: '' };

// ===== 1. 規則 =====
let r = await clean(AI, base);
check('thinking removed', !r.includes('先想想'));
check('status removed', !r.includes('好感度'));
check('code block removed', !r.includes('面板'));
check('details removed', !r.includes('番外'));
check('div tag removed, text kept', r.includes('「別淋濕了。」') && !r.includes('<div'));
check('story kept', r.includes('沈言把傘遞給小雨'));
check('unknown custom tag kept by default', r.includes('作者的話'));
r = await clean(AI, { ...base, tags: '<吐槽>, note' });
check('custom tag removed', !r.includes('作者的話'), r);
r = await clean(AI, { ...base, only: 'content' });
check('only content tag', r === '沈言把傘遞給小雨。「別淋濕了。」', r);
r = await clean('沒有標籤的訊息', { ...base, only: 'content' });
check('only: message without the tag kept whole', r === '沒有標籤的訊息');
r = await clean('前面的推理</think>正文在這裡', base);
check('prefilled thinking (only closing tag)', r === '正文在這裡', r);
r = await clean('<THINK>大寫</THINK>正文', base);
check('case-insensitive', r === '正文', r);
r = await clean('<thinking>沒寫完的思考', base);
check('unclosed thinking left alone', r.includes('沒寫完'), r);
r = await clean('<status>不拿掉</status>正文', { ...base, status: false });
check('status kept when unticked', r.includes('不拿掉'));
r = await clean('a<b>粗體</b>和 <3', base);
check('inline tags stripped, text like <3 kept', r === 'a粗體和 <3', r);
r = await clean(AI, { thinking: false, status: false, html: false, tags: '', only: '' });
check('all off: unchanged', r === AI);

// ===== 2. 送去摘要的提示詞 =====
const prompt = await page.evaluate(async () => (await import('/src/summarize.js')).buildL1Prompt(1));
check('L1 prompt has story', prompt.prompt.includes('沈言把傘遞給小雨'));
check('L1 prompt has no thinking/status', !prompt.prompt.includes('先想想') && !prompt.prompt.includes('好感度') && !prompt.prompt.includes('番外'));
const hashSame = await page.evaluate(async () => {
  const { floorSource } = await import('/src/chat.js');
  const before = floorSource(1).hash;
  SillyTavern.getContext().extensionSettings.lovers_planner.filter.thinking = false;
  const after = floorSource(1).hash;
  SillyTavern.getContext().extensionSettings.lovers_planner.filter.thinking = true;
  return before === after;
});
check('changing filters does not make summaries stale', hashSame);

// ===== 3. 設定頁 =====
await page.click('#lp_wand_entry');
await page.click('[data-tab="settings"]');
await page.click('details[data-sec="filter"] > summary');
check('three checkboxes on by default', await page.isChecked('input[data-path="filter.thinking"]') && await page.isChecked('input[data-path="filter.status"]') && await page.isChecked('input[data-path="filter.html"]'));
await page.click('details[data-sec="filter"] .lp-preview-raw > summary');
await page.fill('[data-role="filter-test"]', AI);
let out = await page.textContent('[data-role="filter-result"]');
check('test box shows result', out.includes('沈言把傘') && !out.includes('先想想'), out);
await page.fill('#lp-filter-only', 'content');
await page.dispatchEvent('#lp-filter-only', 'change');
out = await page.textContent('[data-role="filter-result"]');
check('test box follows settings', out.trim() === '沈言把傘遞給小雨。「別淋濕了。」', out);
const saved = await page.evaluate(() => SillyTavern.getContext().extensionSettings.lovers_planner.filter);
check('settings saved', saved.only === 'content', JSON.stringify(saved));
await page.screenshot({ path: `${OUT}/filter-settings.png`, fullPage: true });

// ===== 4. 掃描最新 2 個 AI 樓層的標籤 =====
// 先讓上面的文字框失去焦點（不然它的 change 事件會在之後把值寫回去）。
await page.evaluate(() => document.activeElement?.blur());
await page.evaluate(() => {
  Object.assign(SillyTavern.getContext().extensionSettings.lovers_planner.filter, { thinking: true, status: true, html: true, tags: '', only: '', keep: '' });
});
await page.click('[data-tab="summary"]');
await page.click('[data-tab="settings"]');
if (!(await page.$eval('details[data-sec="filter"]', (d) => d.open))) await page.click('details[data-sec="filter"] > summary');
const names = await page.$$eval('[data-tag-row]', (rows) => rows.map((r) => r.dataset.tagRow));
check('scanner lists tags', ['thinking', 'content', 'status', 'details', '吐槽'].every((x) => names.includes(x)), names.join());
check('inline tags not listed', !names.includes('div') && !names.includes('summary'), names.join());
const mode = (tag) => page.$eval(`[data-role="tag-mode"][data-tag="${tag}"]`, (el) => el.value);
check('built-in tags start as skip', await mode('thinking') === 'skip' && await mode('status') === 'skip');
check('other tags start as read', await mode('content') === 'read' && await mode('吐槽') === 'read');
check('sample shown', (await page.textContent('[data-tag-row="status"]')).includes('好感度'));
await page.locator('[data-role="tag-scan"]').screenshot({ path: `${OUT}/filter-scan.png` });

await page.selectOption('[data-role="tag-mode"][data-tag="吐槽"]', 'skip');
let f = await page.evaluate(() => SillyTavern.getContext().extensionSettings.lovers_planner.filter);
check('skip adds to custom tags', f.tags === '吐槽', JSON.stringify(f));
check('custom tags field updated', (await page.inputValue('#lp-filter-tags')) === '吐槽');
await page.selectOption('[data-role="tag-mode"][data-tag="thinking"]', 'read');
f = await page.evaluate(() => SillyTavern.getContext().extensionSettings.lovers_planner.filter);
check('read on a built-in tag adds an exception', f.keep === 'thinking' && f.thinking === true, JSON.stringify(f));
r = await page.evaluate(async (t) => (await import('/src/filter.js')).cleanForSummary(t), AI);
check('exception honored', r.includes('先想想') && !r.includes('好感度') && !r.includes('作者的話'), r);
await page.selectOption('[data-role="tag-mode"][data-tag="content"]', 'only');
f = await page.evaluate(() => SillyTavern.getContext().extensionSettings.lovers_planner.filter);
check('only sets only list', f.only === 'content');
r = await page.evaluate(async (t) => (await import('/src/filter.js')).cleanForSummary(t), AI);
check('only applied', r === '沈言把傘遞給小雨。「別淋濕了。」', r);
await page.selectOption('[data-role="tag-mode"][data-tag="thinking"]', 'skip');
f = await page.evaluate(() => SillyTavern.getContext().extensionSettings.lovers_planner.filter);
check('back to skip removes the exception', f.keep === '' && f.tags === '吐槽', JSON.stringify(f));
await page.selectOption('[data-role="tag-mode"][data-tag="content"]', 'read');
f = await page.evaluate(() => SillyTavern.getContext().extensionSettings.lovers_planner.filter);
check('read clears only', f.only === '');

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const line of results) console.log(line);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
