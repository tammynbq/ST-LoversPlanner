// 行事曆：提示詞、日期延續、事件、生理期推算、接下來的事、注入、月曆畫面、手動新增／刪除、關掉。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

// 5 個 AI 樓層（1,3,5,7,9），後面再一句使用者發言（10）。
const CHAT = [];
for (let i = 0; i < 11; i++) {
  const ai = i % 2 === 1;
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i} 的內容`, send_date: `d${i}`, extra: {} });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__presetSettings = { lovers_planner: { settingsVersion: 4, summary: { mode: 'after' }, recall: { notes: false } } };
}, CHAT);
// 偶爾會在背景摘要時遇到「Execution context was destroyed」（頁面其實沒有重新整理），重試一次就好。
const rawEvaluate = page.evaluate.bind(page);
page.evaluate = async (fn, arg) => {
  for (let k = 0; ; k++) {
    try { return await rawEvaluate(fn, arg); } catch (e) {
      if (k >= 3 || !/Execution context was destroyed/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
};
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

await page.evaluate(() => {
  const replies = {
    1: { date: '2025-03-01', events: [{ type: 'anniversary', date: '03-10', title: '小雨的生日' }] },
    3: { date: '2025-03-02', events: [{ type: 'period', state: 'start' }] },
    5: { date: '', events: [{ type: 'intimacy', count: 2 }] },
    7: { date: '2025/3/4', events: [{ type: 'plan', date: '2025-03-08', title: '去看海' }, { type: 'period', state: 'end' }, { type: 'bogus' }] },
    9: { date: '2025-03-05', events: [] },
  };
  window.__generateRaw = async ({ prompt }) => {
    const m = prompt.match(/沈言: AI(\d+)/);
    const r = replies[m?.[1]] ?? { date: '', events: [] };
    return JSON.stringify({ time: '', location: '家', characters: [], summary: `第${m?.[1]}層`, ops: [], ...r });
  };
});
const idle = async () => {
  let quiet = 0;
  for (let k = 0; k < 200 && quiet < 2; k++) {
    await new Promise((r) => setTimeout(r, 100));
    const n = await page.evaluate(async () => (await import('/src/summarize.js')).pendingCount());
    quiet = n === 0 ? quiet + 1 : 0;
  }
};
const openPanel = async (tab) => {
  await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
  await page.click('#lp_wand_entry');
  if (tab) await page.click(`[data-tab="${tab}"]`);
};

// ===== 1. 提示詞 =====
await page.evaluate(async () => (await import('/src/summarize.js')).enqueue(1));
await idle();
const p3 = await page.evaluate(async () => (await import('/src/summarize.js')).buildL1Prompt(3));
check('prompt asks for date', p3.prompt.includes('date：這一層發生在故事裡的哪一天'));
check('prompt has previous date', p3.prompt.includes('日期：2025-03-01'));
check('prompt asks for events', p3.prompt.includes('events：') && p3.prompt.includes('生理期') && p3.prompt.includes('親熱') && p3.prompt.includes('紀念日'));
check('format has date and events', p3.prompt.includes('"date": "YYYY-MM-DD"') && p3.prompt.includes('"type": "intimacy"'));
const p1 = await page.evaluate(async () => (await import('/src/summarize.js')).buildL1Prompt(1));
check('first floor gets a start date', /從 \d{4}-\d{2}-\d{2} 開始算/.test(p1.prompt));

// ===== 2. 摘要後的資料 =====
for (const i of [3, 5, 7, 9]) await page.evaluate(async (i) => (await import('/src/summarize.js')).enqueue(i), i);
await idle();
const entries = await page.evaluate(() => window.__chat.map((m) => m.extra?.lovers_planner ?? null));
check('dates stored', entries[1].date === '2025-03-01' && entries[3].date === '2025-03-02');
check('missing date carried from previous floor', entries[5].date === '2025-03-02', entries[5].date);
check('date normalized', entries[7].date === '2025-03-04', entries[7].date);
check('unknown event types dropped', entries[7].events.length === 2, JSON.stringify(entries[7].events));
let cal = await page.evaluate(async () => {
  const c = await import('/src/calendar.js');
  const cal = c.buildCalendar();
  return { today: cal.today, periods: cal.periods, next: cal.next, cycle: cal.cycle, status: c.periodStatus(cal), up: c.upcoming(cal) };
});
check('today is latest dated floor', cal.today === '2025-03-05');
check('period from start to end', JSON.stringify(cal.periods) === JSON.stringify([{ start: '2025-03-02', end: '2025-03-04', assumed: false }]), JSON.stringify(cal.periods));
check('next period predicted with default cycle', cal.next === '2025-03-30' && cal.cycle === 28);
check('period status: until', cal.status.kind === 'until' && cal.status.days === 25, JSON.stringify(cal.status));
check('upcoming within 7 days', cal.up.map((x) => `${x.date}:${x.kind}:${x.in}`).join() === '2025-03-08:plan:3,2025-03-10:anniversary:5', JSON.stringify(cal.up));

// ===== 3. 注入 =====
let r = await page.evaluate(() => window.__runInterceptor('normal'));
const inj = r.injection?.value ?? '';
check('injection has calendar', inj.includes('【行事曆】\n今天是 2025-03-05'), inj);
check('injection lists upcoming', inj.includes('03-08（3 天後）去看海') && inj.includes('03-10（5 天後）小雨的生日'), inj);
check('far-away period not mentioned', !inj.includes('生理期'));

// ===== 4. 摘要區塊 =====
const block = await page.evaluate(async () => {
  const { renderAllBlocks } = await import('/src/ui/message.js');
  renderAllBlocks();
  document.querySelector('.mes[mesid="7"] [data-lp-act="toggle"]')?.click();
  return document.querySelector('.mes[mesid="7"] .lp-sum')?.textContent ?? '';
});
check('block shows date and events', block.includes('2025-03-04') && block.includes('03-08 去看海') && block.includes('生理期結束'), block);

// ===== 5. 月曆畫面 =====
await openPanel('calendar');
check('calendar tab shows March', (await page.textContent('[data-role="cal-title"]')).includes('3'));
check('status shows today', (await page.textContent('[data-role="cal-status"]')).includes('2025-03-05'));
check('today highlighted', Boolean(await page.$('[data-date="2025-03-05"].lp-cal-today')));
check('period days marked', Boolean(await page.$('[data-date="2025-03-03"].lp-cal-period')) && !(await page.$('[data-date="2025-03-05"].lp-cal-period')));
check('plan marked', (await page.textContent('[data-date="2025-03-08"]')).includes('📌'));
check('anniversary marked', (await page.textContent('[data-date="2025-03-10"]')).includes('🎂'));
check('intimacy marked with count', (await page.textContent('[data-date="2025-03-02"]')).includes('💕2'));
check('predicted period faint', Boolean(await page.$('[data-date="2025-03-30"] .lp-cal-pred')));
await page.screenshot({ path: `${OUT}/calendar.png`, fullPage: true });

// 手動新增：今天親熱 1 次
await page.click('[data-date="2025-03-05"]');
await page.selectOption('[data-role="cal-type"]', 'intimacy');
await page.click('[data-action="cal-add"]');
check('manual event shown', (await page.textContent('[data-role="cal-day"]')).includes('親熱 1 次'));
r = await page.evaluate(() => window.__runInterceptor('normal'));
check('today intimacy injected', r.injection.value.includes('今天已經親熱過 1 次'));

// 刪掉摘要記下的行程，再恢復
await page.click('[data-date="2025-03-08"]');
await page.click('[data-role="cal-day"] [data-action="cal-remove"]');
check('floor event removed', !(await page.textContent('[data-date="2025-03-08"]')).includes('📌'));
check('restore offered', await page.isVisible('[data-action="cal-restore"]'));
await page.click('[data-action="cal-restore"]');
check('restored', (await page.textContent('[data-date="2025-03-08"]')).includes('📌'));

// 第二次生理期：週期改用實際的
await page.click('[data-date="2025-03-28"]');
await page.selectOption('[data-role="cal-type"]', 'period');
await page.click('[data-action="cal-add"]');
cal = await page.evaluate(async () => { const c = await import('/src/calendar.js'); const x = c.buildCalendar(); return { cycle: x.cycle, next: x.next }; });
check('cycle from actual data', cal.cycle === 26 && cal.next === '2025-04-23', JSON.stringify(cal));
await page.click('[data-action="cal-month"][data-delta="1"]');
check('next month', (await page.textContent('[data-role="cal-title"]')).includes('4'));
check('assumed period runs into April', Boolean(await page.$('[data-date="2025-04-01"].lp-cal-period')));
await page.screenshot({ path: `${OUT}/calendar-april.png`, fullPage: true });

// ===== 6. 編輯器有日期 =====
const hasDate = await page.evaluate(() => {
  document.querySelector('.mes[mesid="9"] [data-lp-act="toggle"]')?.click();
  document.querySelector('.mes[mesid="9"] [data-lp-act="edit"]')?.click();
  return document.querySelector('.mes[mesid="9"] input[data-field="date"]')?.value;
});
check('editor has date field', hasDate === '2025-03-05', String(hasDate));

// ===== 7. 關掉 =====
await page.click('[data-tab="settings"]');
await page.click('details[data-sec="calendar"] > summary');
await page.uncheck('input[data-path="calendar.enabled"]');
check('tab hidden when off', !(await page.$('[data-tab="calendar"]')));
r = await page.evaluate(() => window.__runInterceptor('normal'));
check('not injected when off', !r.injection.value.includes('行事曆'));
const off = await page.evaluate(async () => (await import('/src/summarize.js')).buildL1Prompt(9));
check('prompt has no date when off', !off.prompt.includes('YYYY-MM-DD') && !off.prompt.includes('events'));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const line of results) console.log(line);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
