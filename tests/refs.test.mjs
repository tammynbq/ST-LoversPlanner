// 標籤檢查和「只當參考」：抽出日期／時間／地點那幾行、不當正文、提示詞（單層＋補建）、猜標籤類型、設定頁。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

const HORAE = (d) => `<horae>\ntime: 2025/03/0${d} 星期三 晚上\nlocation: 海邊小屋\ncostume: 白襯衫\nmood: 平靜\n</horae>`;
const STYLE = '<orange><div style="color:red">x</div>\ncolor: red\nfont-size: 12px\nbackground: #fff\n</orange>';
const IMAGE = '<image>角度：俯視\n人物数量：2\n构图：半身</image>';
const PLAN = '<approaching>結構：先A後B\n字數：800\n語氣：溫柔</approaching>';
const SB = '<sb>時間：三月五日 晚上｜地點：客廳｜事件：看電影</sb>';
const CHAT = [];
for (let i = 0; i < 8; i++) {
  const ai = i % 2 === 1;
  const mes = ai ? `沈言把傘遞給小雨。「別淋濕了。」${HORAE(Math.min(9, i))}${STYLE}${IMAGE}${PLAN}${SB}<story>${'他們在雨裡走了很久，誰都沒有說話，'.repeat(6)}</story>` : `U${i}`;
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes, send_date: `d${i}`, extra: {} });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, recall: { notes: false, memory: false }, compress: { auto: false } } };
}, CHAT);
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

// ===== 1. 抽欄位 =====
const ex = await page.evaluate(async ({ h, sb }) => {
  const { extractRef } = await import('/src/filter.js');
  const rules = { ref: 'horae, sb', refKeys: 'time, location, 時間, 地點' };
  return {
    both: extractRef(`正文${h}正文${sb}`, rules),
    dup: extractRef(`${h}${h}`, rules),
    none: extractRef(h, { ref: '', refKeys: 'time' }),
    bracket: extractRef('<horae>- [time]：第三天 傍晚\n[mood]: 好</horae>', rules),
    long: extractRef(`<horae>time: ${'很'.repeat(200)}</horae>`, rules),
    noKeys: extractRef(h, { ref: 'horae', refKeys: '' }),
  };
}, { h: HORAE(5), sb: SB });
check('extracts chosen fields only', ex.both === 'time: 2025/03/05 星期三 晚上\nlocation: 海邊小屋\n時間: 三月五日 晚上\n地點: 客廳', JSON.stringify(ex.both));
check('same lines kept once', ex.dup.split('\n').length === 2, ex.dup);
check('nothing when no ref tags', ex.none === '');
check('bullets and brackets ok', ex.bracket === 'time: 第三天 傍晚', ex.bracket);
check('long values cut', ex.long.length <= 'time: '.length + 80, String(ex.long.length));
check('nothing when no keys', ex.noKeys === '');

// ===== 2. 模式 =====
const modes = await page.evaluate(async () => {
  const { setTagMode, tagMode, cleanForSummary } = await import('/src/filter.js');
  const f = SillyTavern.getContext().extensionSettings.lovers_planner.filter;
  setTagMode('horae', 'ref');
  const a = { mode: tagMode('horae').mode, ref: f.ref, clean: cleanForSummary(window.__chat[1].mes) };
  setTagMode('horae', 'skip');
  const b = { mode: tagMode('horae').mode, ref: f.ref, tags: f.tags };
  setTagMode('horae', 'ref');
  setTagMode('sb', 'ref');
  return { a, b, c: { ref: f.ref, tags: f.tags } };
});
check('ref mode set', modes.a.mode === 'ref' && modes.a.ref === 'horae');
check('ref tag not in story text', !modes.a.clean.includes('海邊小屋') && modes.a.clean.includes('別淋濕了'), modes.a.clean.slice(0, 80));
check('switching modes moves lists', modes.b.mode === 'skip' && modes.b.ref === '' && modes.b.tags.includes('horae'));
check('back to ref', modes.c.ref === 'horae, sb' && !modes.c.tags.includes('horae'), JSON.stringify(modes.c));

