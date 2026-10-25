// 第 6 步：只送相關的記事＋回憶召回（關鍵字、向量、出錯時改用關鍵字、釘選、設定頁、送出預覽）。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

// 15 個 AI 樓層（0,2,…,28）＋最後一句使用者發言（29）。
const CHAT = [];
for (let i = 0; i < 30; i++) {
  const ai = i % 2 === 0;
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i}`, send_date: `d${i}`, extra: {} });
}
CHAT[29].mes = '我想起林曉送的那把古琴，還有那條鏈子。';

// 假的向量模型：依幾個關鍵字算向量（「鏈子」和「手鍊」算同一維）。
const DIMS = [['海'], ['花'], ['琴'], ['咖啡', '煮'], ['鏈', '手鍊'], ['貝殼']];
function fakeEmbed(text) {
  return [0.05, ...DIMS.map((words) => words.reduce((n, w) => n + text.split(w).length - 1, 0))];
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon') && !m.text().includes('status of 500')) errors.push('console: ' + m.text()); });

let embedCalls = 0;
let embedInputs = 0;
let embedFail = false;
await page.route('https://embed.test/v1/embeddings', async (route) => {
  embedCalls++;
  if (embedFail) return route.fulfill({ status: 500, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":{"message":"boom"}}' });
  const body = JSON.parse(route.request().postData());
  embedInputs += body.input.length;
  const data = body.input.map((x, index) => ({ index, embedding: fakeEmbed(x) }));
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ data }) });
});

await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__presetSettings = { lovers_planner: { settingsVersion: 3, compress: { auto: true, l1PerL2: 3, l2PerL3: 50, ratioMin: 30, ratioMax: 40 } } };
}, CHAT);
await page.goto(URL);
await page.waitForFunction(() => document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor);

await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  const summaries = { 4: '林曉在海邊撿到貝殼', 6: '沈言煮咖啡', 10: '小雨收到一條手鍊' };
  for (let i = 0; i < 30; i += 2) {
    setEntry(i, { v: 2, status: 'ok', time: `第${i}天`, location: i === 4 ? '海邊' : '家', characters: i === 24 ? ['周老闆'] : [], summary: summaries[i] ?? `L1-${i}`, ops: [], hash: floorSource(i).hash, at: 1000 + i });
  }
  window.__chat[0].extra.lovers_planner.ops = [
    { op: 'add', id: 'c_shen', type: 'character', data: { name: '沈言', identity: '咖啡師' } },
    { op: 'add', id: 'c_yu', type: 'character', data: { name: '小雨（雨）', likes: '下雨天' } },
    { op: 'add', id: 'c_lin', type: 'character', data: { name: '林曉', relation: '朋友' } },
    { op: 'add', id: 'c_zhou', type: 'character', data: { name: '周老闆', identity: '房東' } },
    { op: 'add', id: 'c_wang', type: 'character', data: { name: '王阿姨', identity: '鄰居' } },
    { op: 'add', id: 'i_bracelet', type: 'item', data: { name: '銀色手鍊', holder: '小雨' } },
    { op: 'add', id: 'i_qin', type: 'item', data: { name: '古琴', holder: '沈言' } },
    { op: 'add', id: 'p_sea', type: 'promise', data: { content: '一起去看海', with: '林曉' } },
    { op: 'add', id: 't_flower', type: 'todo', data: { content: '買花' } },
  ];
  (await import('/src/notes.js')).invalidateNotes();
  window.__generateRaw = async ({ prompt }) => (prompt.includes('章節總結') ? '章' : '{"summary":"x","ops":[]}');
  await window.__emit('chat_id_changed');
});
const run = (type = 'normal') => page.evaluate((type) => window.__runInterceptor(type), type);
const select = () => page.evaluate(async () => {
  const { computeHidden } = await import('/src/hide.js');
  const { selectRelevant } = await import('/src/recall.js');
  const r = await selectRelevant({ keepFrom: computeHidden().keepFrom });
  return { notes: Object.fromEntries([...r.notes].map(([id, x]) => [id, x.reason + (x.score !== undefined ? ':' + x.score.toFixed(2) : '')])), memories: r.memories.map((m) => `${m.index}:${m.reason}`), vector: r.vector, total: r.total, error: r.error };
});

// ===== 1. 關鍵字 =====
let r = await run();
const inj = r.injection.value;
check('chapters were compressed first', inj.includes('第 1 章'), inj);
check('leads always sent', inj.includes('名字：沈言') && inj.includes('名字：小雨（雨）'));
check('mentioned character sent', inj.includes('名字：林曉'));
check('mentioned item sent', inj.includes('名稱：古琴'));
check('promise sent when its person is mentioned', inj.includes('一起去看海'));
check('cast of a recent floor sent', inj.includes('名字：周老闆'));
check('unmentioned character not sent', !inj.includes('王阿姨'));
check('unmentioned item not sent', !inj.includes('銀色手鍊'));
check('unmentioned todo not sent', !inj.includes('買花'));
check('memory recall section present', inj.includes('【相關回憶】\n［第4天｜海邊］林曉在海邊撿到貝殼'), inj);
check('unrelated old floor not recalled', !inj.includes('沈言煮咖啡'));
check('memory goes between summaries and notes', inj.indexOf('【前情摘要】') < inj.indexOf('【相關回憶】') && inj.indexOf('【相關回憶】') < inj.indexOf('【記事】'));
check('no embedding calls when vectors are off', embedCalls === 0);
let st = await page.evaluate(async () => (await import('/src/hide.js')).getLastStats());
check('stats count notes sent', st.notesSent === 6 && st.notesTotal === 9 && st.memories === 1 && st.vector === 'off', JSON.stringify(st));

let sel = await select();
check('reasons', sel.notes.c_shen === 'lead' && sel.notes.c_lin === 'mention' && sel.notes.c_zhou === 'recent' && sel.notes.p_sea === 'mention', JSON.stringify(sel.notes));
check('memory reason keyword', sel.memories.join() === '4:keyword', sel.memories.join());

// ===== 2. 釘選 =====
await page.click('#lp_wand_entry');
await page.click('[data-tab="notes"]');
await page.click('[data-fold-key="note:t_flower"] .lp-row-head');
await page.click('[data-action="note-pin"][data-id="t_flower"]');
check('pin tag shown', await page.isVisible('[data-fold-key="note:t_flower"] .lp-pin-tag'));
check('pin button turns into unpin', (await page.textContent('[data-action="note-pin"][data-id="t_flower"]')).includes('取消釘選'));
r = await run();
check('pinned todo sent', r.injection.value.includes('買花'));
sel = await select();
check('pinned reason', sel.notes.t_flower === 'pinned');
await page.screenshot({ path: `${OUT}/recall-pin.png` });

// ===== 3. 送出預覽：為什麼送這些 =====
await page.click('[data-tab="summary"]');
await page.click('details[data-preview] > summary');
await page.waitForSelector('[data-role="preview-recall"]');
const rows = await page.$$eval('.lp-preview-row', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
check('preview shows sent/total per kind', rows.some((x) => x.startsWith('人物（送 4／共 5 條）')), JSON.stringify(rows));
check('preview shows memories row', rows.some((x) => x.startsWith('相關回憶（1 層）')), JSON.stringify(rows));
await page.click('[data-role="preview-recall"] > summary');
const why = await page.textContent('[data-role="preview-recall"]');
check('preview explains reasons', why.includes('林曉') && why.includes('提到名字') && why.includes('釘選') && why.includes('向量：沒開啟'), why);
await page.screenshot({ path: `${OUT}/recall-preview.png` });

// ===== 4. 設定頁：向量模型 =====
await page.click('[data-tab="settings"]');
await page.click('details[data-sec="recall"] > summary');
check('recall section has options', await page.isVisible('input[data-path="recall.notes"]') && await page.isVisible('input[data-path="recall.memory"]'));
check('vector card hidden until enabled', !(await page.isVisible('[data-api-card="vector"]')));
await page.check('input[data-path="recall.vector.enabled"]');
await page.waitForSelector('[data-api-card="vector"]');
check('vector prefilled with SiliconFlow', await page.inputValue('#lp-vector-url') === 'https://api.siliconflow.cn/v1' && await page.inputValue('#lp-vector-model') === 'BAAI/bge-m3');
check('recommendation shown', (await page.textContent('details[data-sec="recall"]')).includes('bge-m3'));
await page.fill('#lp-vector-url', 'https://embed.test/v1/embeddings');
await page.fill('#lp-vector-model', 'fake-embed');
await page.click('[data-action="test-vector"]');
await page.waitForFunction(() => document.querySelector('[data-role="vector-status"]')?.textContent.includes('維'));
check('test shows dimensions', (await page.textContent('[data-role="vector-status"]')).includes(`${DIMS.length + 1} 維`));
check('vector draft dirty', (await page.textContent('[data-role="vector-status"]')).includes('未儲存'));
await page.click('[data-action="save-vector"]');
let saved = await page.evaluate(() => SillyTavern.getContext().extensionSettings.lovers_planner.recall.vector);
check('vector saved (url cleaned)', saved.enabled && saved.url === 'https://embed.test/v1' && saved.model === 'fake-embed', JSON.stringify(saved));
check('custom API card untouched', !(await page.isVisible('[data-api-card="custom"]')));
await page.screenshot({ path: `${OUT}/recall-settings.png`, fullPage: true });
await page.fill('input[data-path="recall.threshold"]', '50');
await page.dispatchEvent('input[data-path="recall.threshold"]', 'change');

// ===== 5. 向量 =====
embedCalls = 0; embedInputs = 0;
sel = await select();
check('vector used', sel.vector === 'ok', sel.error);
check('vector adds the bracelet ("鏈子" ≈ 手鍊)', String(sel.notes.i_bracelet).startsWith('vector:'), JSON.stringify(sel.notes));
check('vector does not add unrelated ones', !sel.notes.c_wang, JSON.stringify(sel.notes));
check('keyword reasons kept with vectors', sel.notes.c_lin === 'mention');
check('vector recalls the bracelet floor', sel.memories.includes('10:vector'), sel.memories.join());
check('keyword memory still recalled', sel.memories.some((m) => m.startsWith('4:')), sel.memories.join());
const firstInputs = embedInputs;
sel = await select();
check('vectors are cached (nothing re-sent)', embedInputs === firstInputs, `${firstInputs} → ${embedInputs}`);
r = await run();
check('injection includes vector picks', r.injection.value.includes('銀色手鍊') && r.injection.value.includes('小雨收到一條手鍊'));

// 快取放在 IndexedDB：清掉記憶體後還在。
embedInputs = 0;
await page.evaluate(async () => (await import('/src/vectors.js')).clearMemoryCache());
await select();
check('IndexedDB cache survives (only nothing new sent)', embedInputs === 0, String(embedInputs));

// ===== 6. 向量出錯：改用關鍵字，不擋生成 =====
embedFail = true;
await page.evaluate(async () => (await import('/src/vectors.js')).clearMemoryCache());
CHAT[29].mes = '換個話題，林曉今天來了。';
await page.evaluate((m) => { window.__chat[29].mes = m; }, CHAT[29].mes);
r = await run();
check('generation not aborted on vector error', !r.aborted && Boolean(r.injection?.value));
check('falls back to keywords', r.injection.value.includes('名字：林曉') && !r.injection.value.includes('古琴'), r.injection.value);
st = await page.evaluate(async () => (await import('/src/hide.js')).getLastStats());
check('stats mark vector error', st.vector === 'error' && st.reason === null, JSON.stringify(st));
check('header mentions vector error', (await page.textContent('.lp-stats')).includes('向量出錯'));
embedFail = false;

// ===== 7. 關掉「只送相關」＝全部送 =====
await page.evaluate(() => {
  const s = SillyTavern.getContext().extensionSettings.lovers_planner;
  s.recall.notes = false; s.recall.memory = false; s.recall.vector.enabled = false;
});
r = await run();
check('all notes sent when filter off', ['王阿姨', '銀色手鍊', '買花', '古琴'].every((x) => r.injection.value.includes(x)));
check('no memories when recall off', !r.injection.value.includes('【相關回憶】'));
st = await page.evaluate(async () => (await import('/src/hide.js')).getLastStats());
check('stats: notesSent null when not filtering', st.notesSent === null, JSON.stringify(st));

// ===== 8. 別名 =====
const aliases = await page.evaluate(async () => (await import('/src/recall.js')).aliasesOf('林曉（小曉）/ Lin Xiao'));
check('aliases split', ['林曉（小曉）/ lin xiao', '林曉', '小曉', 'lin', 'xiao'].every((a) => aliases.includes(a)), JSON.stringify(aliases));
const short = await page.evaluate(async () => (await import('/src/recall.js')).aliasesOf('周'));
check('single CJK char not used as alias', short.length === 0, JSON.stringify(short));

// 三語 key 一致
const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const line of results) console.log(line);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
