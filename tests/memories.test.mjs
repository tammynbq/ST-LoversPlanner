// 回憶錄：模型挑的、小劇場、手動收藏、編輯／刪除、想起過去（機率、冷卻、重新生成一樣、指定下次、太新的不算、quiet 不算）。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

// 60 個 AI 樓層（1,3,…,119）＋最後一句使用者發言（120）。
const CHAT = [];
for (let i = 0; i < 121; i++) {
  const ai = i % 2 === 1;
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i} 的內容`, send_date: `d${i}`, extra: {} });
}
CHAT[1].mes = '沈言替小雨撐傘。<小劇場>番外：兩人在雪地裡打雪仗，小雨把雪球塞進他領口。</小劇場>';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'after' }, recall: { notes: false, memory: false },
    compress: { auto: false }, memories: { enabled: true, auto: true, recall: true, everyN: 1, count: 2, minAge: 20, cooldown: 30 } } };
}, CHAT);
// 和 calendar.test 一樣：有背景摘要時偶爾遇到「Execution context was destroyed」（頁面其實沒有重新整理），重試就好。
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

await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  for (let i = 1; i < 120; i += 2) if (i !== 1 && i !== 5) setEntry(i, { v: 2, status: 'ok', time: '', location: '', characters: [], summary: `第${i}層的事`, ops: [], hash: floorSource(i).hash, at: 1000 + i });
  window.__generateRaw = async ({ prompt }) => {
    window.__lastPrompt = prompt;
    if (prompt.includes('沈言: 沈言替小雨撐傘')) {
      return JSON.stringify({ summary: '沈言替小雨撐傘', ops: [], keepsakes: [{ title: '雪地裡的雪球', content: '小雨把雪球塞進他領口，他笑著抱起她。', from: 'theater' }] });
    }
    return JSON.stringify({ summary: '第5層：告白', ops: [], keepsakes: [{ title: '告白', content: '沈言在海邊說出喜歡。' }, { title: '', content: '' }] });
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

// ===== 1. 提示詞：回憶錄規則、小劇場另外附上 =====
const p1 = await page.evaluate(async () => (await import('/src/summarize.js')).buildL1Prompt(1));
check('prompt asks for keepsakes', p1.prompt.includes('keepsakes：') && p1.prompt.includes('"keepsakes"'));
check('theater shown separately', p1.prompt.includes('【小劇場（番外，不是正劇）】\n番外：兩人在雪地裡打雪仗'), p1.prompt.slice(-400));
check('theater rule in prompt', p1.prompt.includes('不要寫進 summary 和 ops'));
const story = p1.prompt.split('【小劇場')[0];
check('theater not in the story part', story.includes('沈言替小雨撐傘') && !story.includes('打雪仗'));
const p3 = await page.evaluate(async () => (await import('/src/summarize.js')).buildL1Prompt(3));
check('no theater section when there is none', !p3.prompt.includes('【小劇場'));

// ===== 2. 摘要後存下 =====
for (const i of [1, 5]) await page.evaluate(async (i) => (await import('/src/summarize.js')).enqueue(i), i);
await idle();
let mem = await page.evaluate(async () => (await import('/src/memories.js')).listMemories());
check('keepsakes stored (empty one dropped)', mem.length === 2, JSON.stringify(mem));
check('theater flag kept', mem.find((m) => m.title === '雪地裡的雪球')?.theater === true);
check('memories in story order', mem[0].floor === 1 && mem[1].floor === 5);

// ===== 3. 手動收藏（訊息下面的按鈕） =====
await page.evaluate(async () => {
  const { renderAllBlocks } = await import('/src/ui/message.js');
  renderAllBlocks();
  document.querySelector('.mes[mesid="9"] [data-lp-act="toggle"]')?.click();
  document.querySelector('.mes[mesid="9"] [data-lp-act="keep"]')?.click();
});
mem = await page.evaluate(async () => (await import('/src/memories.js')).listMemories());
check('keep button adds a memory', mem.some((m) => m.source === 'manual' && m.floor === 9 && m.content === '第9層的事'), JSON.stringify(mem.map((m) => m.key)));

// ===== 4. 回憶錄分頁：編輯、新增、刪除 =====
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="memories"]');
check('memories tab lists 3', (await page.$$('[data-mem-key]')).length === 3);
const manualKey = mem.find((m) => m.source === 'manual').key;
await page.click(`[data-mem-key="${manualKey}"] .lp-row-head`);
await page.click(`[data-action="mem-edit"][data-key="${manualKey}"]`);
await page.fill('[data-mem="title"]', '第一次牽手');
await page.fill('[data-mem="content"]', '過馬路時他自然地牽起她的手。');
await page.click('[data-action="mem-save"]');
mem = await page.evaluate(async () => (await import('/src/memories.js')).listMemories());
check('edited manual memory', mem.find((m) => m.key === manualKey)?.title === '第一次牽手');
const floorKey = mem.find((m) => m.floor === 5).key;
await page.click(`[data-mem-key="${floorKey}"] .lp-row-head`);
await page.click(`[data-action="mem-edit"][data-key="${floorKey}"]`);
await page.fill('[data-mem="content"]', '沈言在海邊說出喜歡，小雨哭了。');
await page.click('[data-action="mem-save"]');
mem = await page.evaluate(async () => (await import('/src/memories.js')).listMemories());
check('edited model memory (kept as an override)', mem.find((m) => m.key === floorKey)?.content.includes('小雨哭了'));
await page.click('[data-action="mem-add"]');
await page.fill('[data-mem="title"]', '最近的事');
await page.fill('[data-mem="content"]', '這是剛剛手動加的、沒有出處的回憶。');
await page.click('[data-action="mem-save"]');
check('added from the tab', (await page.$$('[data-mem-key]')).length === 4);
await page.screenshot({ path: `${OUT}/memories-tab.png` });

// 太新的不算回憶：把第 115 層收藏起來（只差 2 層）
await page.evaluate(async () => (await import('/src/memories.js')).addMemory({ title: '太新', content: '剛發生的事', floor: 115 }));
await page.keyboard.press('Escape');

// ===== 5. 想起過去 =====
const run = (type = 'normal') => page.evaluate((type) => window.__runInterceptor(type), type);
// 只看【可以自然提起的回憶】那一段（摘要裡也可能有同樣的字）。
const section = (v) => (v ?? '').split('【可以自然提起的回憶】')[1]?.split('\n\n')[0] ?? '';
const titles = (v) => ['雪地裡的雪球', '告白', '第一次牽手', '最近的事'].filter((x) => section(v).includes(`${x}：`));
let r = await run();
const first = r.injection.value;
check('reminders injected', first.includes('【可以自然提起的回憶】'), first);
check('natural, not forced', first.includes('不自然就不用提'));
check('too-recent memory not picked', !section(first).includes('剛發生的事'));
const picked1 = titles(first);
check('1 to 2 memories', picked1.length >= 1 && picked1.length <= 2, picked1.join());
let st = await page.evaluate(async () => (await import('/src/hide.js')).getLastStats());
check('stats count reminders', st.reminders === picked1.length, JSON.stringify(st));
r = await run();
const again = titles(r.injection.value);
check('regenerating picks the same', again.join() === picked1.join(), `${picked1} / ${again}`);
// 下一回（新的使用者發言）：剛提過的在冷卻中
await page.evaluate(() => { window.__chat[120].mes = '新的一句話'; window.__chat[120].send_date = 'd120b'; });
r = await run();
const next = titles(r.injection.value);
check('just-mentioned ones rest', next.every((x) => !picked1.includes(x)), `${picked1} / ${next}`);
// quiet 生成不提
await page.evaluate(() => { window.__chat[120].send_date = 'd120c'; });
r = await run('quiet');
check('quiet generation gets no reminders', !(r.injection?.value ?? '').includes('【可以自然提起的回憶】'));
// 指定下次提起
await page.evaluate(async (k) => (await import('/src/memories.js')).surfaceNext(k), floorKey);
await page.evaluate(() => { window.__chat[120].send_date = 'd120d'; });
r = await run();
check('pinned memory comes up next', section(r.injection.value).includes('小雨哭了'));
check('pin used up', await page.evaluate(async () => (await import('/src/memories.js')).nextPinned()) === null);
// 關掉「讓角色想起」
await page.evaluate(() => { SillyTavern.getContext().extensionSettings.lovers_planner.memories.recall = false; window.__chat[120].send_date = 'd120e'; });
r = await run();
check('no reminders when recall off', !r.injection.value.includes('【可以自然提起的回憶】'));

// ===== 6. 機率：everyN=10 時大約十分之一 =====
const hits = await page.evaluate(async () => {
  const s = SillyTavern.getContext().extensionSettings.lovers_planner.memories;
  s.recall = true; s.everyN = 10; s.cooldown = 0;
  const { pickReminders } = await import('/src/memories.js');
  let n = 0;
  for (let k = 0; k < 400; k++) { window.__chat[120].send_date = `t${k}`; window.__chat[120].mes = `第${k}句`; if (pickReminders('').length) n++; }
  return n;
});
check('about 1 in 10 turns', hits > 20 && hits < 65, String(hits));

// ===== 7. 設定 =====
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="settings"]');
await page.click('details[data-sec="memories"] > summary');
check('memory settings', await page.isVisible('input[data-path="memories.everyN"]') && await page.isVisible('input[data-path="memories.cooldown"]'));
await page.click('details[data-sec="filter"] > summary');
check('theater mode select', (await page.inputValue('#lp-theater')) === 'keepsake');
await page.selectOption('#lp-theater', 'story');
const p1b = await page.evaluate(async () => (await import('/src/summarize.js')).buildL1Prompt(1));
check('theater as story: kept in the story, no separate section', p1b.prompt.includes('打雪仗') && !p1b.prompt.includes('【小劇場（番外'));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const line of results) console.log(line);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
