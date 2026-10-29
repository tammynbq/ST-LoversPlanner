// 📦 舊聊天整理（v0.13.33，日記第一階段）：不打開聊天，直接讀聊天檔；照日期分天、列出每天多大；
// 分支重複的訊息只算一次；Horae 的日期；行事曆（生理期、親熱、紀念日）帶進現在的聊天；
// 帶到新聊天時行事曆也跟著帶（以前沒帶），復原帶入會一起拿掉。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

const lp = (date, extra = {}) => ({ lovers_planner: { v: 2, status: 'ok', summary: `摘要${date}`, date, ops: [], at: 1, hash: 'x', ...extra } });
const msg = (i, ai, text, extra = {}) => ({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: text, send_date: `s${i}`, extra, ...(ai ? {} : {}) });
// 舊聊天 A：兩天（03-01、03-02），一層只有 Horae 的日期（03-03），一層跳過、一層小劇場。
const A = [
  { user_name: '小雨', character_name: '沈言', chat_metadata: { lovers_planner: { calendar: { manual: [{ id: 'ev_m1', type: 'anniversary', date: '12-12', title: '交往紀念日' }], removed: ['s3#1'] } } } },
  msg(0, false, '早安'), msg(1, true, '早安呀，今天去看海。', lp('2025-03-01', { events: [{ type: 'period', state: 'start' }] })),
  msg(2, false, '好'), msg(3, true, '在海邊散步。', lp('2025-03-01', { events: [{ type: 'intimacy', count: 2 }, { type: 'intimacy', count: 1 }] })),
  msg(4, false, '晚安'), msg(5, true, '隔天去吃早餐。', lp('2025-03-02', { events: [{ type: 'anniversary', date: '03-05', title: '小雨的生日' }] })),
  msg(6, false, '然後呢'), msg(7, true, '還沒摘要的一層。', { horae_meta: { timestamp: { story_date: '2025/3/3 (一)' } } }),
  msg(8, false, '番外'), msg(9, true, '番外內容', { lovers_planner: { v: 2, status: 'side', summary: '' } }),
  msg(10, false, 'x'), msg(11, true, '跳過的', { lovers_planner: { v: 2, status: 'skip' } }),
];
// 分支 B：前四則和 A 一樣，之後寫到 03-02（和 A 同一天，可能是 IF 線）。
const B = [
  { user_name: '小雨', character_name: '沈言', chat_metadata: {} },
  ...A.slice(1, 5),
  msg(20, false, '換個方向'), msg(21, true, 'IF 線的 03-02。', lp('2025-03-02')),
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
const asked = [];
await page.route('**/api/characters/chats', async (route) => {
  asked.push(JSON.parse(route.request().postData()));
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
    { file_id: '舊聊天A', file_name: '舊聊天A.jsonl', file_size: '34.47MB', chat_items: 3291, mes: '…', last_mes: '2026-10-01T10:00:00Z' },
    { file_id: '分支B', file_name: '分支B.jsonl', file_size: '2KB', chat_items: 6, mes: '…', last_mes: '2026-10-20T10:00:00Z' },
    { file_id: '現在的聊天', file_name: '現在的聊天.jsonl', file_size: '1KB', chat_items: 4, mes: '…', last_mes: '2026-10-29T10:00:00Z' },
  ]) });
});
await page.route('**/api/chats/get', async (route) => {
  const body = JSON.parse(route.request().postData());
  asked.push(body);
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body.file_name === '舊聊天A' ? A : B) });
});
await page.addInitScript(() => {
  window.__chatId = '現在的聊天';
  window.__chat = Array.from({ length: 4 }, (_, i) => ({ name: i % 2 ? '沈言' : '小雨', is_user: !(i % 2), mes: `第${i}則`, send_date: `c${i}`, extra: {} }));
  window.__chatMetadata = {};
  window.__store = {};
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, ui: { seenVersion: '9.9.9' } } };
});
await page.goto(URL);
await page.waitForFunction(() => Boolean(globalThis.loversPlannerInterceptor));
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; document.getElementById('lp_wand_entry').click(); });
await page.waitForSelector('[data-action="old-open"]');
await page.click('[data-action="old-open"]');
await page.waitForSelector('[data-action="old-pick"]');
const ids = await page.$$eval('[data-action="old-pick"]', (els) => els.map((e) => e.dataset.id));
check('lists other chats of this character, not the current one', JSON.stringify(ids) === JSON.stringify(['分支B', '舊聊天A']) && asked[0].avatar_url === 'shenyan.png', JSON.stringify({ ids, asked: asked[0] }));
check('read disabled until something is picked', await page.isDisabled('[data-action="old-read"]'));
await page.click('[data-action="old-pick"][data-id="舊聊天A"]');
await page.click('[data-action="old-pick"][data-id="分支B"]');
await page.click('[data-action="old-read"]');
await page.waitForSelector('[data-role="old-result"]');
const req = asked.filter((x) => x.file_name);
check('reads the files without opening them (older first)', req.map((x) => x.file_name).join() === '舊聊天A,分支B' && req[0].avatar_url === 'shenyan.png' && req[0].ch_name === '沈言', JSON.stringify(req));
const r = await page.evaluate(async () => {
  // 直接用同樣的資料再算一次，拿到數字
  const { analyzeChats, loadOldChat } = await import('/src/oldchats.js');
  return analyzeChats([{ id: '舊聊天A', data: await loadOldChat('舊聊天A') }, { id: '分支B', data: await loadOldChat('分支B') }]);
});
const day = (d) => r.days.find((x) => x.date === d);
check('grouped by story date', day('2025-03-01')?.ai === 2 && day('2025-03-02')?.ai === 2 && day('2025-03-03')?.ai === 1 && day('2025-03-03')?.summarized === 0, JSON.stringify(r.days.map((d) => [d.date, d.ai, d.summarized])));
check('horae date used', r.totals.horae === 1);
check('branch duplicates counted once', r.totals.duplicates === 2 && r.totals.ai === 7, JSON.stringify(r.totals));
check('skip and side left out of diaries', r.totals.skipped === 1 && r.totals.side === 1 && day('2025-03-03').side === 1, JSON.stringify(r.totals));
check('overlap between chats flagged', JSON.stringify(r.overlaps) === '["2025-03-02"]', JSON.stringify(r.overlaps));
check('calendar found (removed one skipped, manual included)', r.calendar.period === 1 && r.calendar.intimacy === 2 && r.calendar.anniversary === 2, JSON.stringify(r.calendar));
const text = await page.textContent('[data-role="old-result"]');
check('result shows totals and days', text.includes('2 個聊天') && text.includes('7 個 AI 樓層') && text.includes('3 個故事日') && text.includes('2025-03-01（') && text.includes('借用 Horae') && text.includes('重複'), text.slice(0, 200));
await page.screenshot({ path: `${OUT}/oldchats.png` });

