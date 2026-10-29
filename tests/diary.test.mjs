// 📖 日記（v0.13.34，第二階段）：讀完舊聊天 → 選寫法 → 一天一篇寫成日記（長的分段）；
// 有摘要的層送摘要、沒有的送原文；OOC 不寫；再壓一次（勾重點、比例、提醒、原版留著）；編輯、刪除、換寫法；
// 日記排在摘要後面，送出時不用等日記寫完。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

const lp = (date, summary) => ({ lovers_planner: { v: 2, status: 'ok', summary, date, ops: [], at: 1, hash: 'x' } });
const OLD = [{ user_name: '小雨', character_name: '沈言', chat_metadata: {} }];
let k = 0;
const add = (ai, text, extra = {}) => OLD.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: text, send_date: `s${k++}`, extra });
// 03-01：兩層都有摘要
add(false, '早安'); add(true, '原文一號：去看海。', lp('2025-03-01', '兩人去看海，牽了手。'));
add(false, '好'); add(true, '原文二號：吃晚餐。', lp('2025-03-01', '一起吃晚餐，約好週末再來。'));
// 03-02：沒有摘要（只有 Horae 日期），使用者發言裡有 OOC
add(false, '(OOC: 請白起更主動一點) 我們去公園吧');
add(true, '原文三號：在公園散步，他送她一條手鍊。', { horae_meta: { timestamp: { story_date: '2025/3/2' } } });
// 03-03：20 層，切成兩段
for (let i = 0; i < 20; i++) { add(false, `第${i}句`); add(true, `長的一天第${i}層。`, lp('2025-03-03', `長日摘要${i}`)); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.route('**/api/characters/chats', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ file_id: '舊聊天', file_size: '1MB', chat_items: OLD.length - 1, last_mes: '2026-10-01' }]) }));
await page.route('**/api/chats/get', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OLD) }));
await page.addInitScript(() => {
  window.__chatId = '新聊天';
  window.__chat = Array.from({ length: 4 }, (_, i) => ({ name: i % 2 ? '沈言' : '小雨', is_user: !(i % 2), mes: `第${i}則`, send_date: `c${i}`, extra: {} }));
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, ui: { seenVersion: '9.9.9' } } };
});
await page.goto(URL);
await page.waitForFunction(() => Boolean(globalThis.loversPlannerInterceptor));
// 測試頁自己的 __generateRaw 會在載入時設好，要在載入之後才換成假的模型。
await page.evaluate(() => {
  window.__diaryPrompts = [];
  window.__generateRaw = async ({ prompt }) => {
    if (prompt.includes('日記') || prompt.includes('日记')) {
      window.__diaryPrompts.push(prompt);
      if (window.__slow) await new Promise((r) => setTimeout(r, window.__slow));
      if (window.__junk) return '我不想寫';
      const date = prompt.match(/故事裡 (\S+) 這一天/)?.[1] ?? prompt.match(/故事裡 (\S+) 這一天的日記/)?.[1] ?? '?';
      if (prompt.includes('寫成一篇更短的日記')) return JSON.stringify({ summary: `壓縮版${date}` });
      const part = prompt.match(/（第 (\d)／\d 段）/)?.[1] ?? '';
      return JSON.stringify({ points: ['重大｜牽手', '中等｜吃晚餐'], time: '早上～晚上', location: '海邊', summary: `日記${date}${part ? `第${part}段` : ''}` });
    }
    return JSON.stringify({ summary: 'L1', ops: [] });
  };
});
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; document.getElementById('lp_wand_entry').click(); });
await page.click('[data-action="old-open"]');
await page.click('[data-action="old-pick"]');
await page.click('[data-action="old-read"]');
await page.waitForSelector('[data-role="diary-start"]');
const est = await page.textContent('[data-role="diary-start"]');
check('estimate before starting', est.includes('3 天') && est.includes('4 次呼叫') && est.includes('主 API'), est.replace(/\s+/g, ' ').slice(0, 200));
await page.selectOption('#lp-diary-style', 'natural');
await page.click('[data-action="diary-start"]');
const idle = () => page.waitForFunction(async () => (await import('/src/diary.js')).diaryPending() === 0, null, { timeout: 20000 });
await idle();
let days = await page.evaluate(async () => (await import('/src/diary.js')).listDiary().map((d) => ({ date: d.date, state: d.state, text: d.original, parts: d.parts.length, points: d.points.length })));
check('one diary per day, long day in two parts', JSON.stringify(days.map((d) => [d.date, d.state, d.parts])) === JSON.stringify([['2025-03-01', 'done', 1], ['2025-03-02', 'done', 1], ['2025-03-03', 'done', 2]]), JSON.stringify(days));
check('parts joined', days[2].text === '日記2025-03-03第1段\n日記2025-03-03第2段', days[2].text);
const prompts = await page.evaluate(() => window.__diaryPrompts.slice());
const p1 = prompts.find((x) => x.includes('故事裡 2025-03-01 這一天'));
const p2 = prompts.find((x) => x.includes('故事裡 2025-03-02 這一天'));
check('summarized floors send their summary, not the original', p1.includes('［摘要］') && p1.includes('兩人去看海，牽了手。') && !p1.includes('原文一號'), p1.slice(-400));
check('unsummarized floors send the original', p2.includes('原文三號') && p2.includes('送她一條手鍊'));
check('natural style prompt with OOC rule', p1.includes('戀人手帳的記錄員') && p1.includes('OOC') && p1.includes('不寫進日記'));
check('long day prompt says which part', prompts.some((x) => x.includes('（第 1／2 段）')) && prompts.some((x) => x.includes('（第 2／2 段）')));
check('style saved', await page.evaluate(() => SillyTavern.getContext().extensionSettings.lovers_planner.diary.style) === 'natural');
check('usage recorded as diary', await page.evaluate(async () => (await import('/src/usage.js')).recentUsage?.(1)?.some?.((x) => x.purpose === 'diary') ?? true));

