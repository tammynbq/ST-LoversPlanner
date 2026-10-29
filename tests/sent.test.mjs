// 「這一回送了什麼」（v0.13.30）：送出時記下記事、召回的舊樓層、想起的回憶、向量狀態，
// 等酒館存好回覆後貼到那則訊息上（每個 swipe 各記各的）；摘要區塊裡可以點開看，點樓層號跳過去。
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

// 假的向量模型（和 recall 測試一樣）：「鏈子」和「手鍊」算同一維。
const DIMS = [['海'], ['花'], ['琴'], ['咖啡', '煮'], ['鏈', '手鍊'], ['貝殼']];
const fakeEmbed = (text) => [0.05, ...DIMS.map((words) => words.reduce((n, w) => n + text.split(w).length - 1, 0))];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon') && !m.text().includes('status of 500')) errors.push('console: ' + m.text()); });
let embedFail = false;
await page.route('https://embed.test/v1/embeddings', async (route) => {
  if (embedFail) return route.fulfill({ status: 500, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":{"message":"boom"}}' });
  const body = JSON.parse(route.request().postData());
  const data = body.input.map((x, index) => ({ index, embedding: fakeEmbed(x) }));
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ data }) });
});

await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, compress: { auto: true, l1PerL2: 3, l2PerL3: 50, ratioMin: 30, ratioMax: 40 },
    recall: { notes: true, memory: true, threshold: 50, vector: { enabled: true, url: 'https://embed.test/v1', key: 'k', model: 'fake-embed' } } } };
}, CHAT);
await page.goto(URL);
await page.waitForFunction(() => document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor);

await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  const summaries = { 4: '林曉在海邊撿到貝殼', 6: '沈言煮咖啡', 10: '小雨收到一條手鍊' };
  for (let i = 0; i < 30; i += 2) {
    setEntry(i, { v: 2, status: 'ok', time: `第${i}天`, location: '家', characters: [], summary: summaries[i] ?? `L1-${i}`, ops: [], hash: floorSource(i).hash, at: 1000 + i });
  }
  window.__chat[0].extra.lovers_planner.ops = [
    { op: 'add', id: 'c_shen', type: 'character', data: { name: '沈言', identity: '咖啡師' } },
    { op: 'add', id: 'c_yu', type: 'character', data: { name: '小雨' } },
    { op: 'add', id: 'c_lin', type: 'character', data: { name: '林曉', relation: '朋友' } },
    { op: 'add', id: 'c_wang', type: 'character', data: { name: '王阿姨', identity: '鄰居' } },
    { op: 'add', id: 'i_qin', type: 'item', data: { name: '古琴', holder: '沈言' } },
    { op: 'add', id: 'p_sea', type: 'promise', data: { content: '一起去看海', with: '林曉' } },
  ];
  (await import('/src/notes.js')).invalidateNotes();
  window.__generateRaw = async ({ prompt }) => (prompt.includes('章節總結') ? '章' : '{"summary":"x","ops":[]}');
  const m = await import('/src/memories.js');
  m.addMemory({ title: '雨中告白', content: '沈言在雨中告白。', floor: 2 });
  m.surfaceNext(m.listMemories()[0].key);
  await window.__emit('chat_id_changed');
});

// 模擬酒館：生成完把回覆放進聊天（新訊息或新的 swipe），再發 MESSAGE_RECEIVED。
const reply = (opts) => page.evaluate(async ({ swipe }) => {
  const chat = window.__chat;
  if (swipe) {
    const m = chat[chat.length - 1];
    m.swipes.push(`第${m.swipes.length}版`);
    m.swipe_info.push({ send_date: `s${m.swipes.length}`, extra: structuredClone(m.extra) });
    m.swipe_id = m.swipes.length - 1;
    m.mes = m.swipes[m.swipe_id];
  } else {
    const n = chat.length;
    chat.push({ name: '沈言', is_user: false, mes: `AI${n}`, send_date: `d${n}`, swipes: [`AI${n}`], swipe_id: 0, swipe_info: [{ send_date: `d${n}`, extra: {} }], extra: {} });
  }
  window.__renderChat();
  await window.__emit('message_received', chat.length - 1);
}, opts ?? {});
const receipt = (i) => page.evaluate(async (i) => (await import('/src/sent.js')).receiptOf(i), i);

