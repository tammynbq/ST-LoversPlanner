// 約定／待辦的日期：推算（今天、明天、下週三、10月21日…）、約定於哪天、模型給的 due、手動新增、
// 提示詞（開行事曆才要 due）、送給角色的文字、畫面上的日期標籤和排序。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

// 6 個 AI 樓層（1,3,…,11），故事日期從 2026-10-19 到 2026-10-24。
const CHAT = [];
for (let i = 0; i < 12; i++) {
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

// ===== 1. 推算（2026-10-21 是星期三） =====
const g = await page.evaluate(async () => {
  const { guessDate } = await import('/src/notedates.js');
  const m = '2026-10-21';
  const cases = {
    '今天禁欲一天': '2026-10-21', '明天早上離開營地': '2026-10-22', '後天': '2026-10-23', '大后天': '2026-10-24',
    '下周三晚上下班': '2026-10-28', '周六去北山看银杏': '2026-10-24', '這週三': '2026-10-21', '下個星期日': '2026-11-01',
    '三天后': '2026-10-24', '10月25日': '2026-10-25', '10月1號': '2027-10-01', '2026年12月25日': '2026-12-25',
    '明年秋天银杏黄的时候': '', '年后过完生日': '', 'tomorrow night': '2026-10-22', 'next Friday': '2026-10-30', '': '',
  };
  return Object.entries(cases).map(([text, want]) => ({ text, want, got: guessDate(text, m) })).filter((x) => x.got !== x.want);
});
check('relative dates worked out', !g.length, JSON.stringify(g));
check('no made date → nothing guessed', await page.evaluate(async () => (await import('/src/notedates.js')).guessDate('明天', '') === ''));

// ===== 2. 記事：約定於哪天、推算、模型給的 due =====
await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  const days = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'];
  const ops = {
    1: [{ op: 'add', id: 'p_a', type: 'promise', data: { content: '去小红书收藏的牛肉面店', with: '米米', when: '下周三晚上' } }],
    5: [{ op: 'add', id: 'p_b', type: 'promise', data: { content: '明天早上回程路上打包两碗牛肉面' } },
        { op: 'add', id: 'p_c', type: 'promise', data: { content: '明年秋天办婚礼', when: '明年秋天' } }],
    7: [{ op: 'add', id: 't_a', type: 'todo', data: { content: '订温泉', when: '週末', due: '2026/10/25' } }],
  };
  [1, 3, 5, 7, 9, 11].forEach((i, k) => setEntry(i, { v: 2, status: 'ok', time: '', location: '', characters: [], summary: `第${i}層`, ops: ops[i] ?? [], hash: floorSource(i).hash, at: 1000 + i, date: days[k] }));
  const { invalidateNotes } = await import('/src/notes.js');
  invalidateNotes();
});
const dates = await page.evaluate(async () => {
  const { getNotes } = await import('/src/notes.js');
  const { noteDates } = await import('/src/notedates.js');
  const out = {};
  for (const n of getNotes().notes.values()) out[n.id] = noteDates(n);
  return out;
});
check('made = date of the floor that added it', dates.p_a.made === '2026-10-19' && dates.p_b.made === '2026-10-21', JSON.stringify(dates));
check('due guessed from when', dates.p_a.due === '2026-10-28' && dates.p_a.guessed && dates.p_a.from === 'when');
check('due guessed from content', dates.p_b.due === '2026-10-22' && dates.p_b.from === 'content');
check('no specific day → no due', dates.p_c.due === '' && !dates.p_c.guessed);
check('model due kept (normalized)', dates.t_a.due === '2026-10-25' && !dates.t_a.guessed);

const line = await page.evaluate(async () => {
  const { getNotes, noteLine } = await import('/src/notes.js');
  return noteLine(getNotes().notes.get('p_a'));
});
check('sent text has planned and made dates', line.includes('預定日期：2026-10-28') && line.includes('約定於：2026-10-19'), line);

// 手動新增：約定於＝目前最新的故事日期
await page.evaluate(async () => (await import('/src/notes.js')).addNoteManual('promise', { content: '一起看极光', due: '2026-12-31' }));
const manual = await page.evaluate(async () => {
  const { getNotes } = await import('/src/notes.js');
  const { noteDates } = await import('/src/notedates.js');
  const n = [...getNotes().notes.values()].find((x) => x.data.content === '一起看极光');
  return noteDates(n);
});
check('manual note made on latest story date', manual.made === '2026-10-24' && manual.due === '2026-12-31', JSON.stringify(manual));

// ===== 3. 提示詞 =====
const prompt = await page.evaluate(async () => (await (await import('/src/summarize.js')).buildL1Prompt(11)).prompt);
check('prompt asks for due when calendar on', prompt.includes('due 是預定哪一天') && prompt.includes('"due": "YYYY-MM-DD"'));
const promptOff = await page.evaluate(async () => {
  SillyTavern.getContext().extensionSettings.lovers_planner.calendar.enabled = false;
  const p = (await (await import('/src/summarize.js')).buildL1Prompt(11)).prompt;
  SillyTavern.getContext().extensionSettings.lovers_planner.calendar.enabled = true;
  return p;
});
check('no due without calendar', !promptOff.includes('due') , promptOff.slice(0, 200));

