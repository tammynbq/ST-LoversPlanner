// 第 7 步：帶走／即時共用／前情提要／從其他聊天匯入。
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

// 聊天 A：6 則（3 個 AI 樓層），已摘要、有記事。
const A = [];
for (let i = 0; i < 6; i++) {
  const ai = i % 2 === 1;
  A.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i}`, send_date: `a${i}`, extra: {} });
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
  // 這裡只測帶走／共用，記事全部都送（「只送相關的」在 recall.test.mjs 測）。
  SillyTavern.getContext().extensionSettings.lovers_planner.recall.notes = false;
  window.__generateRaw = async ({ prompt }) => (prompt.includes('前情提要濃縮成') ? '濃縮後的前情提要' : JSON.stringify({ summary: '打招呼', ops: [] }));
  const { floorSource, setEntry } = await import('/src/chat.js');
  for (const i of [1, 3, 5]) setEntry(i, { v: 2, status: 'ok', time: `第${i}天`, location: '咖啡店', characters: [], summary: `A的第${i}層`, ops: [], hash: floorSource(i).hash, at: 1000 + i });
  window.__chat[1].extra.lovers_planner.ops = [
    { op: 'add', id: 'c_lin', type: 'character', data: { name: '林曉', relation: '朋友' } },
    { op: 'add', id: 'i_qin', type: 'item', data: { name: '古琴', holder: '沈言' } },
    { op: 'add', id: 'p_sea', type: 'promise', data: { content: '一起去看海', with: '林曉' } },
    { op: 'add', id: 't_flower', type: 'todo', data: { content: '買花' } },
  ];
  (await import('/src/notes.js')).invalidateNotes();
  await window.__emit('chat_id_changed');
});

/** 切換聊天：記住目前聊天的訊息和 metadata，換成另一個（沒有就用 messages 新建）。 */
const switchTo = (id, messages = null) => page.evaluate(async ({ id, messages }) => {
  window.__store[window.__chatId] = { chat: window.__chat, meta: window.__chatMetadata };
  const saved = window.__store[id];
  window.__chatId = id;
  window.__chat = saved?.chat ?? messages;
  window.__chatMetadata = saved?.meta ?? {};
  window.__renderChat();
  await window.__emit('chat_id_changed');
}, { id, messages });
const openPanel = async () => {
  await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
  await page.click('#lp_wand_entry');
};
const greeting = (id) => [{ name: '沈言', is_user: false, mes: '歡迎光臨', send_date: `${id}0`, extra: {} }];
const notes = () => page.evaluate(async () => {
  const { getNotes } = await import('/src/notes.js');
  return Object.fromEntries([...getNotes().notes.values()].map((n) => [n.id, { ...n.data, state: n.state }]));
});
const lp = () => page.evaluate(() => SillyTavern.getContext().extensionSettings.lovers_planner);
const meta = () => page.evaluate(() => window.__chatMetadata.lovers_planner ?? {});

// ===== 1. 舊聊天：設成獨立、留快照 =====
let m = await meta();
check('old chat set to separate', Object.values(m.scope ?? {}).every((v) => v === 'own') && Object.keys(m.scope ?? {}).length === 6, JSON.stringify(m.scope));
await sleep(1800);
let s = await lp();
const snapA = s.characters['shenyan.png']?.chats?.['聊天A'];
check('snapshot written', snapA && snapA.lines.length === 3 && snapA.notes.length === 4, JSON.stringify(snapA));

// ===== 2. 新聊天：照角色設定自動帶 =====
await switchTo('聊天B', greeting('b'));
await page.waitForFunction(() => window.__chatMetadata.lovers_planner?.recap?.status === 'ok');
m = await meta();
check('recap condensed', m.recap.text === '濃縮後的前情提要' && m.recap.mode === 'condensed' && m.recap.raw.includes('A的第1層'), JSON.stringify(m.recap));
check('recap source', m.recap.source === '聊天A');
let n = await notes();
check('characters shared (default)', n.c_lin?.relation === '朋友');
check('items copied (default)', n.i_qin?.holder === '沈言');
check('promises copied (default)', Boolean(n.p_sea));
check('todos not brought (default)', !n.t_flower);
s = await lp();
check('shared store seeded with character', Boolean(s.characters['shenyan.png'].shared?.notes?.c_lin));
check('copied notes stored as this chat\'s base', Boolean(m.base?.notes?.i_qin) && !m.base?.notes?.c_lin);
check('new chat keeps inherit scope', Object.values(m.scope ?? {}).every((v) => v === 'inherit'), JSON.stringify(m.scope));
let r = await page.evaluate(() => window.__runInterceptor('normal'));
check('injection starts with recap', r.injection?.value.includes('【前情摘要】\n［前情提要］濃縮後的前情提要'), r.injection?.value);
check('injection has carried notes', r.injection.value.includes('林曉') && r.injection.value.includes('古琴'));

// 摘要分頁的前情提要卡片
await openPanel();
await page.click('[data-tab="summary"]');
check('recap card shown', (await page.textContent('[data-role="recap"]')).includes('濃縮後的前情提要'));
await page.click('[data-role="recap"] [data-action="recap-raw"]');
check('use original', (await page.textContent('[data-role="recap"]')).includes('A的第1層'));
await page.click('[data-role="recap"] [data-action="recap-condense"]');
await page.waitForFunction(() => window.__chatMetadata.lovers_planner.recap.mode === 'condensed');
await page.click('[data-role="recap"] [data-action="recap-edit"]');
await page.fill('[data-role="recap"] textarea', '我改過的前情提要');
await page.click('[data-action="recap-save"]');
check('recap edited', (await meta()).recap.text === '我改過的前情提要');
await page.screenshot({ path: `${OUT}/carry-recap.png` });

// 記事卡片標出來源
await page.click('[data-tab="items"]');
await page.click('[data-fold-key="note:i_qin"] .lp-row-head');
check('carried note shows source', (await page.textContent('[data-fold-key="note:i_qin"]')).includes('從「聊天A」帶來'));
await page.keyboard.press('Escape');

// ===== 3. 即時共用：B 改人物，A 改成共用後看得到；A 改的 B 也看得到 =====
await page.evaluate(async () => {
  const { updateNoteManual } = await import('/src/notes.js');
  updateNoteManual('c_lin', { name: '林曉', relation: '戀人' });
});
s = await lp();
check('B edit written to shared store', s.characters['shenyan.png'].shared.notes.c_lin.data.relation === '戀人');
await switchTo('聊天A');
n = await notes();
check('separate chat A not affected', n.c_lin.relation === '朋友');
await page.evaluate(async () => (await import('/src/carry.js')).changeChatScope('characters', 'share'));
n = await notes();
check('A switched to share sees newer edit', n.c_lin.relation === '戀人', JSON.stringify(n.c_lin));
await page.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 5));
  (await import('/src/notes.js')).updateNoteManual('c_lin', { name: '林曉', relation: '戀人', status: '生病' });
});
await switchTo('聊天B');
n = await notes();
check('B sees A edit (latest wins)', n.c_lin.status === '生病' && n.c_lin.relation === '戀人', JSON.stringify(n.c_lin));
// A 的舊變化（樓層 1 新增「朋友」）不會蓋掉比較新的修改
await switchTo('聊天A');
n = await notes();
check('older floor op does not override', n.c_lin.relation === '戀人');

// ===== 4. 共用 → 獨立：留一份 =====
await switchTo('聊天B');
await page.evaluate(async () => (await import('/src/carry.js')).changeChatScope('characters', 'own'));
n = await notes();
check('switching to separate keeps a copy', n.c_lin?.status === '生病');
await page.evaluate(async () => (await import('/src/notes.js')).updateNoteManual('c_lin', { name: '林曉', relation: '前任' }));
s = await lp();
check('separate edits not shared', s.characters['shenyan.png'].shared.notes.c_lin.data.relation === '戀人');

// ===== 5. 摘要即時共用（唯讀） =====
await page.evaluate(async () => (await import('/src/carry.js')).changeCharacterScope('summary', 'share'));
await sleep(1800); // 讓 B 的快照寫好
await switchTo('聊天C', greeting('c'));
m = await meta();
check('summary linked instead of copied', !m.recap && Boolean(m.summaryLink?.source), JSON.stringify(m));
await openPanel();
await page.click('[data-tab="settings"]');
if (!(await page.$eval('details[data-sec="scope"]', (d) => d.open))) await page.click('details[data-sec="scope"] > summary');
await page.selectOption('[data-role="summary-source"]', '聊天A');
check('source picked', (await meta()).summaryLink.source === '聊天A');
await page.click('[data-tab="summary"]');
const linked = await page.textContent('[data-role="recap-linked"]');
check('linked card read-only', linked.includes('A的第1層') && linked.includes('唯讀') && !(await page.$('[data-role="recap-linked"] button')), linked);
r = await page.evaluate(() => window.__runInterceptor('normal'));
check('linked summaries injected', r.injection.value.includes('A的第5層'));
await page.screenshot({ path: `${OUT}/carry-linked.png` });
await page.keyboard.press('Escape');
// A 有新摘要 → C 讀到最新的
await switchTo('聊天A');
await page.evaluate(async () => (await import('/src/summarize.js')).writeSummary(5, { summary: 'A的第5層（改過）' }));
await sleep(1800);
await switchTo('聊天C');
r = await page.evaluate(() => window.__runInterceptor('normal'));
check('linked summary is live', r.injection.value.includes('A的第5層（改過）'), r.injection.value);

// ===== 6. 從其他聊天匯入＋復原 =====
const D = A.map((x, i) => ({ ...x, send_date: `d${i}`, extra: {} }));
await switchTo('聊天D', D);
check('old chat D separate', Object.values((await meta()).scope).every((v) => v === 'own'));
await openPanel();
await page.click('[data-tab="settings"]');
if (!(await page.$eval('details[data-sec="scope"]', (d) => d.open))) await page.click('details[data-sec="scope"] > summary');
await page.selectOption('[data-role="import-src"]', '聊天A');
for (const k of ['summary', 'items', 'todos']) {
  const box = `[data-import-kind="${k}"]`;
  if (!(await page.isChecked(box))) await page.check(box);
}
for (const k of ['characters', 'promises']) if (await page.isChecked(`[data-import-kind="${k}"]`)) await page.uncheck(`[data-import-kind="${k}"]`);
await page.click('[data-action="import-run"]');
await page.waitForFunction(() => window.__chatMetadata.lovers_planner?.recap?.status === 'ok');
n = await notes();
check('import brought chosen kinds only', n.i_qin && n.t_flower && !n.c_lin && !n.p_sea, JSON.stringify(Object.keys(n)));
check('import result shown', (await page.textContent('[data-role="import"]')).includes('已匯入'));
await page.screenshot({ path: `${OUT}/carry-import.png`, fullPage: true });
await page.click('[data-role="import"] [data-action="carry-undo"]');
n = await notes();
m = await meta();
check('undo import', !n.i_qin && !n.t_flower && !m.recap, JSON.stringify({ n: Object.keys(n), recap: m.recap }));
await page.keyboard.press('Escape');

// ===== 7. 原樣帶過去＋新聊天的復原 =====
await page.evaluate(() => {
  const s = SillyTavern.getContext().extensionSettings.lovers_planner;
  s.carry.recapMode = 'raw';
  s.characters['shenyan.png'].scope.summary = 'copy';
});
await switchTo('聊天E', greeting('e'));
m = await meta();
check('raw mode copies lines', m.recap?.mode === 'raw' && m.recap.text === m.recap.raw && m.recap.text.includes('A的第1層'), JSON.stringify(m.recap));
const before = (await page.evaluate(() => window.__prompts.length));
await sleep(300);
check('raw mode does not call the model', (await page.evaluate(() => window.__prompts.length)) === before);
await page.evaluate(async () => (await import('/src/carry.js')).undoCarry());
m = await meta();
n = await notes();
check('undo new-chat carry', !m.recap && !Object.keys(n).length && m.scope.characters === 'own', JSON.stringify({ m, n }));

// ===== 8. 全部不帶 =====
await page.evaluate(() => {
  const s = SillyTavern.getContext().extensionSettings.lovers_planner;
  s.characters['shenyan.png'].scope = { summary: 'none', characters: 'none', items: 'none', promises: 'none', todos: 'none' };
});
await switchTo('聊天F', greeting('f'));
m = await meta();
check('nothing brought when all none', !m.recap && !m.carry && !Object.keys(await notes()).length);

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const line of results) console.log(line);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
