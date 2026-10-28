// 亂點測試（不是一般測試）：每個分頁、🩺、🔍 的每個按鈕都點一次，抓 JavaScript 錯誤和畫面上的 undefined／NaN／沒替換的 {佔位符}。
// PORT=8815 LOC=zh-tw|zh-cn|en node tests/monkey.mjs
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));
const LOCALE = process.env.LOC ?? 'zh-tw';
const CHAT = [];
for (let i = 0; i < 30; i++) { const ai = i % 2 === 1; CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i} 今天也在一起。<status>時間：晚上</status>`, send_date: `d${i}`, extra: {} }); }
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 390, height: 844 } });
const errors = []; const odd = new Map();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + ' @' + (e.stack ?? '').split('\n')[1]));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g|net::ERR/.test(m.text())) errors.push('console: ' + m.text().slice(0, 200)); });
page.on('dialog', (d) => d.dismiss());
await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
await page.addInitScript(({ chat, loc }) => {
  window.__chat = chat; window.__locale = loc;
  window.__characters = [{ name: '沈言', avatar: 'shenyan.png', description: '沈言，醫生。', data: { extensions: { world: 'W' } } }];
  window.__powerUser = { persona_description: '小雨，插畫家。' };
  window.__worlds = { W: { entries: { 1: { key: ['林曉'], comment: '林曉', content: '林曉，護理師。' } } } };
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, compress: { auto: false, l1PerL2: 2 }, calendar: { enabled: true, track: { period: true, intimacy: true, anniversary: true } } } };
}, { chat: CHAT, loc: LOCALE });
await page.goto(`http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`);
await page.waitForFunction(() => Boolean(globalThis.loversPlannerInterceptor));
await page.evaluate(async () => {
  window.__generateRaw = async ({ prompt }) => {
    if (prompt.includes('角色卡和使用者人設')) return JSON.stringify({ char: { name: '沈言', identity: '醫生' }, user: { name: '小雨', identity: '插畫家' } });
    if (prompt.includes('世界書（設定集）')) return JSON.stringify({ characters: [{ entry: 'W::1', name: '林曉', identity: '護理師' }] });
    if (prompt.includes('太長的欄位')) return JSON.stringify({ fields: { status: '感冒' }, memories: [] });
    if (prompt.includes('"ok"')) return JSON.stringify({ ok: true, problems: [] });
    if (prompt.includes('短標題')) return '{}';
    return JSON.stringify({ time: '晚上', location: '家', characters: ['沈言'], summary: '兩人吃晚餐。', date: '2025-03-02', events: [{ type: 'intimacy', count: 1 }], keepsakes: [{ title: '晚餐', content: '一起吃晚餐。' }],
      ops: [{ op: 'add', type: 'character', data: { name: '沈言', status: '很累，今天加班到很晚，回家後還一直想著工作上的事情，小雨幫他按摩肩膀，兩人聊了很久的天，最後一起睡著了。' } }, { op: 'add', type: 'promise', data: { title: '看海', content: '週末一起去看海', due: '2025-03-08' } }, { op: 'add', type: 'item', data: { name: '戒指', quantity: '0' } }] });
  };
  const s = await import('/src/summarize.js');
  for (let i = 1; i < 26; i += 2) s.enqueue(i);
  const t0 = Date.now(); while (s.pendingCount() && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 50));
  s.skipFloor(7); s.sideFloor(9);
  (await import('/src/memories.js')).addMemory({ title: '手動', content: '手動新增的回憶。' });
  document.getElementById('extensionsMenu').style.display = '';
});
const open = async () => { if (!(await page.$('.lp-panel'))) await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; document.getElementById('lp_wand_entry').click(); }); };
await open();
const SKIP = new Set(['close', 'data-wipe', 'usage-clear', 'tab', 'check-toggle', 'global-toggle']);
const scan = async (where) => {
  const t = await page.evaluate(() => document.querySelector('.lp-panel')?.innerText ?? '');
  for (const re of [/undefined/, /NaN/, /\[object Object\]/, /\{[a-z][a-zA-Z]*\}/]) { const m = t.match(re); if (m) { const k = `${m[0]} @ ${where}`; if (!odd.has(k)) odd.set(k, t.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')); } }
};
const tabs = await page.$$eval('[data-action="tab"]', (els) => els.map((e) => e.dataset.tab));
const closeViews = async () => { for (const a of ['check-toggle', 'global-toggle']) { const on = await page.$(`.lp-panel [data-action="${a}"][aria-pressed="true"]`); if (on) await on.click(); } };
let clicks = 0;
for (const tab of tabs) {
  await open(); await closeViews(); await page.click(`[data-tab="${tab}"]`); await page.waitForTimeout(100);
  // 設定頁：展開所有區塊
  if (tab === 'settings') await page.$$eval('details', (ds) => ds.forEach((d) => { d.open = true; }));
  await scan(tab);
  const n = await page.$$eval(".lp-panel [data-action]", (els) => els.length);
  const vis = await page.$$eval(".lp-panel [data-action]", (els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length);
  console.log("tab", tab, "buttons", n, "visible", vis);
  const seen = new Set();
  for (let i = 0; i < Math.min(n, 200); i++) {
    await open(); await closeViews();
    if (!(await page.$(`[data-tab="${tab}"].lp-on`))) { await page.click(`[data-tab="${tab}"]`).catch(() => {}); }
    const info = await page.$$eval('.lp-panel [data-action]', (els, i) => { const e = els[i]; if (!e) return null; const r = e.getBoundingClientRect(); return { a: e.dataset.action, vis: r.width > 0 && r.height > 0 && !e.disabled, key: e.dataset.action + '|' + (e.dataset.id ?? e.dataset.index ?? e.dataset.tab ?? e.dataset.filter ?? e.dataset.key ?? '') }; }, i);
    if (!info || !info.vis || SKIP.has(info.a) || seen.has(info.key)) continue;
    seen.add(info.key);
    await page.$$eval('.lp-panel [data-action]', (els, i) => els[i]?.click(), i).catch((e) => errors.push('click ' + info.key + ': ' + e.message));
    clicks++;
    await page.waitForTimeout(60);
    await scan(`${tab} after ${info.key}`);
  }
}
for (const view of ['check-toggle', 'global-toggle']) {
  await open(); await closeViews();
  await page.click(`.lp-panel [data-action="${view}"]`);
  await page.waitForTimeout(150);
  if (view === 'global-toggle') { await page.fill('[data-search="global"]', '晚餐'); await page.waitForTimeout(300); }
  await scan(view);
  const n = await page.$$eval('.lp-panel [data-action]', (els) => els.length);
  console.log('view', view, 'buttons', n);
  const seen = new Set();
  for (let i = 0; i < Math.min(n, 120); i++) {
    await open();
    if (!(await page.$(`.lp-panel [data-action="${view}"][aria-pressed="true"]`))) await page.click(`.lp-panel [data-action="${view}"]`).catch(() => {});
    const info = await page.$$eval('.lp-panel [data-action]', (els, i) => { const e = els[i]; if (!e) return null; const r = e.getBoundingClientRect(); return { a: e.dataset.action, vis: r.width > 0 && r.height > 0 && !e.disabled, key: e.dataset.action + '|' + (e.dataset.id ?? e.dataset.index ?? e.dataset.key ?? '') }; }, i);
    if (!info || !info.vis || SKIP.has(info.a) || seen.has(info.key) || info.a === 'check-audit') continue;
    seen.add(info.key);
    await page.$$eval('.lp-panel [data-action]', (els, i) => els[i]?.click(), i).catch((e) => errors.push('click ' + info.key + ': ' + e.message));
    clicks++;
    await page.waitForTimeout(80);
    await scan(`${view} after ${info.key}`);
  }
}
await closeViews();
// 等背景工作做完再掃一次
await page.waitForTimeout(1500);
for (const tab of tabs) { await open(); await closeViews(); await page.click(`[data-tab="${tab}"]`).catch(() => {}); await scan(tab + ' (final)'); }
console.log(`clicks: ${clicks}`);
console.log('ERRORS:', errors.length ? '\n' + [...new Set(errors)].join('\n') : 'none');
console.log('ODD TEXT:', odd.size ? '\n' + [...odd].map(([k, v]) => `${k} :: ${v}`).join('\n') : 'none');
await b.close();