// ===== 4. 畫面：日期標籤、點開的日期、排序 =====
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="notes"]');
const order = () => page.$$eval('.lp-note-card .lp-note-title', (els) => els.map((e) => e.textContent.trim()));
let titles = await order();
// 今天是 2026-10-24：p_b（10-22，過了）→ t_a（10-25）→ p_a（10-28）→ 極光（12-31）→ 沒日期的 p_c
check('sorted by planned date', titles.indexOf('明天早上回程路上打包两碗牛肉面') < titles.indexOf('去小红书收藏的牛肉面店')
  && titles.indexOf('去小红书收藏的牛肉面店') < titles.indexOf('一起看极光') && titles.indexOf('一起看极光') < titles.indexOf('明年秋天办婚礼'), titles.join(' / '));
const tagB = await page.textContent('.lp-note-card:has-text("打包两碗") .lp-due-tag');
check('overdue tag', tagB.includes('10-22') && tagB.includes('已過 2 天') && await page.isVisible('.lp-note-card:has-text("打包两碗") .lp-due-tag.lp-st-fail'), tagB);
const tagA = await page.textContent('.lp-note-card:has-text("小红书") .lp-due-tag');
check('upcoming tag', tagA.includes('10-28') && tagA.includes('4 天後'), tagA);
await page.click('.lp-note-card:has-text("小红书") .lp-row-head');
const opened = await page.textContent('.lp-note-card:has-text("小红书") .lp-note-dates');
check('opened card shows made / planned / how', opened.includes('約定於') && opened.includes('2026-10-19') && opened.includes('2026-10-28') && opened.includes('從「下周三晚上」推算'), opened);
await page.selectOption('[data-role="note-sort"]', 'newest');
titles = await order();
check('sort by date made, newest first', titles.indexOf('一起看极光') < titles.indexOf('明天早上回程路上打包两碗牛肉面') && titles.indexOf('明天早上回程路上打包两碗牛肉面') < titles.indexOf('去小红书收藏的牛肉面店'), titles.join(' / '));
await page.selectOption('[data-role="note-sort"]', 'oldest');
titles = await order();
check('sort by date made, oldest first', titles.indexOf('去小红书收藏的牛肉面店') < titles.indexOf('明天早上回程路上打包两碗牛肉面'), titles.join(' / '));
await page.screenshot({ path: `${OUT}/notedates.png` });

// 編輯：預定日期是日期輸入框
await page.click('[data-action="note-edit"]');
check('due field is a date input', await page.getAttribute('[data-note-field="due"]', 'type') === 'date');
await page.click('[data-action="note-cancel"]');

// ===== 5. 和行事曆合在一起：月曆在上面、點日期看那天的約定／待辦、快到期篩選 =====
check('calendar on top of the same tab', await page.evaluate(() => {
  const cal = document.querySelector('.lp-calendar');
  const sec = document.querySelector('.lp-note-section');
  return Boolean(cal && sec && (cal.compareDocumentPosition(sec) & Node.DOCUMENT_POSITION_FOLLOWING));
}));
check('no separate calendar tab', !(await page.$('[data-tab="calendar"]')));
check('due marks on the grid', (await page.textContent('[data-date="2026-10-28"]')).includes('🤝') && (await page.textContent('[data-date="2026-10-25"]')).includes('📝'));
await page.click('[data-date="2026-10-28"]');
check('day shows planned promises', (await page.textContent('[data-role="cal-day-due"]')).includes('小红书'));
await page.click('[data-date="2026-10-21"]');
const made = await page.textContent('[data-role="cal-day-made"]');
check('day shows what was promised that day', made.includes('打包两碗') && made.includes('明年秋天'), made);
await page.click('[data-role="cal-day-made"] [data-action="cal-note"]:has-text("明年秋天")');
check('tap opens the card below', await page.isVisible('[data-fold-key="note:p_c"] [data-action="note-edit"]'));
const visible = () => page.$$eval('.lp-note-section .lp-note-title', (els) => els.map((e) => e.textContent.trim()));
await page.click('[data-action="note-filter"][data-filter="soon"]');
let v = await visible();
check('soon filter', v.length === 2 && v.includes('去小红书收藏的牛肉面店') && v.includes('订温泉'), v.join(' / '));
check('soon chip counts', (await page.textContent('[data-action="note-filter"][data-filter="soon"]')).includes('7 天內到期 2'));
await page.click('[data-action="note-filter"][data-filter="late"]');
v = await visible();
check('overdue filter', v.length === 1 && v[0] === '明天早上回程路上打包两碗牛肉面', v.join(' / '));
await page.click('[data-action="note-filter"][data-filter="nodate"]');
v = await visible();
check('no-date filter', v.length === 1 && v[0] === '明年秋天办婚礼', v.join(' / '));
await page.screenshot({ path: `${OUT}/planner.png`, fullPage: true });
await page.click('[data-action="note-filter"][data-filter="all"]');
await page.click('[data-action="fold-sec"][data-key="sec:calendar"]');
check('calendar folds', !(await page.$('.lp-cal-grid')) && await page.isVisible('[data-role="calendar"] .lp-sec-toggle'));
await page.click('[data-action="fold-sec"][data-key="sec:calendar"]');
check('calendar unfolds', await page.isVisible('.lp-cal-grid'));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
