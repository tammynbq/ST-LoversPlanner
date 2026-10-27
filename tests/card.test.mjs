// v0.13.16：📇 從人設填寫（人設欄位不送給角色、故事改了才算故事的、重新填寫不蓋掉）、
// 🩺 人物欄位太長→請模型整理（回憶錄沒有的搬過去、已有的刪掉）、摘要分頁「未壓縮」排序和跳過樓層收進章、隱藏 👻。
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
for (let i = 0; i < 12; i++) {
  const ai = i % 2 === 1;
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i} 今天也在一起`, send_date: `d${i}`, extra: {} });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__characters = [{ name: '沈言', avatar: 'shenyan.png', description: '沈言，28 歲，外科醫生。黑髮、戴眼鏡。性格冷靜，喜歡咖啡。', personality: '外冷內熱' }];
  window.__powerUser = { persona_description: '小雨，24 歲，插畫家，沈言的青梅竹馬。' };
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, recall: { notes: false, memory: false }, compress: { auto: false } } };
}, CHAT);
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

const idle = () => page.evaluate(async () => {
  const { pendingCount } = await import('/src/summarize.js');
  const t0 = Date.now();
  while (pendingCount() && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 50));
});
const lead = (role) => page.evaluate(async (role) => {
  const { getNotes, leadRoles } = await import('/src/notes.js');
  const id = [...leadRoles()].find(([, r]) => r === role)?.[0];
  const n = id ? getNotes().notes.get(id) : null;
  return n ? { id: n.id, data: n.data, card: n.cardFields ?? [] } : null;
}, role);

// ===== 1. 從人設填寫 =====
await page.evaluate(() => {
  window.__generateRaw = async ({ prompt }) => {
    if (prompt.includes('角色卡和使用者人設')) {
      return JSON.stringify({
        char: { name: '沈言', age: '28', identity: '外科醫生', appearance: '黑髮、戴眼鏡', personality: '冷靜、外冷內熱', likes: '咖啡', status: '不該出現' },
        user: { name: '小雨', age: '24', identity: '插畫家', relChar: '青梅竹馬' },
      });
    }
    if (prompt.includes('太長的欄位')) {
      return JSON.stringify({
        fields: { status: '感冒中、在家休息', note: '對貓過敏' },
        memories: [{ title: '第一次約會', content: '兩人在海邊第一次約會。' }, { title: '雨中告白', content: '沈言在雨中告白。' }],
      });
    }
    const m = prompt.match(/AI(\d+) 今天/);
    const n = m ? Number(m[1]) : 0;
    // 第 3 層：故事裡把外貌改了（剪了短髮）
    const ops = n === 3 ? [{ op: 'update', id: window.__charId, data: { appearance: '短髮、戴眼鏡' } }] : [];
    return JSON.stringify({ summary: `正劇${n}`, ops });
  };
});
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="characters"]');
await page.click('[data-action="note-card-fill"]');
await page.waitForFunction(() => document.querySelector('[data-role="card-msg"]')?.textContent.includes('從人設填好了'), null, { timeout: 10000 });
check('done message', (await page.textContent('[data-role="card-msg"]')).includes('新增 2 個'));
let char = await lead('char');
let user = await lead('user');
check('char filled from card', char?.data.identity === '外科醫生' && char.data.likes === '咖啡' && !char.data.status && char.card.includes('appearance'), JSON.stringify(char));
check('user filled from persona', user?.data.identity === '插畫家' && user.data.relChar === '青梅竹馬', JSON.stringify(user));
const cardPrompt = await page.evaluate(() => window.__prompts.at(-1).prompt);
check('prompt has card and persona', cardPrompt.includes('外科醫生。黑髮') && cardPrompt.includes('小雨，24 歲') && cardPrompt.includes('外冷內熱') && !cardPrompt.includes('status：'), cardPrompt.slice(0, 200));
check('logged as card', await page.evaluate(async () => (await import('/src/usage.js')).recentUsage(1)[0]?.purpose === 'card'));

// 卡片上標「人設」
await page.evaluate((id) => document.querySelector(`[data-fold-key="note:${id}"] [data-action="fold"]`)?.click(), char.id);
const cardText = await page.textContent(`[data-fold-key="note:${char.id}"]`);
check('card tag shown', cardText.includes('人設') && cardText.includes('外科醫生'), cardText.replace(/\s+/g, ' ').slice(0, 200));
await page.screenshot({ path: `${OUT}/card.png` });

// 送給角色時不送人設欄位；摘要時給模型看
let r = await page.evaluate(() => window.__runInterceptor('normal'));
check('card fields not injected', !r.injection.value.includes('外科醫生') && !r.injection.value.includes('咖啡'), r.injection.value.slice(0, 300));
const l1 = await page.evaluate(async () => (await (await import('/src/summarize.js')).buildL1Prompt(3)).prompt);
check('summary model sees card fields', l1.includes('外科醫生') && l1.includes('咖啡'));

// 故事改了外貌 → 變成故事的，照常送
await page.evaluate((id) => { window.__charId = id; }, char.id);
await page.evaluate(async () => { const s = await import('/src/summarize.js'); s.enqueue(1); s.enqueue(3); s.enqueue(5); s.enqueue(7); });
await idle();
char = await lead('char');
check('story change wins', char.data.appearance === '短髮、戴眼鏡' && !char.card.includes('appearance') && char.card.includes('identity'), JSON.stringify(char));
r = await page.evaluate(() => window.__runInterceptor('normal'));
check('story-changed field injected', r.injection.value.includes('短髮、戴眼鏡') && !r.injection.value.includes('外科醫生'), r.injection.value.slice(0, 300));

// 重新填寫：不蓋掉故事改過的
await page.evaluate(() => { window.__characters[0].description = '沈言，29 歲，心臟外科主任。長髮。'; });
await page.evaluate(() => {
  const old = window.__generateRaw;
  window.__generateRaw = async (o) => (o.prompt.includes('角色卡和使用者人設')
    ? JSON.stringify({ char: { identity: '心臟外科主任', appearance: '長髮', age: '29' }, user: {} })
    : old(o));
});
await page.evaluate(async () => (await import('/src/cardfill.js')).fillFromCard());
char = await lead('char');
check('refill updates card fields only', char.data.identity === '心臟外科主任' && char.data.age === '29' && char.data.appearance === '短髮、戴眼鏡', JSON.stringify(char.data));

// 沒有人設
await page.evaluate(() => { window.__characters[0].description = ''; window.__characters[0].personality = ''; window.__powerUser.persona_description = ''; });
const err = await page.evaluate(async () => { try { await (await import('/src/cardfill.js')).fillFromCard(); return ''; } catch (e) { return (await import('/src/errors.js')).errorText(e); } });
check('no card → clear error', err.includes('找不到角色卡'), err);

// ===== 2. 欄位太長 → 整理 =====
await page.evaluate(async (id) => {
  const { getNotes, updateNoteManual } = await import('/src/notes.js');
  const n = getNotes().notes.get(id);
  updateNoteManual(id, { ...n.data, status: '今天早上起床後覺得喉嚨痛，量了體溫有點發燒，於是請假在家休息，小雨一直在旁邊照顧他、煮粥給他喝，兩人還聊了很多小時候的事情。', note: '兩人第一次約會是在海邊，那天下著小雨；後來在雨中告白，小雨哭著答應了，之後每年都會去那片海邊。' });
  const { addMemory } = await import('/src/memories.js');
  addMemory({ title: '第一次約會', content: '兩人在海邊第一次約會。' });
}, char.id);
const issues = await page.evaluate(async () => (await import('/src/check.js')).runChecks().filter((x) => x.kind === 'longField'));
check('long fields flagged', issues.length === 1 && issues[0].fields.includes('當前狀態') && issues[0].fields.includes('備註') && !issues[0].autoFix, JSON.stringify(issues));
await page.click('[data-action="check-toggle"]');
check('check row with tidy button', (await page.textContent('[data-check^="longField"]')).includes('請模型整理'));
await page.click('[data-check^="longField"] [data-action="check-fix"]');
await page.waitForFunction(async () => !(await import('/src/check.js')).runChecks().some((x) => x.kind === 'longField'), null, { timeout: 10000 });
char = await lead('char');
check('fields shortened', char.data.status === '感冒中、在家休息' && char.data.note === '對貓過敏', JSON.stringify(char.data));
const mems = await page.evaluate(async () => (await import('/src/memories.js')).listMemories().map((m) => m.title));
check('new memory moved, existing one not duplicated', mems.filter((x) => x === '第一次約會').length === 1 && mems.includes('雨中告白'), JSON.stringify(mems));
const tidyPrompt = await page.evaluate(() => window.__prompts.at(-1).prompt);
check('tidy prompt lists memories', tidyPrompt.includes('第一次約會') && tidyPrompt.includes('喉嚨痛'));
await page.click('[data-action="check-toggle"]');

// ===== 3. 摘要分頁 =====
// 1、3 壓成一章；5 跳過（夾在章之間）；7 壓成一章；9 跳過（最後面）；11 未摘要
await page.evaluate(async () => {
  const s = await import('/src/summarize.js');
  s.enqueue(9);
});
await idle();
await page.evaluate(async () => {
  const s = await import('/src/summarize.js');
  const c = await import('/src/compress.js');
  s.skipFloor(5);
  c.compressSelected([1, 3]);
});
await idle();
await page.evaluate(async () => {
  (await import('/src/compress.js')).compressSelected([7, 9]);
});
await idle();
await page.evaluate(async () => (await import('/src/summarize.js')).skipFloor(9));
const st = await page.evaluate(async () => (await import('/src/chat.js')).floorStatus(9));
await page.click('[data-tab="summary"]');
const order = await page.evaluate(() => [...document.querySelectorAll('.lp-floor-list > .lp-group .lp-group-title, .lp-floor-list > .lp-group [data-action="group-fold"]')].map((x) => x.textContent.trim()));
const heads = await page.evaluate(() => [...document.querySelectorAll('.lp-floor-list > .lp-group')].map((g) => g.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)));
check('newest first: loose group on top', heads[0].includes('未壓縮'), JSON.stringify(heads));
check('loose range only new floors', heads[0].includes('#11'), JSON.stringify(heads));
check('skipped floor 5 not in loose', !heads[0].includes('#5'), JSON.stringify(heads) + st + order.length);
// 打開第 1 章：裡面有跳過的 #5
await page.evaluate(() => { const g = [...document.querySelectorAll('.lp-floor-list > .lp-group')].find((x) => x.textContent.includes('第 1 章')); g?.querySelector('button')?.click(); });
const ch1 = await page.evaluate(() => [...document.querySelectorAll('.lp-floor-list > .lp-group')].find((x) => x.textContent.includes('第 1 章'))?.textContent ?? '');
check('skipped floor shown inside its chapter', ch1.includes('#5') && ch1.includes('👻'), ch1.replace(/\s+/g, ' ').slice(0, 300));
await page.click('[data-action="sum-hide-skip"]');
const ch1b = await page.evaluate(() => [...document.querySelectorAll('.lp-floor-list > .lp-group')].find((x) => x.textContent.includes('第 1 章'))?.textContent ?? '');
check('hide 👻 hides it', !ch1b.includes('#5') && (await page.textContent('[data-action="sum-hide-skip"]')).includes('顯示 👻'), ch1b.replace(/\s+/g, ' ').slice(0, 200));
check('hide setting remembered', await page.evaluate(() => SillyTavern.getContext().extensionSettings.lovers_planner.ui?.hideSkip === true));
await page.click('[data-filter="skip"]');
check('skip filter still lists them', (await page.textContent('.lp-floor-list')).includes('#5'));
await page.screenshot({ path: `${OUT}/card-tree.png` });

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