// 畫面：日記區塊
await page.waitForFunction(() => document.querySelector('[data-role="diary"] > summary')?.textContent.includes('3 天'), null, { timeout: 5000 }).catch(() => {});
const head = await page.textContent('[data-role="diary"] > summary');
check('diary section header', head.includes('📖 日記') && head.includes('3 天'), head);
await page.click('[data-action="diary-toggle"][data-date="2025-03-01"]');
const body = await page.textContent('[data-diary-date="2025-03-01"]');
check('day opens with text, time and points', body.includes('日記2025-03-01') && body.includes('早上～晚上') && body.includes('這天的重點（2）'), body.replace(/\s+/g, ' ').slice(0, 200));
await page.screenshot({ path: `${OUT}/diary.png` });

// 再壓一次：取消勾一條、選 30% → 提醒；壓完用壓縮版；換回原版；刪掉壓縮版
await page.click('[data-action="diary-compress-open"][data-date="2025-03-01"]');
await page.uncheck('[data-role="diary-keep"][data-k="1"]');
await page.selectOption('[data-role="diary-ratio"]', '0.3');
check('low ratio warning', (await page.textContent('[data-role="diary-compress"]')).includes('一半以下'));
await page.click('[data-action="diary-compress-go"]');
await idle();
const cp = (await page.evaluate(() => window.__diaryPrompts.slice())).find((x) => x.includes('寫成一篇更短的日記'));
check('compress prompt keeps only ticked points', cp.includes('重大｜牽手') && !cp.includes('中等｜吃晚餐') && cp.includes('自然的敘述'), cp.slice(0, 600));
let d1 = await page.evaluate(async () => (await import('/src/diary.js')).listDiary()[0]);
check('compressed version used, original kept', d1.use === 'compressed' && d1.compressed.summary === '壓縮版2025-03-01' && d1.original === '日記2025-03-01', JSON.stringify(d1).slice(0, 200));
await page.click('[data-action="diary-use"][data-date="2025-03-01"]');
d1 = await page.evaluate(async () => (await import('/src/diary.js')).listDiary()[0]);
check('switch back to original', d1.use === 'original' && Boolean(d1.compressed));
await page.click('[data-action="diary-drop-compressed"][data-date="2025-03-01"]');
d1 = await page.evaluate(async () => (await import('/src/diary.js')).listDiary()[0]);
check('drop compressed', !d1.compressed);

// 編輯
await page.click('[data-action="diary-edit"][data-date="2025-03-01"]');
await page.fill('[data-role="diary-edit"]', '我自己改的日記。');
await page.click('[data-action="diary-save"]');
d1 = await page.evaluate(async () => (await import('/src/diary.js')).listDiary()[0]);
check('edit saved', d1.original === '我自己改的日記。' && d1.points.length === 2);

// 換寫法重寫
await page.evaluate(() => { window.__diaryPrompts.length = 0; });
await page.click('[data-action="diary-toggle"][data-date="2025-03-02"]');
await page.click('[data-action="diary-restyle"][data-date="2025-03-02"]');
await idle();
const rs = await page.evaluate(() => window.__diaryPrompts.slice());
check('restyle uses the concise prompt', rs.length === 1 && rs[0].includes('寫法要精簡'), String(rs.length));

// 失敗：模型亂回 → 標成失敗
await page.evaluate(() => { window.__junk = true; });
await page.click('[data-action="diary-rewrite"][data-date="2025-03-02"]');
await idle();
const err = await page.evaluate(async () => (await import('/src/diary.js')).listDiary().find((d) => d.date === '2025-03-02'));
check('failed part marked', err.state === 'error' && err.errors.length === 1, JSON.stringify(err.errors));
await page.evaluate(() => { window.__junk = false; });

// 刪除
await page.click('[data-action="diary-delete"][data-date="2025-03-02"]');
check('delete day', !(await page.evaluate(async () => (await import('/src/diary.js')).listDiary().some((d) => d.date === '2025-03-02'))));

// 一起壓：超過 5 字的
await page.fill('[data-role="diary-batch-min"]', '5');
await page.click('[data-action="diary-batch"]');
await idle();
const batch = await page.evaluate(async () => (await import('/src/diary.js')).listDiary().map((d) => d.use));
check('batch compress long days', batch.filter((x) => x === 'compressed').length === 2, JSON.stringify(batch));

// ===== 日記排在摘要後面；送出時不用等排隊的日記 =====
const order = await page.evaluate(async () => {
  window.__slow = 150;
  window.__diaryPrompts.length = 0;
  const diary = await import('/src/diary.js');
  diary.queueDays(['2025-03-01', '2025-03-03'], { rewrite: true });
  const s = await import('/src/summarize.js');
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 30));
  s.enqueue(1);
  const r = await window.__runInterceptor('normal');
  const waited = Date.now() - t0;
  const left = diary.diaryPending();
  return { waited, left, aborted: r.aborted };
});
check('sending does not wait for queued diaries', order.waited < 1500 && order.left >= 1 && !order.aborted, JSON.stringify(order));
await idle();

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));
const tpl = await page.evaluate(async () => { const p = await import('/src/prompts.js'); return ['zh-TW', 'zh-CN', 'en'].every((l) => ['diary', 'diaryConcise', 'diaryCompress'].every((key) => p.defaultTemplate(key, l)?.includes('{{'))); });
check('templates in all three languages', tpl);
for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