// 行事曆帶進來
await page.click('[data-action="old-cal"]');
check('calendar imported', (await page.textContent('[data-role="old-msg"]')).includes('帶進了 4 筆'));
const cal = await page.evaluate(async () => {
  const c = await import('/src/calendar.js');
  const b = c.buildCalendar();
  return { period: b.periods.map((p) => p.start), intimacy: c.dayInfo(b, '2025-03-01').intimacy, ann: b.items.filter((x) => x.type === 'anniversary').map((x) => `${x.date}:${x.title}:${x.source}`) };
});
check('periods, intimacy and anniversaries in this chat', cal.period.join() === '2025-03-01' && cal.intimacy === 2 && cal.ann.includes('12-12:交往紀念日:carried') && cal.ann.includes('03-05:小雨的生日:carried'), JSON.stringify(cal));
await page.click('[data-action="old-cal"]');
check('importing again adds nothing', (await page.textContent('[data-role="old-msg"]')).includes('已經帶過了'));
await page.click('[data-tab="notes"]');
check('anniversary list says it came from another chat', (await page.textContent('[data-role="anniv"]')).includes('從其他聊天帶來'));
// 帶來的可以刪
await page.click('.lp-anniv-item:has-text("小雨的生日") [data-action="anniv-remove"]');
check('carried anniversary can be deleted', !(await page.textContent('[data-role="anniv"]')).includes('小雨的生日'));

// ===== 帶到新聊天：行事曆跟著帶，復原會拿掉 =====
const after = await page.evaluate(async () => {
  const carry = await import('/src/carry.js');
  const { setEntry, floorSource } = await import('/src/chat.js');
  setEntry(1, { v: 2, status: 'ok', summary: '一起吃飯', date: '2025-04-01', ops: [], hash: floorSource(1).hash, at: 5, events: [{ type: 'period', state: 'start' }] });
  carry.writeSnapshot();
  const snap = carry.getSnapshot('現在的聊天');
  // 換到一個新聊天
  window.__store[window.__chatId] = { chat: window.__chat, meta: window.__chatMetadata };
  window.__chatId = '新聊天';
  window.__chat = [{ name: '沈言', is_user: false, mes: '歡迎', send_date: 'n0', extra: {} }];
  window.__chatMetadata = {};
  window.__renderChat();
  await window.__emit('chat_id_changed');
  await new Promise((res) => setTimeout(res, 200));
  const c = await import('/src/calendar.js');
  const got = c.buildCalendar().periods.map((p) => p.start);
  carry.undoCarry();
  const undone = c.buildCalendar().items.length;
  return { snapCal: snap?.calendar?.length ?? 0, got, undone };
});
check('snapshot carries the calendar', after.snapCal >= 4, JSON.stringify(after));
check('new chat gets periods from the old one', after.got.includes('2025-03-01') && after.got.includes('2025-04-01'), JSON.stringify(after.got));
check('undo carry removes them', after.undone === 0, String(after.undone));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));
for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
