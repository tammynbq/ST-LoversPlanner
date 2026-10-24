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
check('injection has notes without ids', r.injection.value.includes('物件｜名稱：銀色手鍊') && !r.injection.value.includes('i_test01'));
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

// 4. 過期的樓層不隱藏、照送原文，並跳出強制彈窗
await page.evaluate(async () => { window.__chat[2].mes = 'AI2 被編輯過'; await window.__emit('message_edited', 2); });
r = await run('normal');
check('stale floor sent raw (with its user message)', r.kept.join() === 'd1,d2,d5,d6,d7,d8,d9', r.kept.join());
check('stale summary not injected', !r.injection.value.includes('第2層的摘要'));
await page.waitForSelector('.lp-attention');
check('popup lists the stale floor', (await page.textContent('.lp-attention')).includes('#2') && (await page.textContent('.lp-attention .lp-title')).includes('1 層'));
await page.screenshot({ path: `${OUT}/hide-1-popup.png` });
// 稍後再說 → 下次送出還會再跳
await page.click('[data-attn="later"]');
check('later closes popup', !(await page.isVisible('.lp-attention')));
await run('normal');
check('popup again on next send', await page.isVisible('.lp-attention'));
// 在彈窗裡跳過 → 下次送出就隱藏
await page.click('[data-attn="skip"][data-index="2"]');
check('popup shows skipped', (await page.textContent('.lp-attention')).includes('已跳過'));
r = await run('normal');
check('skipped floor now hidden, nothing injected for it', r.kept.join() === 'd5,d6,d7,d8,d9' && !r.injection.value.includes('第2層'), r.kept.join());
check('skipped floor notes dropped', !r.injection.value.includes('銀色手鍊'));
await page.click('[data-attn="later"]').catch(() => {});

// 5. 失敗的樓層 → 彈窗裡手動寫 → 隱藏
await page.evaluate(async () => {
  const { setEntry, floorSource } = await import('/src/chat.js');
  setEntry(4, { v: 2, status: 'fail', error: 'API 逾時', hash: floorSource(4).hash, summary: '' });
  await window.__emit('chat_id_changed');
});
r = await run('normal');
check('failed floor sent raw', r.kept.includes('d4') && r.kept.includes('d3'));
await page.waitForSelector('.lp-attention [data-attn="write"]');
check('popup shows error', (await page.textContent('.lp-attention')).includes('API 逾時'));
await page.click('[data-attn="write"][data-index="4"]');
await page.fill('[data-attn-text]', '小雨手寫的摘要');
await page.click('[data-attn="save"][data-index="4"]');
check('popup all done', (await page.textContent('.lp-attention .lp-title')).includes('都處理好了'));
r = await run('normal');
check('written floor hidden and injected', !r.kept.includes('d4') && r.injection.value.includes('小雨手寫的摘要'));
await page.click('[data-attn="later"]').catch(() => {});

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

console.log(results.join('\n'));
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