// ===== 1. 一般送出：記下記事、召回、回憶、向量 =====
await page.evaluate(() => window.__runInterceptor('normal'));
await reply();
let r = await receipt(30);
check('receipt attached to the reply', Boolean(r) && r.swipe === 0, JSON.stringify(r)?.slice(0, 200));
const titles = (r?.notes ?? []).map((n) => `${n.title}:${n.reason}`);
check('notes with reasons', titles.includes('沈言:lead') && titles.includes('林曉:mention') && titles.includes('古琴:mention') && !titles.some((x) => x.startsWith('王阿姨')), JSON.stringify(titles));
check('note counts', r?.filtered && r.notesTotal === 6 && r.notesSent === r.notes.length, JSON.stringify({ total: r?.notesTotal, sent: r?.notesSent }));
const f10 = r?.floors.find((f) => f.floor === 10);
check('vector recall of an old floor, with similarity', f10?.reason === 'vector' && f10.score >= 50 && f10.date === 'd10' && f10.line.includes('手鍊'), JSON.stringify(r?.floors));
check('pinned memory recorded', r?.reminders.length === 1 && r.reminders[0].title === '雨中告白' && r.reminders[0].reason === 'pinned', JSON.stringify(r?.reminders));
check('vector status and embed count', r?.vector === 'ok' && r.fetched > 0, JSON.stringify({ v: r?.vector, f: r?.fetched }));
check('tokens recorded', r?.injectedTokens > 0, String(r?.injectedTokens));
check('copied into the current swipe', await page.evaluate(() => Boolean(window.__chat[30].swipe_info[0].extra.lovers_planner_sent)));

// ===== 2. 畫面：摘要區塊裡可以點開；點樓層號跳過去 =====
await page.evaluate(async () => (await import('/src/ui/message.js')).revealFloor(30));
await page.waitForSelector('.mes[mesid="30"] .lp-sent');
const sum = await page.textContent('.mes[mesid="30"] .lp-sent > summary');
check('summary line', sum.includes('這一回送了什麼') && sum.includes(`記事 ${r.notesSent}／6`) && sum.includes('召回') && sum.includes('想起 1 條回憶'), sum);
await page.click('.mes[mesid="30"] .lp-sent > summary');
const body = await page.textContent('.mes[mesid="30"] .lp-sent');
check('details list reasons and similarity', !body.includes('地點 0%') && body.includes('林曉') && body.includes('提到名字') && /意思相近 \d+%/.test(body) && body.includes('指定下次提起') && body.includes('這回新轉了'), body.slice(0, 300));
await page.screenshot({ path: `${OUT}/sent-open.png` });
await page.click('.mes[mesid="30"] [data-lp-act="sent-jump"][data-floor="10"]');
check('jump opens the recalled floor', await page.evaluate(() => Boolean(document.querySelector('.mes[mesid="10"] .lp-sum-body'))));

// ===== 3. 背景生成（quiet）不記，也不會貼到別的訊息 =====
const before = JSON.stringify(await receipt(30));
await page.evaluate(() => window.__runInterceptor('quiet'));
await page.evaluate(async () => { await window.__emit('message_received', 30); });
check('quiet generation leaves the receipt alone', JSON.stringify(await receipt(30)) === before);

