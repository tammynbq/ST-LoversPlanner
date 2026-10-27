// 🌍 從世界書填寫（v0.13.19）：讀角色卡綁定的、內嵌的世界書；名字對得上已記人物的先勾好；
// 模型整理成欄位（不是人物的跳過），已有的人物只補空的／人設的欄位，新的人物新增；欄位標人設、不送給角色。
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
for (let i = 0; i < 6; i++) {
  const ai = i % 2 === 1;
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${i}`, send_date: `d${i}`, extra: {} });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 1100 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__characters = [{ name: '沈言', avatar: 'shenyan.png', data: {
    extensions: { world: '恋语市' },
    character_book: { name: '卡內設定', entries: [{ id: 0, keys: ['陳伯'], comment: '陳伯', content: '陳伯，咖啡店老闆，六十歲。' }] },
  } }];
  window.__worlds = { '恋语市': { entries: {
    1: { uid: 1, key: ['林曉', '小曉'], comment: '林曉', content: '林曉，24 歲，沈言醫院的護理師，短髮，個性開朗。' },
    2: { uid: 2, key: ['恋语市'], comment: '恋语市', content: '海邊的城市。' },
    3: { uid: 3, key: ['院長'], comment: '院長', content: '醫院院長，嚴肅。', disable: true },
  } } };
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, recall: { notes: false, memory: false }, compress: { auto: false } } };
}, CHAT);
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

// 第 1 層記下林曉（故事裡已經知道她的身份）。hash 要對，不然會被當成過期、送出時跳提醒。
await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  setEntry(1, { v: 2, status: 'ok', summary: 's', hash: floorSource(1).hash, at: 1,
    ops: [{ op: 'add', id: 'c_lin', type: 'character', data: { name: '林曉', identity: '護理師（故事中）' } }] });
  (await import('/src/notes.js')).invalidateNotes();
});
await page.evaluate(() => {
  window.__generateRaw = async ({ prompt }) => {
    if (!prompt.includes('世界書（設定集）的條目')) return '{"summary":"s","ops":[]}';
    const chars = [];
    if (prompt.includes('[恋语市::1]')) chars.push({ entry: '恋语市::1', name: '林曉', age: '24', identity: '護理師', appearance: '短髮', personality: '開朗' });
    if (prompt.includes('[卡內設定::0]')) chars.push({ entry: '卡內設定::0', name: '陳伯', identity: '咖啡店老闆', age: '60' });
    chars.push({ entry: '別的::9', name: '亂入' }); // 不是這一批的條目：不收
    return JSON.stringify({ characters: chars });
  };
});

const entries = await page.evaluate(async () => (await import('/src/worldfill.js')).listWorldEntries());
check('reads linked and embedded books, skips disabled', entries.length === 3 && entries.some((x) => x.id === '卡內設定::0') && !entries.some((x) => x.title === '院長'), JSON.stringify(entries.map((x) => x.id)));
check('known character pre-flagged', entries.find((x) => x.title === '林曉')?.known === true && !entries.find((x) => x.title === '陳伯')?.known);

await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="characters"]');
await page.click('[data-action="note-world-open"]');
await page.waitForSelector('[data-role="world"] [data-action="world-pick"]');
check('list shows entries, known ticked', (await page.getAttribute('[data-action="world-pick"][data-id="恋语市::1"]', 'aria-pressed')) === 'true'
  && (await page.getAttribute('[data-action="world-pick"][data-id="卡內設定::0"]', 'aria-pressed')) === 'false');
await page.click('[data-action="world-pick"][data-id="卡內設定::0"]');
check('fill button counts calls', (await page.textContent('[data-action="world-fill"]')).includes('2 條（約 1 次呼叫）'));
await page.screenshot({ path: `${OUT}/world.png` });
await page.click('[data-action="world-fill"]');
await page.waitForFunction(() => document.querySelector('[data-role="world-msg"]')?.textContent.includes('從世界書填好了'), null, { timeout: 10000 });
check('done message', (await page.textContent('[data-role="world-msg"]')).includes('新增 1 個、更新 1 個'), await page.textContent('[data-role="world-msg"]'));

const notes = await page.evaluate(async () => [...(await import('/src/notes.js')).getNotes().notes.values()]
  .filter((n) => n.type === 'character').map((n) => ({ name: n.data.name, data: n.data, card: n.cardFields ?? [] })));
const lin = notes.find((n) => n.name === '林曉');
const chen = notes.find((n) => n.name === '陳伯');
check('existing character: story field kept, empty ones filled', lin.data.identity === '護理師（故事中）' && lin.data.age === '24' && lin.data.appearance === '短髮' && lin.card.includes('age') && !lin.card.includes('identity'), JSON.stringify(lin));
check('new character added with card fields', chen?.data.identity === '咖啡店老闆' && chen.card.includes('identity'), JSON.stringify(chen));
check('stray entry ignored', !notes.some((n) => n.name === '亂入'));
const prompt = await page.evaluate(() => window.__prompts.at(-1).prompt);
check('prompt has entries and fields', prompt.includes('林曉，24 歲') && prompt.includes('陳伯，咖啡店老闆') && !prompt.includes('海邊的城市') && prompt.includes('appearance：'), prompt.slice(0, 200));

const r = await page.evaluate(() => window.__runInterceptor('normal'));
check('card fields not injected', !r.injection.value.includes('咖啡店老闆') && !r.injection.value.includes('短髮') && r.injection.value.includes('護理師（故事中）'), r.injection.value);

// 沒有世界書
await page.evaluate(() => { window.__characters[0].data = {}; });
await page.click('[data-action="note-world-close"]');
await page.click('[data-action="note-world-open"]');
await page.waitForFunction(() => document.querySelector('[data-role="world"]')?.textContent.includes('沒有找到世界書條目'));
check('no lorebook message', true);

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
