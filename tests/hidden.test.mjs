// 使用者自己隱藏的樓層（/hide、眼睛按鈕、其他隱藏插件）：照樣算樓層、摘要照樣送、舊摘要不會變過期、
// 酒館真正的系統訊息不算樓層、保留最新 2 層只算沒隱藏的、隱藏的不跳「照送原文」提醒。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

// 20 個 AI 樓層（1,3,…,39），前面各有一句使用者發言；最後再加一則酒館的旁白（系統訊息）。
const CHAT = [];
for (let i = 0; i < 40; i++) {
  const ai = i % 2 === 1;
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i} 的內容`, send_date: `d${i}`, extra: {} });
}
CHAT.push({ name: '旁白', is_user: false, is_system: true, mes: '（夜深了）', send_date: 'd40', extra: { type: 'narrator' } });

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

// 全部摘要好（這時候還沒隱藏），然後使用者隱藏第 4～5 層和最新的第 38～39 層；第 11 層摘要失敗後也隱藏。
await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  for (let i = 1; i < 40; i += 2) setEntry(i, { v: 2, status: 'ok', time: '', location: '', characters: [], summary: `第${i}層的事`, ops: [], hash: floorSource(i).hash, at: 1000 + i });
  setEntry(11, { v: 2, status: 'fail', error: 'x' });
  for (const i of [4, 5, 10, 11, 38, 39]) window.__chat[i].is_system = true;
  // 舊版在「第 8 句已經被隱藏」時摘要的第 9 層：hash 沒有第 8 句。
  window.__chat[8].is_system = true;
  const { hashText } = await import('/src/chat.js');
  setEntry(9, { v: 2, status: 'ok', time: '', location: '', characters: [], summary: '第9層的事', ops: [], hash: hashText(window.__chat[9].mes), at: 1009 });
  const { renderAllBlocks } = await import('/src/ui/message.js');
  renderAllBlocks();
});

const info = await page.evaluate(async () => {
  const { aiIndices, floorStatus } = await import('/src/chat.js');
  return { ai: aiIndices(), s5: floorStatus(5), s9: floorStatus(9), s39: floorStatus(39) };
});
check('hidden AI floors still count', info.ai.includes(5) && info.ai.includes(39) && info.ai.length === 20, JSON.stringify(info.ai));
check('narrator system message is not a floor', !info.ai.includes(40));
check('summary made before hiding stays ok', info.s5 === 'ok' && info.s39 === 'ok', JSON.stringify(info));
check('summary made by the old version stays ok', info.s9 === 'ok', info.s9);

check('block shown under a hidden floor', await page.evaluate(() => Boolean(document.querySelector('.mes[mesid="5"] .lp-sum'))));

const r = await page.evaluate(() => window.__runInterceptor('normal'));
const inj = r.injection?.value ?? '';
check('hidden floor summary injected', inj.includes('第5層的事'), inj);
check('hidden latest floor summary injected', inj.includes('第39層的事'), inj);
check('keep window counts visible floors only', r.kept.includes('d37') && r.kept.includes('d35') && !r.kept.includes('d33'), r.kept.join());
check('kept floors not summarized twice', !inj.includes('第37層的事') && !inj.includes('第35層的事'));
check('narrator not touched', r.kept.includes('d40') === false && r.aborted === false);

const attention = await page.evaluate(async () => (await import('/src/hide.js')).computeHidden().attention);
check('hidden failed floor needs no popup', !attention.includes(11), JSON.stringify(attention));

const stats = await page.evaluate(async () => (await import('/src/hide.js')).getLastStats());
check('stats reason ok', stats.reason === null, JSON.stringify(stats));

for (const line of results) console.log(line);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
