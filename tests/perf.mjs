// 長聊天壓力測試（不是一般測試）：N 則訊息（預設 3200）都摘要好，量各種計算和分頁打開的時間。PORT=8815 N=3200 node tests/perf.mjs
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));
const N = Number(process.env.N ?? 3200);
const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 390, height: 844 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript((N) => {
  const chat = [];
  for (let i = 0; i < N; i++) { const ai = i % 2 === 1; chat.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i} 今天兩個人一起吃晚餐，聊了很多工作上的事情，也約好週末去看海。`.repeat(3), send_date: `d${i}`, extra: {} }); }
  window.__chat = chat;
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, compress: { auto: false }, recall: { notes: false, memory: false }, calendar: { enabled: true, track: { period: true, intimacy: true, anniversary: true } } } };
}, N);
await page.goto(`http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`);
await page.waitForFunction(() => Boolean(globalThis.loversPlannerInterceptor), null, { timeout: 60000 });
const setup = await page.evaluate(async () => {
  const t0 = performance.now();
  const { floorSource, setEntry } = await import('/src/chat.js');
  const chat = window.__chat;
  let k = 0;
  for (let i = 1; i < chat.length; i += 2) {
    k++;
    const ops = [];
    if (k % 10 === 1) ops.push({ op: 'add', id: `c${k}`, type: 'character', data: { name: `人物${k % 40}`, status: '在家' } });
    if (k % 7 === 0) ops.push({ op: 'add', id: `p${k}`, type: 'promise', data: { title: `約定${k}`, content: `第${k}個約定`, due: '2025-04-01' } });
    if (k % 7 === 3 && k > 7) ops.push({ op: 'complete', id: `p${k - 3}`, result: 'kept', detail: '做到了' });
    if (k % 5 === 0) ops.push({ op: 'update', id: `c${k - 4}`, data: { status: `狀態${k}` } });
    setEntry(i, { v: 2, status: 'ok', time: '晚上', location: '家', characters: ['沈言'], summary: `第${i}層：兩人吃晚餐，聊工作，約好週末看海。`, ops, hash: floorSource(i).hash, at: i,
      date: `2025-0${1 + (k % 9)}-1${k % 9}`, events: k % 13 === 0 ? [{ type: 'intimacy', count: 1 }] : [], keepsakes: k % 50 === 0 ? [{ title: `回憶${k}`, content: '很重要的時刻' }] : [] });
  }
  (await import('/src/notes.js')).invalidateNotes();
  return Math.round(performance.now() - t0);
});
const time = (label, fn) => page.evaluate(fn).then((ms) => console.log(label.padEnd(36), `${ms} ms`));
console.log(`floors: ${N}, setup ${setup} ms`);
await time('replay notes (cold)', async () => { const n = await import('/src/notes.js'); n.invalidateNotes(); const t = performance.now(); n.getNotes(); return Math.round(performance.now() - t); });
await time('structure()', async () => { const c = await import('/src/compress.js'); const t = performance.now(); c.structure(); return Math.round(performance.now() - t); });
await time('buildCalendar()', async () => { const c = await import('/src/calendar.js'); const t = performance.now(); c.buildCalendar(); return Math.round(performance.now() - t); });
await time('listMemories()', async () => { const c = await import('/src/memories.js'); const t = performance.now(); c.listMemories(); return Math.round(performance.now() - t); });
await time('runChecks()', async () => { const c = await import('/src/check.js'); const t = performance.now(); c.runChecks(); return Math.round(performance.now() - t); });
await time('interceptor (send)', async () => { const t = performance.now(); await window.__runInterceptor('normal'); return Math.round(performance.now() - t); });
await time('renderAllBlocks()', async () => { const m = await import('/src/ui/message.js'); const t = performance.now(); m.renderAllBlocks(); return Math.round(performance.now() - t); });
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
for (const tab of ['summary', 'characters', 'notes', 'memories', 'done', 'settings']) {
  const ms = await page.evaluate(async (tab) => {
    if (!document.querySelector('.lp-panel')) document.getElementById('lp_wand_entry').click();
    const t = performance.now();
    document.querySelector(`[data-tab="${tab}"]`).click();
    return Math.round(performance.now() - t);
  }, tab);
  console.log(`open tab ${tab}`.padEnd(36), `${ms} ms`);
}
const ms = await page.evaluate(() => { const t = performance.now(); document.querySelector('[data-action="check-toggle"]').click(); return Math.round(performance.now() - t); });
console.log('open 🩺 checkup'.padEnd(36), `${ms} ms`);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await b.close();
