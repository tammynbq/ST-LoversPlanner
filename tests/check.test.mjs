// 🩺 檢查：各種問題、標題列的數字、單項修正、全部修正、合併重複記事、補建入口、請模型抽查。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

// 12 個 AI 樓層（1,3,…,23）。
const CHAT = [];
for (let i = 0; i < 24; i++) {
  const ai = i % 2 === 1;
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i} 的內容`, send_date: `d${i}`, extra: {} });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  // 不自動壓縮，免得檢查結果跟著變。
  window.__presetSettings = { lovers_planner: { settingsVersion: 4, compress: { auto: false, l1PerL2: 50, l2PerL3: 10, ratioMin: 30, ratioMax: 40 } } };
}, CHAT);
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  const ok = (i, extra = {}) => setEntry(i, { v: 2, status: 'ok', time: '第1天', location: '咖啡店', characters: [], summary: `第${i}層發生的事情`, ops: [], hash: floorSource(i).hash, at: 1000 + i, ...extra });
  ok(1, { ops: [
    { op: 'add', id: 'c_a', type: 'character', data: { name: '林曉', relation: '朋友' } },
    { op: 'add', id: 'c_b', type: 'character', data: { name: '林曉（小曉）', likes: '貓' } },
    { op: 'add', id: 'i_zero', type: 'item', data: { name: '靈石', quantity: '0' } },
  ] });
  setEntry(3, { v: 2, status: 'fail', error: '連線逾時', hash: floorSource(3).hash, at: 1003 });
  ok(5, { hash: 'changed' });
  ok(7, { repaired: true });
  ok(9, { summary: '。' });
  ok(11, { summary: '很長的摘要'.repeat(120) });
  ok(13, { summary: '沈言和小雨一起在咖啡店躲雨，聊到深夜才分開。' });
  ok(15, { summary: '沈言和小雨一起在咖啡店躲雨，聊到深夜才分開！' });
  // 17 沒摘要
  ok(19, { time: '' });
  ok(21);
  (await import('/src/notes.js')).invalidateNotes();
  window.__audits = 0;
  window.__generateRaw = async ({ prompt }) => {
    if (prompt.includes('審稿員')) {
      window.__audits++;
      return prompt.includes('很長的摘要')
        ? '{"ok": false, "problems": ["把小雨寫成了林曉"]}'
        : '```json\n{"ok": true, "problems": []}\n```';
    }
    return JSON.stringify({ time: '第2天', location: '家', characters: [], summary: '重做後的摘要', ops: [] });
  };
  await window.__emit('chat_id_changed');
});

const openPanel = async () => {
  await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
  await page.click('#lp_wand_entry');
};
const idle = async () => {
  let quiet = 0;
  for (let k = 0; k < 200 && quiet < 2; k++) {
    await new Promise((r) => setTimeout(r, 100));
    const n = await page.evaluate(async () => (await import('/src/summarize.js')).pendingCount());
    quiet = n === 0 ? quiet + 1 : 0;
  }
};
const kinds = () => page.$$eval('.lp-check-row', (rows) => rows.map((r) => r.dataset.check.split(':')[0]));

// ===== 1. 標題列的數字 =====
await openPanel();
const badge = await page.textContent('[data-role="check-count"]');
check('badge shows issue count', Number(badge) >= 9, badge);

// ===== 2. 清單 =====
await page.click('[data-action="check-toggle"]');
await page.waitForSelector('.lp-checkup');
let k = await kinds();
for (const want of ['none', 'fail', 'stale', 'repaired', 'empty', 'long', 'dup', 'noTime', 'dupNote', 'zeroItem']) {
  check(`finds ${want}`, k.includes(want), k.join());
}
check('no false duplicate for different summaries', (await page.$$('[data-check^="dup:"]')).length === 1);
check('fail shows the error', (await page.textContent('[data-check="fail:3"]')).includes('連線逾時'));
check('summary line', (await page.textContent('[data-role="check-summary"]')).includes('錯誤'));
check('jump buttons for floors', Boolean(await page.$('[data-check="stale:5"] [data-action="check-jump"]')));
await page.screenshot({ path: `${OUT}/check-list.png`, fullPage: true });

// ===== 3. 單項修正：數量 0 的物件、合併重複的人物 =====
await page.click('[data-check^="zeroItem"] [data-action="check-fix"]');
let notes = await page.evaluate(async () => Object.fromEntries([...(await import('/src/notes.js')).getNotes().notes.values()].map((n) => [n.id, { ...n.data, state: n.state }])));
check('zero item marked used up', notes.i_zero.state === 'done');
await page.click('[data-check^="dupNote"] [data-action="check-fix"]');
notes = await page.evaluate(async () => Object.fromEntries([...(await import('/src/notes.js')).getNotes().notes.values()].map((n) => [n.id, { ...n.data, state: n.state }])));
check('duplicate merged', !notes.c_b && notes.c_a.likes === '貓' && notes.c_a.relation === '朋友', JSON.stringify(notes));
k = await kinds();
check('fixed ones gone from the list', !k.includes('zeroItem') && !k.includes('dupNote'), k.join());

// ===== 4. 全部修正 =====
await page.click('[data-action="check-fix-all"]');
check('fix-all message', (await page.textContent('.lp-checkup')).includes('已處理'));
await idle();
await page.click('[data-action="check-refresh"]');
k = await kinds();
check('auto-fixable ones fixed', !['fail', 'stale', 'repaired', 'empty'].some((x) => k.includes(x)), k.join());
check('judgment calls left alone (long, dup)', k.includes('long') && k.includes('dup'), k.join());

// ===== 5. 請模型抽查 =====
await page.fill('[data-role="audit-n"]', '2');
await page.click('[data-action="check-audit"]');
await page.waitForSelector('[data-role="audit-summary"]');
await page.waitForFunction(() => !document.querySelector('[data-role="audit-progress"]'));
check('audited 2 floors', await page.evaluate(() => window.__audits) === 2);
check('audit summary', (await page.textContent('[data-role="audit-summary"]')).includes('已抽查 2 層，1 層沒問題'));
check('suspicious floor audited first and flagged', (await page.textContent('[data-check="audit:11"]')).includes('把小雨寫成了林曉'));
await page.click('[data-action="check-audit"]');
await page.waitForFunction(() => !document.querySelector('[data-role="audit-progress"]'));
check('audited floors not repeated', await page.evaluate(() => window.__audits) === 4);
await page.screenshot({ path: `${OUT}/check-audit.png`, fullPage: true });

// ===== 6. 還沒摘要 → 補建 =====
await page.click('[data-check^="none"] [data-action="check-fix"]');
check('"none" opens the catch-up card', await page.isVisible('[data-role="catchup"]'));
check('checkup closed', !(await page.$('.lp-checkup')));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const line of results) console.log(line);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
