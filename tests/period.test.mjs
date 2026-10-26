// 生理期推算（選項，預設關）：範圍法（最近 6 次最短～最長）、至少 3 次、排卵期、快來了、晚了、
// 很久沒來（資料不夠時）、很長的間隔也算進去、太不規律不推排卵、月曆和設定。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

// 兩個 AI 樓層：第 1 層是第一天，第 3 層的日期當「今天」（測試裡會改）。
const CHAT = [];
for (let i = 0; i < 4; i++) {
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
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

const setToday = (date) => page.evaluate(async (date) => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  setEntry(1, { v: 2, status: 'ok', time: '', location: '', characters: [], summary: '第一天', ops: [], hash: floorSource(1).hash, at: 1, date: '2025-01-01' });
  setEntry(3, { v: 2, status: 'ok', time: '', location: '', characters: [], summary: '今天', ops: [], hash: floorSource(3).hash, at: 3, date });
}, date);
const settings = (patch) => page.evaluate((patch) => Object.assign(SillyTavern.getContext().extensionSettings.lovers_planner.calendar, patch), patch);
const state = () => page.evaluate(async () => {
  const c = await import('/src/calendar.js');
  const cal = c.buildCalendar();
  return { pred: cal.prediction, status: c.periodStatus(cal), inj: c.calendarInjection(), d0428: c.dayInfo(cal, '2025-04-28'), d0412: c.dayInfo(cal, '2025-04-12'), d0402: c.dayInfo(cal, '2025-04-02') };
});

// 三次完整週期：01-01、01-29（28 天）、02-28（30）、03-30（30），每次 5 天
await setToday('2025-04-10');
await page.evaluate(async () => {
  const { addManualEvent } = await import('/src/calendar.js');
  for (const [s, e] of [['2025-01-01', '2025-01-05'], ['2025-01-29', '2025-02-02'], ['2025-02-28', '2025-03-04'], ['2025-03-30', '2025-04-03']]) {
    addManualEvent({ type: 'period', state: 'start', date: s });
    addManualEvent({ type: 'period', state: 'end', date: e });
  }
});

// ===== 1. 預設關 =====
let s = await state();
check('off by default', s.pred === null && !s.inj.includes('推算') && !s.inj.includes('快來'), JSON.stringify(s.status));
check('no faint marks when off', s.d0428.period === null);

// ===== 2. 範圍 =====
await settings({ predict: true });
s = await state();
check('range from shortest to longest', s.pred?.earliest === '2025-04-27' && s.pred.latest === '2025-04-29' && s.pred.min === 28 && s.pred.max === 30 && s.pred.median === 30 && s.pred.cycles === 3, JSON.stringify(s.pred));
check('predicted days marked', s.d0428.period === 'predicted' && s.d0402.period === 'actual');
check('no ovulation unless asked', s.pred.fertile === null && !s.d0412.fertile);
check('nothing said when far away', !s.inj.includes('生理期'), s.inj);

// ===== 3. 排卵期 =====
await settings({ ovulation: true });
s = await state();
check('fertile window', JSON.stringify(s.pred.fertile) === JSON.stringify({ from: '2025-04-08', to: '2025-04-16' }), JSON.stringify(s.pred.fertile));
check('today fertile → told', s.status.fertile === true && s.inj.includes('今天可能在 小雨 的排卵期附近'), s.inj);

// ===== 4. 快來了、晚了 =====
await setToday('2025-04-25');
s = await state();
check('soon', s.status.soon === true && s.inj.includes('小雨 的生理期可能快來了（推算大約 04-27～04-29'), s.inj);
await setToday('2025-05-05');
s = await state();
check('late', s.status.late === 6 && s.inj.includes('比推算的還晚了 6 天（上次是 36 天前）') && s.inj.includes('關心'), s.inj);

// ===== 5. 很長的間隔也算進去；太不規律不推排卵 =====
await page.evaluate(async () => (await import('/src/calendar.js')).addManualEvent({ type: 'period', state: 'start', date: '2025-08-10' }));
await setToday('2025-08-20');
s = await state();
check('long gap counted (range widens)', s.pred?.min === 28 && s.pred.max === 133 && s.pred.earliest === '2025-09-07' && s.pred.latest === '2025-12-21', JSON.stringify(s.pred));
check('too irregular → no ovulation', s.pred.fertile === null && s.pred.ovulationSkipped === true);

// ===== 6. 資料不夠：很久沒來也會說 =====
const few = await page.evaluate(async () => {
  const c = await import('/src/calendar.js');
  const meta = SillyTavern.getContext().chatMetadata.lovers_planner.calendar;
  meta.manual = meta.manual.filter((x) => x.date < '2025-01-30'); // 只剩 01-01、01-29 兩次
  const cal = c.buildCalendar();
  return { pred: cal.prediction, status: c.periodStatus(cal), inj: c.calendarInjection() };
});
check('needs 3 cycles', few.pred === null);
check('long absence told', few.status.long === true && few.inj.includes('小雨 已經 203 天沒來生理期了'), few.inj);

// ===== 7. 畫面 =====
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="notes"]');
check('status says data needed', (await page.textContent('[data-role="cal-predict"]')).includes('至少 3 次'));
check('long absence shown', (await page.textContent('[data-role="cal-status"]')).includes('已經 203 天沒來了'));
await page.click('[data-tab="settings"]');
await page.click('details[data-sec="calendar"] > summary');
check('settings: predict and ovulation', await page.isChecked('input[data-path="calendar.predict"]') && await page.isChecked('input[data-path="calendar.ovulation"]'));
await page.uncheck('input[data-path="calendar.predict"]');
check('ovulation option hidden when predict off', !(await page.isVisible('input[data-path="calendar.ovulation"]')));
s = await state();
check('off again: no long-absence message', !s.inj.includes('沒來'), s.inj);

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
