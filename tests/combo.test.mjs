// 組合情境（v0.13.27 全面檢查）：最近加的功能搭在一起時會不會出事。
// 摘要途中換聊天、⭐ 小劇場排隊時換聊天、刪掉有回憶的樓層、人設欄位手動改過、刪掉人設人物再填、
// 摘要區塊套主題、空聊天轉行程、備份來回（人設欄位、帶來的回憶、小劇場）。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = [];
for (let i = 0; i < 12; i++) {
  const ai = i % 2 === 1;
  A.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i} 今天也在一起`, send_date: `a${i}`, extra: {} });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g/.test(m.text())) errors.push('console: ' + m.text()); });
await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__chatId = '聊天A';
  window.__chatMetadata = {};
  window.__store = {};
  window.__characters = [{ name: '沈言', avatar: 'shenyan.png', description: '沈言，28 歲，外科醫生。' }];
  window.__powerUser = { persona_description: '小雨，插畫家。' };
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, compress: { auto: false }, recall: { notes: false, memory: false } } };
}, A);
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

const switchTo = (id, messages = null) => page.evaluate(async ({ id, messages }) => {
  window.__store[window.__chatId] = { chat: window.__chat, meta: window.__chatMetadata };
  const saved = window.__store[id];
  window.__chatId = id;
  window.__chat = saved?.chat ?? messages;
  window.__chatMetadata = saved?.meta ?? {};
  window.__renderChat();
  await window.__emit('chat_id_changed');
}, { id, messages });
const idle = () => page.evaluate(async () => {
  const { pendingCount } = await import('/src/summarize.js');
  const t0 = Date.now();
  while (pendingCount() && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 50));
});
const greeting = (id) => [{ name: '沈言', is_user: false, mes: '歡迎光臨', send_date: `${id}0`, extra: {} }];

// 慢慢回的模型
await page.evaluate(() => {
  window.__slow = 250;
  window.__generateRaw = async ({ prompt }) => {
    await new Promise((r) => setTimeout(r, window.__slow));
    if (prompt.includes('角色卡和使用者人設')) return JSON.stringify({ char: { name: '沈言', identity: '外科醫生', age: '28' }, user: { name: '小雨', identity: '插畫家' } });
    if (prompt.includes('小劇場（番外')) return JSON.stringify({ summary: '小劇場', keepsakes: [{ title: '花燈', content: '一起看花燈。' }], ops: [] });
    const m = prompt.match(/AI(\d+) 今天/);
    return JSON.stringify({ summary: `摘要${m?.[1]}`, ops: [], keepsakes: m?.[1] === '5' ? [{ title: '牽手', content: '第一次牽手。' }] : [] });
  };
});

// ===== 1. 摘要途中換聊天：不會寫到別的聊天，剩下排隊的不會在新聊天裡跑 =====
await page.evaluate(async () => { const s = await import('/src/summarize.js'); s.enqueue(1); s.enqueue(3); s.enqueue(5); });
await sleep(80);
await switchTo('聊天B', greeting('b'));
await sleep(900);
const inB = await page.evaluate(() => window.__chat.map((m) => m.extra?.lovers_planner?.summary ?? null));
check('switching mid-summary writes nothing into the other chat', inB.every((x) => x === null), JSON.stringify(inB));
await switchTo('聊天A');
await idle();
const inA = await page.evaluate(() => [1, 3, 5].map((i) => window.__chat[i].extra?.lovers_planner?.summary ?? null));
check('old queue dropped, no half-written floors', inA.every((x) => x === null || /^摘要/.test(x)), JSON.stringify(inA));

// 正常摘要好
await page.evaluate(async () => { window.__slow = 0; const s = await import('/src/summarize.js'); for (const i of [1, 3, 5, 7, 9]) s.enqueue(i); });
await idle();

// ===== 2. ⭐ 排隊中換聊天：回來時還是小劇場（原文照樣不送），可以重新讀 =====
await page.evaluate(async () => { window.__slow = 400; (await import('/src/summarize.js')).sideFloor(7); });
await sleep(50);
await switchTo('聊天C', greeting('c'));
await sleep(600);
await switchTo('聊天A');
await idle();
let e7 = await page.evaluate(() => window.__chat[7].extra.lovers_planner);
check('side survives a chat switch', e7.status === 'side', JSON.stringify(e7));
let r = await page.evaluate(() => window.__runInterceptor('normal'));
check('side floor raw not sent', !r.kept.includes('a7'), JSON.stringify(r.kept));
const pend = await page.evaluate(async () => {
  const { hintFor } = await import('/src/ui/message.js');
  const issues = (await import('/src/check.js')).runChecks().filter((x) => x.kind === 'sideUnread').map((x) => x.floor);
  return { hint: hintFor(7, 'side'), issues };
});
check('unread side shows a hint and a checkup item', pend.hint.includes('還沒讀') && pend.issues.includes(7), JSON.stringify(pend));
await page.evaluate(async () => { window.__slow = 0; (await import('/src/summarize.js')).sideFloor(7); });
await idle();
e7 = await page.evaluate(() => window.__chat[7].extra.lovers_planner);
check('checkup item gone after reading', !(await page.evaluate(async () => (await import('/src/check.js')).runChecks().some((x) => x.kind === 'sideUnread'))));
check('side re-read fills it in', e7.status === 'side' && e7.summary === '小劇場' && e7.keepsakes?.length === 1, JSON.stringify(e7));

// ===== 3. 刪掉有回憶的樓層 =====
let mems = await page.evaluate(async () => (await import('/src/memories.js')).listMemories().map((m) => m.title));
check('memories before delete', mems.includes('牽手') && mems.includes('花燈'), JSON.stringify(mems));
await page.evaluate(async () => { window.__chat.splice(4, 2); await window.__emit('message_deleted', 4); });
mems = await page.evaluate(async () => (await import('/src/memories.js')).listMemories().map((m) => m.title));
check('deleted floor memory gone, others stay', !mems.includes('牽手') && mems.includes('花燈'), JSON.stringify(mems));
r = await page.evaluate(() => window.__runInterceptor('normal'));
check('interceptor fine after delete', Array.isArray(r.kept) && !r.aborted);

// ===== 4. 人設欄位手動改過：變成一般欄位，照常送 =====
await page.evaluate(async () => (await import('/src/cardfill.js')).fillFromCard());
const lead = () => page.evaluate(async () => {
  const { getNotes, leadRoles } = await import('/src/notes.js');
  const id = [...leadRoles()].find(([, x]) => x === 'char')?.[0];
  const n = id ? getNotes().notes.get(id) : null;
  return n ? { id: n.id, data: n.data, card: n.cardFields ?? [] } : null;
});
let c = await lead();
await page.evaluate(async (c) => { const { updateNoteManual } = await import('/src/notes.js'); updateNoteManual(c.id, { ...c.data, identity: '心臟外科醫生' }); }, c);
c = await lead();
check('manual edit removes card flag', c.data.identity === '心臟外科醫生' && !c.card.includes('identity') && c.card.includes('age'), JSON.stringify(c));
r = await page.evaluate(() => window.__runInterceptor('normal'));
check('edited field injected, card field not', r.injection.value.includes('心臟外科醫生') && !/年齡：28/.test(r.injection.value), r.injection.value.slice(0, 300));

// ===== 5. 刪掉人設人物再填一次：重新新增 =====
await page.evaluate(async (id) => (await import('/src/notes.js')).deleteNoteManual(id), c.id);
check('deleted', !(await lead()));
await page.evaluate(async () => (await import('/src/cardfill.js')).fillFromCard());
c = await lead();
check('refill after delete re-adds the lead', c && c.data.identity === '外科醫生' && c.card.includes('identity'), JSON.stringify(c));

// ===== 6. 摘要區塊套主題 =====
await page.evaluate(async () => {
  const s = SillyTavern.getContext().extensionSettings.lovers_planner;
  s.ui.theme = 'day-blossom'; s.ui.themeBlocks = true;
  (await import('/src/theme.js')).applyTheme();
  (await import('/src/ui/message.js')).renderAllBlocks();
});
const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.mes[mesid="1"] .lp-sum')).backgroundImage);
check('summary block themed', bg.includes('gradient'), bg.slice(0, 80));
await page.screenshot({ path: `${OUT}/combo-blocks.png` });

// ===== 7. 空的新聊天：轉行程不出錯 =====
await switchTo('聊天D', greeting('d'));
check('empty chat merge flag set', await page.evaluate(() => window.__chatMetadata.lovers_planner?.plansMerged === true));
await switchTo('聊天A');

// ===== 8. 備份來回：人設欄位、小劇場、回憶都還在 =====
const before = await page.evaluate(async () => ({
  mems: (await import('/src/memories.js')).listMemories().length,
  side: window.__chat.filter((m) => m.extra?.lovers_planner?.status === 'side').length,
}));
const res = await page.evaluate(async () => {
  const b = await import('/src/backup.js');
  const data = b.buildBackup({ settings: false });
  const copy = JSON.parse(JSON.stringify(data));
  b.wipeChat();
  return b.importBackup(copy, { mode: 'replace', settings: false });
});
const after = await page.evaluate(async () => ({
  mems: (await import('/src/memories.js')).listMemories().length,
  side: window.__chat.filter((m) => m.extra?.lovers_planner?.status === 'side').length,
}));
c = await lead();
check('backup round trip keeps memories, side floors, card fields', after.mems === before.mems && after.side === before.side && c?.card.includes('identity'), JSON.stringify({ before, after, res, card: c?.card }));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
