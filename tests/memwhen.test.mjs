// 回憶錄的故事時間（v0.13.17，使用者要求）：那一層沒有日期時，往前（再往後）找最近有日期的樓層，標「約」；時間也一樣。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

const entry = (o) => ({ lovers_planner: { v: 2, status: 'ok', summary: 's', ops: [], hash: 'x', at: 1, ...o } });
const CHAT = [];
for (let i = 0; i < 10; i++) {
  const ai = i % 2 === 1;
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${i}`, send_date: `d${i}`, extra: {} });
}
CHAT[1].extra = entry({ date: '2025-03-01', time: '早上' });
CHAT[3].extra = entry({ keepsakes: [{ title: '第一次牽手', content: '在公園牽手。' }] });
CHAT[5].extra = entry({ date: '2025-03-04', time: '晚上', keepsakes: [{ title: '告白', content: '在雨中告白。' }] });
CHAT[7].extra = { lovers_planner: { v: 2, status: 'side', summary: '小劇場', ops: [], keepsakes: [{ title: '古代花燈', content: '一起看花燈。', theater: true }], hash: 'x', at: 1 } };

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

const list = await page.evaluate(async () => (await import('/src/memories.js')).listMemories().map((m) => ({ t: m.title, date: m.date, time: m.time, g: m.dateGuessed })));
const by = Object.fromEntries(list.map((m) => [m.t, m]));
check('own date kept', by['告白']?.date === '2025-03-04' && by['告白'].time === '晚上' && !by['告白'].g, JSON.stringify(by['告白']));
check('no date → nearest earlier, marked guessed', by['第一次牽手']?.date === '2025-03-01' && by['第一次牽手'].time === '早上' && by['第一次牽手'].g, JSON.stringify(by['第一次牽手']));
check('side scene gets nearby date', by['古代花燈']?.date === '2025-03-04' && by['古代花燈'].g, JSON.stringify(by['古代花燈']));
const text = await page.evaluate(async () => {
  const m = await import('/src/memories.js');
  return m.remindersText(m.listMemories().filter((x) => x.title === '告白'));
});
check('injection has date and time', text.includes('2025-03-04 晚上｜告白'), text);

await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="memories"]');
const folded = await page.textContent('[data-mem-key="d3#0"]');
check('folded card shows when', folded.includes('約 2025-03-01（') && folded.includes('早上'), folded.replace(/\s+/g, ' '));
await page.click('[data-mem-key="d3#0"] [data-action="fold"]');
check('open card has story time line', (await page.textContent('[data-mem-key="d3#0"] [data-role="mem-when"]')).includes('故事時間'));
await page.screenshot({ path: `${OUT}/memwhen.png` });

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
