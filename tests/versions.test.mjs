// 單層摘要的版本：重做、手動修改前的版本存起來（最多 5 個）、記著是哪個模型寫的、可以換回來（現在的也存回去）、
// 失敗時舊的還在、記事變化跟著版本走。
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
for (let i = 0; i < 4; i++) {
  const ai = i % 2 === 1;
  CHAT.push({ name: ai ? '白起' : '米米', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i}`, send_date: `d${i}`, extra: {} });
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

const run = (reply, model) => page.evaluate(async ({ reply, model }) => {
  window.__model = model;
  window.__generateRaw = async () => reply;
  const { enqueue, pendingCount } = await import('/src/summarize.js');
  enqueue(1);
  const t0 = Date.now();
  while (pendingCount() && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 100));
  const e = window.__chat[1].extra.lovers_planner;
  return { summary: e.summary, by: e.by, status: e.status, history: (e.history ?? []).map((v) => `${v.summary}|${v.by}`) };
}, { reply, model });

let r = await run('{"summary":"A 版","ops":[{"op":"add","type":"character","data":{"name":"白起","outfit":"西裝"}}]}', 'deepseek-chat');
check('first summary has no history, remembers the model', r.summary === 'A 版' && r.by.includes('deepseek-chat') && !r.history.length, JSON.stringify(r));
r = await run('{"summary":"B 版","ops":[{"op":"add","type":"character","data":{"name":"白起","outfit":"睡衣"}}]}', 'gemini-flash');
check('redo keeps the old version', r.summary === 'B 版' && r.history.length === 1 && r.history[0].startsWith('A 版|') && r.history[0].includes('deepseek-chat'), JSON.stringify(r));
const outfit = () => page.evaluate(async () => [...(await import('/src/notes.js')).getNotes().notes.values()].find((n) => n.data.name === '白起')?.data.outfit);
check('notes follow the current version', (await outfit()) === '睡衣');

// 摘要區塊：其他版本、用這一版
await page.evaluate(async () => {
  const { renderAllBlocks } = await import('/src/ui/message.js');
  renderAllBlocks();
  document.querySelector('.mes[mesid="1"] [data-lp-act="toggle"]')?.click();
});
const block = await page.textContent('.mes[mesid="1"] .lp-sum');
check('block shows who wrote it and other versions', block.includes('由 主 API・gemini-flash 摘要') && block.includes('其他版本（1）') && block.includes('A 版'), block.replace(/\s+/g, ' '));
await page.evaluate(() => document.querySelector('.mes[mesid="1"] [data-lp-act="restore"][data-k="0"]').click());
r = await page.evaluate(() => { const e = window.__chat[1].extra.lovers_planner; return { summary: e.summary, history: (e.history ?? []).map((v) => v.summary) }; });
check('restore swaps versions', r.summary === 'A 版' && JSON.stringify(r.history) === '["B 版"]', JSON.stringify(r));
check('notes follow the restored version', (await outfit()) === '西裝');

// 手動修改也存版本；失敗時舊的還在
await page.evaluate(async () => (await import('/src/summarize.js')).writeSummary(1, { summary: '我自己寫的' }));
r = await run('壞掉的回覆 {', 'x');
check('failed redo still has the old versions', r.status === 'fail' && r.history[0].startsWith('我自己寫的|manual') && r.history.some((x) => x.startsWith('A 版')), JSON.stringify(r));

// 最多 5 個
for (let k = 0; k < 6; k++) await run(`{"summary":"第${k}次","ops":[]}`, 'm');
r = await page.evaluate(() => (window.__chat[1].extra.lovers_planner.history ?? []).length);
check('keeps at most 5 versions', r === 5, String(r));

// 大視窗也能換
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="summary"]');
await page.click('[data-action="sum-filter"][data-filter="ok"]');
await page.click('[data-fold-key="floor:d1"] .lp-row-head');
await page.click('[data-fold-key="floor:d1"] [data-role="versions"] > summary');
await page.click('[data-fold-key="floor:d1"] [data-action="sum-restore"][data-k="1"]');
r = await page.evaluate(() => window.__chat[1].extra.lovers_planner.summary);
check('panel can restore too', r === '第3次', r);
await page.screenshot({ path: `${OUT}/versions.png` });

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