// ===== 3. 提示詞 =====
const p1 = await page.evaluate(async () => (await (await import('/src/summarize.js')).buildL1Prompt(5)).prompt);
check('single-floor prompt has the reference section', p1.includes('【狀態欄參考') && p1.includes('time: 2025/03/05 星期三 晚上') && p1.includes('地點: 客廳'), p1.slice(p1.indexOf('這一段對話'), p1.indexOf('這一段對話') + 600));
check('reference says story wins', p1.includes('和正文衝突時以正文為準'));
check('costume not passed by default', !p1.includes('白襯衫'));
await page.evaluate(() => { SillyTavern.getContext().extensionSettings.lovers_planner.filter.refKeys += ', costume'; });
const p2 = await page.evaluate(async () => (await (await import('/src/summarize.js')).buildL1Prompt(5)).prompt);
check('extra field passed after adding it', p2.includes('costume: 白襯衫'));

// 補建（粗略成章）：每層一行
const coarse = await page.evaluate(async () => {
  window.__prompts.length = 0;
  window.__generateRaw = async () => JSON.stringify({ time: '', location: '', characters: [], summary: '粗章', ops: [] });
  const { startCatchup } = await import('/src/catchup.js');
  startCatchup({ from: 0, to: 7, fineCount: 0, block: 10 });
  for (let k = 0; k < 50 && !window.__prompts.length; k++) await new Promise((r) => setTimeout(r, 100));
  return window.__prompts[0]?.prompt ?? '';
});
check('catch-up prompt has one line per floor', /#1 time: 2025\/03\/01[^\n]*；location: 海邊小屋/.test(coarse) && /#7 time: 2025\/03\/07/.test(coarse), coarse.slice(coarse.indexOf('【狀態欄參考'), coarse.indexOf('【狀態欄參考') + 300));

// ===== 4. 猜類型 =====
const kinds = await page.evaluate(async () => {
  const { scanTags } = await import('/src/filter.js');
  const out = {};
  for (const x of scanTags(window.__chat.filter((m) => !m.is_user).map((m, k) => ({ index: k, text: m.mes })))) out[x.name] = { kind: x.kind, dated: x.dated, count: x.count, placed: x.placed, keys: x.keys, full: x.full.slice(0, 30) };
  return out;
});
check('status bar guessed', kinds.horae?.kind === 'status' && kinds.horae.dated === kinds.horae.count && kinds.horae.placed > 0, JSON.stringify(kinds.horae));
check('one-line status guessed', kinds.sb?.kind === 'status', JSON.stringify(kinds.sb));
check('styling guessed', kinds.orange?.kind === 'style', JSON.stringify(kinds.orange));
check('image prompt guessed', kinds.image?.kind === 'image', JSON.stringify(kinds.image));
check('writing plan guessed', kinds.approaching?.kind === 'thinking', JSON.stringify(kinds.approaching));
check('prose guessed', kinds.story?.kind === 'story', JSON.stringify(kinds.story));
check('keys listed', JSON.stringify(kinds.horae.keys) === JSON.stringify(['time', 'location', 'costume', 'mood']), JSON.stringify(kinds.horae.keys));
check('full content is the latest one', kinds.horae.full.includes('2025/03/07'), kinds.horae.full);

// ===== 5. 設定頁 =====
await page.evaluate(async () => {
  const { setTagMode } = await import('/src/filter.js');
  setTagMode('sb', 'read');
  (await import('/src/summarize.js')).cancelQueue();
  document.getElementById('extensionsMenu').style.display = '';
});
await page.click('#lp_wand_entry');
await page.click('[data-tab="settings"]');
if (!(await page.isVisible('[data-role="tag-scan"]'))) await page.click('details[data-sec="filter"] > summary');
const row = (name) => page.textContent(`[data-tag-row="${name}"]`);
let sb = await row('sb');
check('kind badge and flags', sb.includes('📋 狀態欄') && sb.includes('📅 100% 有日期或時間') && sb.includes('📍 有地點'), sb.replace(/\s+/g, ' '));
check('suggests reference for status bars', sb.includes('只當參考'));
check('full content expandable', await page.isVisible('[data-tag-row="sb"] .lp-tag-full summary'));
await page.selectOption('[data-tag-row="sb"] [data-role="tag-mode"]', 'ref');
sb = await row('sb');
check('ref preview shows the lines', (await page.textContent('[data-tag-row="sb"] [data-role="tag-ref"]')).includes('時間: 三月五日 晚上；地點: 客廳'), sb.replace(/\s+/g, ' '));
check('ref fields in settings', (await page.inputValue('#lp-filter-ref')).includes('sb') && (await page.inputValue('#lp-filter-refkeys')).includes('costume'));
check('style row badge', (await row('orange')).includes('🎨 排版美化'));
await page.screenshot({ path: `${OUT}/refs.png` });

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