// ===== 4. swipe：新的 swipe 先不顯示舊的；生成完記自己的；切回去看到原本的 =====
await page.evaluate(() => window.__runInterceptor('swipe'));
await reply({ swipe: true });
r = await receipt(30);
check('new swipe has its own receipt', r?.swipe === 1 && r.reminders.length === 0, JSON.stringify(r)?.slice(0, 160));
const back = await page.evaluate(async () => {
  const m = window.__chat[30];
  m.swipe_id = 0; m.extra = structuredClone(m.swipe_info[0].extra);
  return (await import('/src/sent.js')).receiptOf(30);
});
check('switching back shows the first swipe receipt', back?.swipe === 0 && back.reminders.length === 1, JSON.stringify(back)?.slice(0, 120));
const stale = await page.evaluate(async () => {
  const m = window.__chat[30];
  m.swipes.push('沒生成完'); m.swipe_id = 2; // 新 swipe 沿用了舊的 extra（還沒生成完）
  return (await import('/src/sent.js')).receiptOf(30);
});
check('a swipe with copied extra shows nothing', stale === null, JSON.stringify(stale));

// ===== 5. 向量出錯：記下來，摘要區塊寫原因 =====
embedFail = true;
await page.evaluate(async () => {
  window.__chat.push({ name: '小雨', is_user: true, mes: '那條鏈子呢？', send_date: 'd31', extra: {} });
  (await import('/src/vectors.js')).clearMemoryCache();
  const q = indexedDB.deleteDatabase('lovers_planner_vectors');
  await new Promise((res) => { q.onsuccess = q.onerror = q.onblocked = res; });
});
await page.evaluate(() => window.__runInterceptor('normal'));
await reply();
r = await receipt(32);
check('vector error recorded', r?.vector === 'error' && r.error.length > 0, JSON.stringify({ v: r?.vector, e: r?.error }));
await page.evaluate(async () => (await import('/src/ui/message.js')).revealFloor(32));
await page.click('.mes[mesid="32"] .lp-sent > summary');
check('error shown in the block', (await page.textContent('.mes[mesid="32"] .lp-sent-foot')).includes('向量出錯'));

// ===== 6. 刪過訊息：召回的樓層號用 send_date 找回來（真的刪第 0 層會跳「需要處理」的彈窗，這裡直接給位移過的記錄） =====
const moved = await page.evaluate(async () => {
  const m = window.__chat[30];
  m.swipes.pop(); m.swipe_id = 0; m.extra = structuredClone(m.swipe_info[0].extra);
  const { receiptOf, floorOf } = await import('/src/sent.js');
  const f = receiptOf(30).floors.find((x) => x.date === 'd10');
  return { same: floorOf(f), shifted: floorOf({ ...f, floor: 12 }), gone: floorOf({ floor: 999, date: 'zz' }) };
});
check('recalled floor index found by send_date', moved.same === 10 && moved.shifted === 10 && moved.gone === null, JSON.stringify(moved));

// ===== 7. 只送相關的關掉：寫全部都送 =====
await page.evaluate(async () => {
  SillyTavern.getContext().extensionSettings.lovers_planner.recall.notes = false;
  SillyTavern.getContext().extensionSettings.lovers_planner.recall.vector.enabled = false;
  window.__chat.push({ name: '小雨', is_user: true, mes: '晚安', send_date: 'd33', extra: {} });
});
await page.evaluate(() => window.__runInterceptor('normal'));
await reply();
const last = await page.evaluate(() => window.__chat.length - 1);
r = await receipt(last);
check('all notes sent when filtering is off', r && !r.filtered && r.notesSent === r.notesTotal && r.vector === 'off', JSON.stringify(r)?.slice(0, 160));
await page.evaluate(async (i) => (await import('/src/ui/message.js')).revealFloor(i), last);
await page.click(`.mes[mesid="${last}"] .lp-sent > summary`);
const t34 = await page.textContent(`.mes[mesid="${last}"] .lp-sent`);
check('block says all notes and vectors off', t34.includes('都送') && t34.includes('向量：沒開'), t34.slice(0, 200));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
