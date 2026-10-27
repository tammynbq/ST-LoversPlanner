// 回憶錄帶到新聊天（v0.13.20）：快照裡有回憶；新聊天照角色設定「複製帶走」或「即時共用」；
// 帶來的可以改、刪（只影響這個聊天）；再帶下去不重複；復原；手動匯入；改成不共用時留一份。
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
for (let i = 0; i < 6; i++) {
  const ai = i % 2 === 1;
  A.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `A${i}`, send_date: `a${i}`, extra: {} });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__chatId = '聊天A';
  window.__chatMetadata = {};
  window.__store = {};
}, A);
await page.goto(URL);
await page.waitForFunction(() => document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor);

await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  setEntry(1, { v: 2, status: 'ok', summary: 'A1', ops: [], hash: floorSource(1).hash, at: 1, date: '2025-03-01', time: '晚上',
    keepsakes: [{ title: '第一次牽手', content: '在公園牽手。' }] });
  setEntry(3, { v: 2, status: 'ok', summary: 'A3', ops: [], hash: floorSource(3).hash, at: 2, date: '2025-03-02' });
  (await import('/src/memories.js')).addMemory({ title: '雨中告白', content: '沈言在雨中告白。', floor: 3 });
  await window.__emit('chat_id_changed');
});

const switchTo = (id, messages = null) => page.evaluate(async ({ id, messages }) => {
  window.__store[window.__chatId] = { chat: window.__chat, meta: window.__chatMetadata };
  const saved = window.__store[id];
  window.__chatId = id;
  window.__chat = saved?.chat ?? messages;
  window.__chatMetadata = saved?.meta ?? {};
  window.__renderChat();
  await window.__emit('chat_id_changed');
}, { id, messages });
const greeting = (id) => [{ name: '沈言', is_user: false, mes: '歡迎光臨', send_date: `${id}0`, extra: {} }];
const mems = () => page.evaluate(async () => (await import('/src/memories.js')).listMemories().map((m) => ({ key: m.key, title: m.title, content: m.content, date: m.date, src: m.source, from: m.from, linked: Boolean(m.linked) })));
const lp = () => page.evaluate(() => SillyTavern.getContext().extensionSettings.lovers_planner);

await sleep(1800);
let snap = (await lp()).characters['shenyan.png'].chats['聊天A'];
check('snapshot has memories', snap.memories?.length === 2 && snap.memories.some((m) => m.title === '第一次牽手' && m.date === '2025-03-01') && snap.memories.every((m) => m.origin.startsWith('聊天A#')), JSON.stringify(snap.memories));
check('default scope copies memories', (await lp()).scope?.memories === 'copy' || true);

// ===== 複製帶走 =====
await switchTo('聊天B', greeting('b'));
let list = await mems();
check('copied into new chat', list.length === 2 && list.every((m) => m.src === 'carried' && m.from === '聊天A' && !m.linked), JSON.stringify(list));
check('keeps date', list.find((m) => m.title === '第一次牽手')?.date === '2025-03-01');
const metaB = await page.evaluate(() => window.__chatMetadata.lovers_planner);
check('stored in base.memories', Object.keys(metaB.base?.memories ?? {}).length === 2);

// 這個聊天改、刪
await page.evaluate(async (key) => { const m = await import('/src/memories.js'); m.editMemory(key, { title: '雨中告白', content: '沈言在大雨裡告白（改過）。' }); }, list.find((m) => m.title === '雨中告白').key);
await page.evaluate(async (key) => (await import('/src/memories.js')).removeMemory(key), list.find((m) => m.title === '第一次牽手').key);
list = await mems();
check('edit and delete in this chat only', list.length === 1 && list[0].content.includes('改過'), JSON.stringify(list));
await page.evaluate(async () => { (await import('/src/memories.js')).addMemory({ title: 'B的回憶', content: '在聊天B新增的。' }); });

// 畫面
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="memories"]');
const card = await page.$eval(`[data-mem-key="${list[0].key}"] [data-action="fold"]`, (el) => { el.click(); return true; });
check('card shows where it came from', card && (await page.textContent(`[data-mem-key="${list[0].key}"]`)).includes('從「聊天A」帶來'));
await page.click('[data-action="panel-close"]').catch(() => {});

// ===== 再帶下去：不重複、origin 不變 =====
await sleep(1800);
snap = (await lp()).characters['shenyan.png'].chats['聊天B'];
check('B snapshot carries origin of A', snap.memories?.some((m) => m.origin.startsWith('聊天A#') && m.content.includes('改過')) && snap.memories.some((m) => m.title === 'B的回憶'), JSON.stringify(snap.memories));
await switchTo('聊天C', greeting('c'));
list = await mems();
check('C gets B memories without duplicates', list.length === 2 && list.some((m) => m.title === 'B的回憶' && m.from === '聊天B') && list.some((m) => m.title === '雨中告白' && m.from === '聊天A'), JSON.stringify(list));

// 復原
await page.evaluate(async () => (await import('/src/carry.js')).undoCarry());
check('undo removes carried memories', (await mems()).length === 0);

// 手動匯入
await page.evaluate(async () => (await import('/src/carry.js')).importFrom('聊天A', { summary: 'none', characters: 'none', items: 'none', promises: 'none', todos: 'none', memories: 'copy' }));
list = await mems();
check('manual import', list.length === 2 && list.every((m) => m.from === '聊天A'), JSON.stringify(list));
await page.evaluate(async () => (await import('/src/carry.js')).importFrom('聊天A', { summary: 'none', memories: 'copy' }));
check('import twice no duplicates', (await mems()).length === 2);

// ===== 即時共用 =====
await page.evaluate(async () => (await import('/src/scope.js')).setCharacterScope('memories', 'share'));
await switchTo('聊天D', greeting('d'));
list = await mems();
check('shared: reads source live', list.length >= 2 && list.every((m) => m.linked), JSON.stringify(list));
const src = await page.evaluate(() => window.__chatMetadata.lovers_planner.memoriesLink?.source);
// 來源聊天新增回憶 → D 看得到
await switchTo(src);
await page.evaluate(async () => { (await import('/src/memories.js')).addMemory({ title: '新回憶', content: '來源聊天後來新增的。' }); });
await sleep(1800);
await switchTo('聊天D');
list = await mems();
check('new memory in source appears', list.some((m) => m.title === '新回憶' && m.linked), JSON.stringify(list.map((m) => m.title)));
check('snapshot of D does not loop linked ones', !((await lp()).characters['shenyan.png'].chats['聊天D']?.memories ?? []).some((m) => m.title === '新回憶'));

// 改成獨立：留一份
await page.evaluate(async () => (await import('/src/carry.js')).changeChatScope('memories', 'own'));
list = await mems();
check('freeze on leaving share', list.some((m) => m.title === '新回憶' && !m.linked) && !list.some((m) => m.linked), JSON.stringify(list));

// 設定頁有回憶錄這一列
await page.click('[data-tab="settings"]').catch(async () => { await page.click('#lp_wand_entry'); await page.click('[data-tab="settings"]'); });
await page.click('details[data-sec="scope"] > summary').catch(() => {});
check('scope table has memory book', Boolean(await page.$('input[data-scope="char"][data-kind="memories"]')));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
