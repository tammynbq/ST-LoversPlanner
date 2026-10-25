// 隱藏舊樓層＋注入摘要和記事＋失敗／過期的強制彈窗。用模擬的攔截器呼叫測試。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

// 0 AI, 1 使用者, 2 AI, …, 8 AI, 9 使用者（正在送出的這句）。send_date 用來辨認每則訊息。
const CHAT = [];
for (let i = 0; i < 10; i++) {
  const ai = i % 2 === 0;
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i} 的內容`, send_date: `d${i}`, extra: {} });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => { window.__chat = chat; }, CHAT);
await page.goto(URL);
await page.waitForFunction(() => document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor);

// 讓第 0、2、4 層已摘要（hash 要和原文一致），第 2 層再帶一條記事。
await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  for (const i of [0, 2, 4]) {
    setEntry(i, { v: 2, status: 'ok', time: `第${i}天`, location: '咖啡店', characters: ['沈言'], summary: `第${i}層的摘要`, ops: [], hash: floorSource(i).hash });
  }
  window.__chat[2].extra.lovers_planner.ops = [{ op: 'add', id: 'i_test01', type: 'item', data: { name: '銀色手鍊', holder: '小雨' } }];
  (await import('/src/notes.js')).invalidateNotes();
  await window.__emit('chat_id_changed');
});
const run = (type) => page.evaluate((type) => window.__runInterceptor(type), type);

// 1. 基本：保留最新 2 個 AI 樓層（6、8）和它們前面的使用者發言（5、7）＋正在送出的 9
let r = await run('normal');
check('hides covered floors and their user messages', r.kept.join() === 'd5,d6,d7,d8,d9', r.kept.join());
check('injection placed right before kept raw floors', r.injection.position === 1 && r.injection.depth === 5, JSON.stringify({ p: r.injection.position, d: r.injection.depth }));
check('injection has scene lines in order', /［第0天｜咖啡店｜沈言］第0層的摘要\n［第2天｜咖啡店｜沈言］第2層的摘要\n［第4天/.test(r.injection.value), r.injection.value);
// 預設只送相關的記事：手鍊沒被提到，不送。
check('unmentioned item not sent by default', !r.injection.value.includes('銀色手鍊'), r.injection.value);
await page.evaluate(() => { SillyTavern.getContext().extensionSettings.lovers_planner.recall.notes = false; });
r = await run('normal');
check('injection has notes without ids', r.injection.value.includes('物件｜名稱：銀色手鍊') && !r.injection.value.includes('i_test01'));
await page.evaluate(() => { SillyTavern.getContext().extensionSettings.lovers_planner.recall.notes = true; });
check('system role', r.injection.role === 0);
check('chat itself untouched', await page.evaluate(() => window.__chat.length === 10 && window.__chat[0].mes === 'AI0 的內容'));

// 2. 畫面標示
await page.evaluate(async () => (await import('/src/ui/message.js')).renderAllBlocks());
check('hidden tag on AI block', (await page.textContent('.mes[mesid="0"] .lp-sum-head')).includes('已隱藏'));
check('no tag on kept floor', !(await page.textContent('.mes[mesid="6"] .lp-sum-head')).includes('已隱藏'));
check('hidden user message dimmed', await page.evaluate(() => document.querySelector('.mes[mesid="1"]').classList.contains('lp-hidden-user') && !document.querySelector('.mes[mesid="5"]').classList.contains('lp-hidden-user')));

// 3. 大視窗標題列的統計
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
check('stats in header', (await page.textContent('.lp-stats')).includes('隱藏 3 層'), await page.textContent('.lp-stats'));
await page.keyboard.press('Escape');
await page.evaluate(async () => { const { setEntry } = await import('/src/chat.js'); window.__saved4 = window.__chat[4].extra.lovers_planner; setEntry(4, null); });
await run('normal');
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
check('stats mention unsummarized floors', (await page.textContent('.lp-stats')).includes('1 層還沒摘要'), await page.textContent('.lp-stats'));
await page.evaluate(async () => { const { setEntry } = await import('/src/chat.js'); setEntry(4, window.__saved4); });
await run('normal');
await page.keyboard.press('Escape');

// 4. 過期的樓層：生成先暫停並跳彈窗；選「先不管，繼續生成」→ 照送原文
await page.evaluate(async () => { window.__chat[2].mes = 'AI2 被編輯過'; await window.__emit('message_edited', 2); });
let pending = page.evaluate(() => window.__runInterceptor('normal'));
await page.waitForSelector('.lp-attention');
check('popup lists the stale floor', (await page.textContent('.lp-attention')).includes('#2') && (await page.textContent('.lp-attention .lp-title')).includes('1 層'));
check('generation is held while popup open', await Promise.race([pending.then(() => false), page.waitForTimeout(300).then(() => true)]));
await page.screenshot({ path: `${OUT}/hide-1-popup.png` });
await page.click('[data-attn="continue"]');
r = await pending;
check('continue: stale floor sent raw (with its user message)', r.kept.join() === 'd1,d2,d5,d6,d7,d8,d9' && !r.aborted, r.kept.join());
check('stale summary not injected', !r.injection.value.includes('第2層的摘要'));
// 取消這次生成
pending = page.evaluate(() => window.__runInterceptor('normal'));
await page.waitForSelector('.lp-attention');
await page.click('[data-attn="cancel"]');
r = await pending;
check('cancel aborts generation', r.aborted === true);
// 在彈窗裡跳過 → 處理完自動開始生成，而且這次就隱藏
pending = page.evaluate(() => window.__runInterceptor('normal'));
await page.waitForSelector('.lp-attention');
await page.click('[data-attn="skip"][data-index="2"]');
r = await pending;
check('skip in popup → auto start, floor hidden now', r.kept.join() === 'd5,d6,d7,d8,d9' && !r.aborted, r.kept.join());
check('skipped floor notes dropped', !r.injection.value.includes('銀色手鍊'));
check('popup closed after auto start', !(await page.isVisible('.lp-attention')));

// 5. 失敗的樓層 → 彈窗裡重新摘要成功 → 自動開始生成
await page.evaluate(async () => {
  const { setEntry, floorSource } = await import('/src/chat.js');
  setEntry(4, { v: 2, status: 'fail', error: 'API 逾時', hash: floorSource(4).hash, summary: '' });
  await window.__emit('chat_id_changed');
  window.__generateRaw = async () => '{"summary":"重新摘要好了","ops":[]}';
});
pending = page.evaluate(() => window.__runInterceptor('normal'));
await page.waitForSelector('.lp-attention [data-attn="retry"]');
check('popup shows error', (await page.textContent('.lp-attention')).includes('API 逾時'));
await page.click('[data-attn="retry"][data-index="4"]');
r = await pending;
check('retry in popup → summarized, hidden and injected', !r.kept.includes('d4') && r.injection.value.includes('重新摘要好了'), r.kept.join());

// 5b. 「開始下回前自動摘要」：上一層還沒摘要 → 先摘要好才開始生成
await page.evaluate(async () => {
  const { setEntry } = await import('/src/chat.js');
  setEntry(8, null);
  window.__prompts.length = 0;
  window.__generateRaw = async () => { await new Promise((ok) => setTimeout(ok, 300)); return '{"summary":"上一層的摘要","ops":[]}'; };
});
r = await run('normal');
check('before mode: previous floor summarized before generation continues', await page.evaluate(() => window.__chat[8].extra.lovers_planner?.summary === '上一層的摘要' && window.__prompts.length === 1));
// 摘要失敗 → 彈窗 → 手動寫 → 自動開始
await page.evaluate(async () => {
  const { setEntry } = await import('/src/chat.js');
  setEntry(8, null);
  window.__generateRaw = async () => { throw new Error('連不上'); };
});
pending = page.evaluate(() => window.__runInterceptor('normal'));
await page.waitForSelector('.lp-attention [data-attn="write"][data-index="8"]');
await page.click('[data-attn="write"][data-index="8"]');
await page.fill('[data-attn-text]', '小雨手寫的摘要');
await page.click('[data-attn="save"][data-index="8"]');
r = await pending;
check('failed auto summary → write in popup → generation continues', !r.aborted && await page.evaluate(() => window.__chat[8].extra.lovers_planner.summary === '小雨手寫的摘要'));
check('quiet generations never hold', await page.evaluate(async () => {
  const { setEntry } = await import('/src/chat.js');
  setEntry(8, null);
  const res = await Promise.race([window.__runInterceptor('quiet').then(() => 'done'), new Promise((ok) => setTimeout(() => ok('held'), 500))]);
  return res === 'done' && !document.querySelector('.lp-attention');
}));

// 之後的測試用會成功的假模型。
await page.evaluate(() => { window.__generateRaw = async () => '{"summary":"一般摘要","ops":[]}'; });

// 5c. 比對：中間少了幾則（例如 TauriTavern 拿掉工具回合、index 重新編號）也對得上
const robust = await page.evaluate(async () => {
  const core = window.__chat.filter((x) => !x.is_system).map((m, index) => ({ ...m, index }));
  core.splice(3, 1); // 拿掉一則，後面的 index 也跟著亂掉
  core.forEach((m, i) => { m.index = i; });
  const { mapToChat } = await import('/src/hide.js');
  return mapToChat(core)?.join();
});
check('mapping survives filtered/renumbered copies', robust === '0,1,2,4,5,6,7,8,9', robust);

// 6. swipe：正在重新生成的那層不算進「最新 2 層」
await page.evaluate(() => { window.__chat.push({ name: '沈言', is_user: false, mes: 'AI10', send_date: 'd10', extra: {} }); });
r = await run('swipe');
check('swipe keeps the right window', r.kept.join() === 'd5,d6,d7,d8,d9', r.kept.join());
await page.evaluate(() => { window.__chat.pop(); });

// 7. 其他注入位置
await page.evaluate(() => { window.__extSettings.lovers_planner.inject.position = 'in_prompt'; });
r = await run('normal');
check('in_prompt position', r.injection.position === 0);
await page.evaluate(() => { const s = window.__extSettings.lovers_planner.inject; s.position = 'in_chat'; s.depth = 2; });
r = await run('normal');
check('in_chat uses configured depth', r.injection.position === 1 && r.injection.depth === 2);
await page.evaluate(() => { window.__extSettings.lovers_planner.inject.position = 'before_recent'; });

// 8. 對不上聊天索引時：寧可不隱藏也不藏錯
const safe = await page.evaluate(async () => {
  const core = window.__chat.filter((x) => !x.is_system).map((m, index) => ({ ...m, index }));
  core[3] = { ...core[3], send_date: 'other' };
  await globalThis.loversPlannerInterceptor(core, 8000, () => {}, 'normal');
  return { n: core.length, inj: window.__extPrompts.lovers_planner.value };
});
check('mismatch → nothing hidden, nothing injected', safe.n === 10 && safe.inj === '');
check('mismatch reason recorded', await page.evaluate(async () => (await import('/src/hide.js')).getLastStats().reason === 'mismatch'));

// 9. 關掉插件 → 不隱藏、注入清空
await page.evaluate(() => { window.__extSettings.lovers_planner.enabled = false; });
r = await run('normal');
check('disabled: nothing hidden', r.kept.length === 10 && r.injection.value === '');
await page.evaluate(() => { window.__extSettings.lovers_planner.enabled = true; });

// 10. 只有 2 個 AI 樓層時什麼都不藏
const few = await page.evaluate(async () => {
  const keep = window.__chat.splice(3);
  const core = window.__chat.filter((x) => !x.is_system).map((m, index) => ({ ...m, index }));
  await globalThis.loversPlannerInterceptor(core, 8000, () => {}, 'normal');
  window.__chat.push(...keep);
  return core.length;
});
check('only 2 AI floors: nothing hidden', few === 3);

// 11. 送出預覽：各部分的 token
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="summary"]');
await page.click('details[data-preview] > summary');
await page.waitForSelector('.lp-preview-row');
const rows = await page.$$eval('.lp-preview-row', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
check('preview rows: summaries, four note kinds, total, saved', rows.length === 7 && rows[0].startsWith('單層摘要') && rows[2].startsWith('物件（') && rows[6].startsWith('不送出的原文'), JSON.stringify(rows));
check('preview line', (await page.textContent('[data-role="preview-line"]')).includes('tokens'));
const injected = await page.evaluate(() => window.__runInterceptor('normal'));
await page.click('.lp-preview-raw > summary');
check('preview text equals what gets injected', (await page.textContent('.lp-preview-text')) === injected.injection.value);
await page.screenshot({ path: `${OUT}/hide-2-preview.png` });

console.log(results.join('\n'));
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
