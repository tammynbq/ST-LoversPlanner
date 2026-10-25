// L2／L3 分層壓縮：到期壓縮、注入順序、過期與重新壓縮、生成前先壓好、摘要分頁的卷→章→各層。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

// 15 個 AI 樓層（索引 0,2,…,28）＋最後一句使用者發言（29）。
const CHAT = [];
for (let i = 0; i < 30; i++) {
  const ai = i % 2 === 0;
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i}`, send_date: `d${i}`, extra: {} });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__presetSettings = { lovers_planner: { settingsVersion: 3, compress: { auto: true, l1PerL2: 3, l2PerL3: 2, ratioMin: 30, ratioMax: 40 } } };
}, CHAT);
await page.goto(URL);
await page.waitForFunction(() => document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor);

// 所有 AI 樓層先有單層摘要。假模型：章節總結回「章N」，卷總結回「卷N」。
await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  for (let i = 0; i < 30; i += 2) setEntry(i, { v: 2, status: 'ok', time: `第${i}天`, location: '山門', characters: [], summary: `L1-${i}`, ops: [], hash: floorSource(i).hash, at: 1000 + i });
  window.__l2 = 0; window.__l3 = 0;
  window.__generateRaw = async ({ prompt }) => {
    if (prompt.includes('卷總結')) { window.__lastL3 = prompt; return `卷${++window.__l3}`; }
    if (prompt.includes('章節總結')) { window.__lastL2 = prompt; return `章${++window.__l2}`; }
    return '{"summary":"新的單層摘要","ops":[]}';
  };
  await window.__emit('chat_id_changed');
});
const S = () => page.evaluate(async () => {
  const c = await import('/src/compress.js');
  const st = c.structure();
  return { chapters: st.chapters.map((x) => ({ n: x.number, state: x.state, idx: x.indices.join(','), summary: x.data.summary })), volumes: st.volumes.map((v) => ({ n: v.number, state: v.state, ch: v.chapters.map((x) => x.number).join(','), summary: v.data.summary })) };
});
const compressNow = () => page.evaluate(async () => {
  const s = await import('/src/summarize.js');
  s.enqueueCompress();
  await s.waitForIdle();
});

// 1. 壓縮：13 層隱藏中 → 4 章（每章 3 層）＋ 1 層未壓縮；4 章 → 2 卷
check('compression due', await page.evaluate(async () => (await import('/src/compress.js')).compressionDue()));
await compressNow();
let st = await S();
check('4 chapters of 3 floors', st.chapters.length === 4 && st.chapters.every((c) => c.state === 'ok' && c.idx.split(',').length === 3) && st.chapters[0].idx === '0,2,4', JSON.stringify(st.chapters));
check('2 volumes of 2 chapters', st.volumes.length === 2 && st.volumes[0].ch === '1,2' && st.volumes[1].ch === '3,4', JSON.stringify(st.volumes));
check('L2 prompt has floor lines + length', await page.evaluate(() => /［第18天｜山門］L1-18/.test(window.__lastL2) && /約 \d+ 字/.test(window.__lastL2)));
check('L3 prompt lists chapters', await page.evaluate(() => window.__lastL3.includes('第 3 章') && window.__lastL3.includes('章3')));
check('nothing more due', !(await page.evaluate(async () => (await import('/src/compress.js')).compressionDue())));

// 2. 注入：卷 → 未壓縮的單層，依故事順序；章和被涵蓋的單層不重複
let r = await page.evaluate(() => window.__runInterceptor('normal'));
let v = r.injection.value;
check('injection uses volumes + loose floor', v.includes('［第 1 卷｜第0天 → 第10天｜山門］卷1') && v.includes('卷2') && v.includes('L1-24') && !v.includes('章1') && !v.includes('L1-0'), v);
check('injection in story order', v.indexOf('卷1') < v.indexOf('卷2') && v.indexOf('卷2') < v.indexOf('L1-24'));

// 3. 改了第 1 章裡的一層 → 第 1 章、第 1 卷過期；改送第 2 章總結＋第 1 章各層的單層摘要
await page.evaluate(async () => { (await import('/src/summarize.js')).writeSummary(2, { summary: '改過的 L1-2' }); });
st = await S();
check('chapter 1 and volume 1 stale', st.chapters[0].state === 'stale' && st.volumes[0].state === 'stale' && st.volumes[1].state === 'ok');
r = await page.evaluate(() => window.__runInterceptor('normal'));
v = r.injection.value;
check('stale: falls back to chapter 2 + floors of chapter 1', v.includes('第 2 章') && v.includes('改過的 L1-2') && v.includes('L1-0') && !v.includes('卷1') && v.includes('卷2'), v);

// 4. 大視窗：卷 → 章 → 各層；重新壓縮過期的章和卷
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
const heads = await page.$$eval('.lp-group-head .lp-group-title', (h) => h.map((x) => x.textContent));
check('tree: loose group + 2 volumes (newest first)', heads.join() === '未壓縮,第 2 卷,第 1 卷', heads.join());
const groups = await page.$$eval('.lp-group-head', (h) => h.map((x) => x.dataset.group));
await page.click(`[data-group="${groups[2]}"]`);
check('volume shows its digest with stale hint', (await page.textContent('.lp-group-body .lp-digest')).includes('改過了'));
const chapterHeads = await page.$$eval('.lp-group-body .lp-group-head .lp-group-title', (h) => h.map((x) => x.textContent));
check('volume 1 contains chapters 2 and 1', chapterHeads.join() === '第 2 章,第 1 章', chapterHeads.join());
const ch1Id = await page.evaluate(async () => (await import('/src/compress.js')).structure().chapters[0].data.id);
await page.click(`[data-group="${ch1Id}"]`);
check('chapter shows stale hint and its floors', (await page.textContent('.lp-group-body .lp-group-body')).includes('改過了') && (await page.$$('.lp-group-body .lp-group-body .lp-floor-row')).length === 3);
await page.screenshot({ path: `${OUT}/compress-1-tree.png` });
await page.click(`[data-action="digest-redo"][data-id="${ch1Id}"]`);
await page.evaluate(async () => { await (await import('/src/summarize.js')).waitForIdle(); });
st = await S();
check('redo chapter → ok, volume still stale', st.chapters[0].state === 'ok' && st.volumes[0].state === 'stale');
const vol1Id = await page.evaluate(async () => (await import('/src/compress.js')).structure().volumes[0].data.id);
await page.click(`[data-action="digest-redo"][data-id="${vol1Id}"]`);
await page.evaluate(async () => { await (await import('/src/summarize.js')).waitForIdle(); });
st = await S();
check('redo volume → ok', st.volumes[0].state === 'ok');

// 5. 手動編輯章節總結
await page.click(`[data-action="digest-edit"][data-id="${ch1Id}"]`);
await page.fill('[data-digest-text]', '我自己寫的第一章');
await page.click('[data-action="digest-save"]');
st = await S();
check('edit chapter summary', st.chapters[0].summary === '我自己寫的第一章' && st.volumes[0].state === 'stale', JSON.stringify(st));
await page.keyboard.press('Escape');

// 6. 送出預覽分開列卷、章、單層
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('details[data-preview] > summary');
await page.waitForSelector('.lp-preview-row');
const prow = await page.$$eval('.lp-preview-row', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
check('preview lists volumes, chapters, floors', prow[0].startsWith('卷以上的總結（1 份）') && prow[1].startsWith('章節總結（2 章）') && prow[2].startsWith('單層摘要（1 層）'), JSON.stringify(prow.slice(0, 3)));
await page.keyboard.press('Escape');

// 7. 生成前先壓好：拿掉所有章和卷，送出時攔截器先壓縮完才注入
await page.evaluate(() => { const r = window.__chatMetadata.lovers_planner; r.chapters = []; r.volumes = []; window.__l2 = 0; window.__l3 = 0; });
r = await page.evaluate(() => window.__runInterceptor('normal'));
check('compress before generating', r.injection.value.includes('卷1') && r.injection.value.includes('卷2'), r.injection.value.slice(0, 200));

// 8. 關掉自動壓縮：拿掉後不會自己壓
await page.evaluate(() => { const r = window.__chatMetadata.lovers_planner; r.chapters = []; r.volumes = []; window.__extSettings.lovers_planner.compress.auto = false; });
r = await page.evaluate(() => window.__runInterceptor('normal'));
check('auto off: no compression, floors injected', !r.injection.value.includes('卷') && r.injection.value.includes('L1-0'));

// 9. 一層摘要好之後自動檢查（auto 開）
await page.evaluate(() => { window.__extSettings.lovers_planner.compress.auto = true; });
await page.evaluate(async () => {
  const s = await import('/src/summarize.js');
  s.enqueue(26, { front: true });
  await s.waitForIdle();
});
st = await S();
check('auto compression after a floor summary', st.chapters.length === 4 && st.volumes.length === 2);

// 10. 刪掉章裡的訊息 → 那一章過期，重新壓縮時用剩下的
await page.evaluate(async () => { window.__chat.splice(0, 2); await window.__emit('message_deleted', 28); });
st = await S();
check('deleted member → stale', st.chapters[0].state === 'stale', JSON.stringify(st.chapters[0]));

console.log(results.join('\n'));
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
