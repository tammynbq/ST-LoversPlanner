// 行程併進約定（v0.13.18）：打開聊天時把以前的行程轉成約定一次；已經有同一天、差不多的約定不重複；轉過的行程從行事曆拿掉。
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
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${i}`, send_date: `d${i}`, extra: {} });
}
const entry = (o) => ({ lovers_planner: { v: 2, status: 'ok', summary: 's', ops: [], hash: 'x', at: 1, ...o } });
CHAT[1].extra = entry({ date: '2025-03-01', events: [{ type: 'plan', date: '2025-03-08', title: '去看海' }] });
// 第 3 層同時記了約定（同一天、差不多的內容）和行程 → 行程不重複轉
CHAT[3].extra = entry({ date: '2025-03-02', events: [{ type: 'plan', date: '2025-03-09', title: '吃火鍋' }],
  ops: [{ op: 'add', id: 'p_hot', type: 'promise', data: { title: '吃火鍋', content: '週日一起去吃火鍋', due: '2025-03-09' } }] });
CHAT[5].extra = entry({ date: '2025-03-03', events: [{ type: 'plan', title: '大掃除' }, { type: 'anniversary', date: '03-20', title: '交往紀念日' }] });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, recall: { notes: false, memory: false }, compress: { auto: false }, calendar: { enabled: true, track: { plan: true, period: true, intimacy: true, anniversary: true } } } };
}, CHAT);
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

// 載入時已經轉過一次；換成「有手動行程、還沒轉過」的狀態再轉一次（harness 的 chatMetadata 不能預先放東西）。
await page.evaluate(async () => {
  const meta = SillyTavern.getContext().chatMetadata;
  for (const k of Object.keys(meta)) delete meta[k];
  meta.lovers_planner = { calendar: { manual: [{ type: 'plan', date: '2025-03-15', title: '看電影', id: 'ev_1' }, { type: 'intimacy', date: '2025-03-02', count: 1, id: 'ev_2' }], removed: [] } };
  (await import('/src/notes.js')).invalidateNotes();
  window.__merged = (await import('/src/planmerge.js')).mergePlans();
});
const promises = () => page.evaluate(async () => [...(await import('/src/notes.js')).getNotes().notes.values()]
  .filter((n) => n.type === 'promise').map((n) => ({ title: n.data.title, due: n.data.due, floor: n.createdFloor })));
let list = await promises();
check('merged on load', list.length === 4, JSON.stringify(list));
check('floor plan → promise with due and source floor', list.some((x) => x.title === '去看海' && x.due === '2025-03-08' && x.floor === 1), JSON.stringify(list));
check('same-day promise not duplicated', list.filter((x) => x.due === '2025-03-09').length === 1);
check('plan without date uses floor date', list.some((x) => x.title === '大掃除' && x.due === '2025-03-03'));
check('manual plan converted', list.some((x) => x.title === '看電影' && x.due === '2025-03-15'));
const cal = await page.evaluate(async () => {
  const c = await import('/src/calendar.js');
  const b = c.buildCalendar();
  return { plans: b.items.filter((x) => x.type === 'plan').length, others: b.items.map((x) => x.type), manual: SillyTavern.getContext().chatMetadata.lovers_planner.calendar.manual.map((x) => x.type) };
});
check('plans gone from calendar, others kept', cal.plans === 0 && cal.others.includes('anniversary') && cal.others.includes('intimacy') && !cal.manual.includes('plan'), JSON.stringify(cal));
check('flag set', await page.evaluate(() => SillyTavern.getContext().chatMetadata.lovers_planner.plansMerged === true));

// 再跑一次不會重複
const again = await page.evaluate(async () => (await import('/src/planmerge.js')).mergePlans());
check('runs once', again === 0 && (await promises()).length === 4);

// 月曆和提醒
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="notes"]');
check('promise shown on its day', (await page.textContent('[data-date="2025-03-08"]')).includes('🤝'));
const sett = await page.evaluate(async () => (await import('/src/ui/panel.js')) && document.body.innerHTML.includes('calendar.track.plan'));
check('no plan toggle in settings', !sett);
await page.screenshot({ path: `${OUT}/planmerge.png` });

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
