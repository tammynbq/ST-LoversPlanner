// 長聊天壓力測試（不是一般測試）：N 則訊息（預設 3200，每則約 LEN=4000 字＋狀態欄），每 10 層一章、每 5 章一卷，量各種計算和分頁打開的時間。
// PORT=8815 N=3200 LEN=4000 node tests/perf.mjs；EACH=1 印出換聊天時每個處理函式的時間；PROFILE=1（打開聊天）或 PROFILE=send（送出）印出最花時間的函式。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));
const N = Number(process.env.N ?? 3200);
const LEN = Number(process.env.LEN ?? 4000); // 每則 AI 回覆大約幾個字（真實聊天常常幾千字，含狀態欄）
const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 390, height: 844 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(({ N, LEN }) => {
  const chat = [];
  const body = '今天兩個人一起吃晚餐，聊了很多工作上的事情，也約好週末去看海。他把外套披在她肩上，雨停了。';
  for (let i = 0; i < N; i++) {
    const ai = i % 2 === 1;
    const mes = ai ? `AI${i} ` + body.repeat(Math.ceil(LEN / body.length)).slice(0, LEN) + '\n<status>時間：晚上｜地點：家｜心情：開心</status>' : `U${i} 嗯嗯，我們走吧。`;
    chat.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes, send_date: `d${i}`, extra: {} });
  }
  window.__chat = chat;
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, compress: { auto: false }, recall: { notes: false, memory: false }, calendar: { enabled: true, track: { period: true, intimacy: true, anniversary: true } } } };
}, { N, LEN });
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
  // 每 10 層一章、每 5 章一卷（像真的壓縮過的長聊天），最新 200 層不壓
  const meta = SillyTavern.getContext().chatMetadata;
  const chapters = []; const volumes = [];
  const ais = []; for (let i = 1; i < chat.length - 400; i += 2) ais.push(i);
  for (let c = 0; c * 10 + 10 <= ais.length; c++) {
    const idx = ais.slice(c * 10, c * 10 + 10);
    chapters.push({ id: `ch${c}`, members: idx.map((i) => chat[i].send_date), memberIdx: idx, memberAts: idx, time: '晚上', location: '家', summary: `第${c}章的總結。`.repeat(8), status: 'ok', at: 10000 + c });
  }
  for (let v = 0; v * 5 + 5 <= chapters.length; v++) {
    const ch = chapters.slice(v * 5, v * 5 + 5);
    volumes.push({ id: `v${v}`, level: 3, chapterIds: ch.map((x) => x.id), chapterAts: ch.map((x) => x.at), summary: `第${v}卷。`.repeat(10), status: 'ok', at: 20000 + v });
  }
  meta.lovers_planner = { ...(meta.lovers_planner ?? {}), chapters, volumes };
  (await import('/src/notes.js')).invalidateNotes();
  return Math.round(performance.now() - t0);
});
const time = (label, fn) => page.evaluate(fn).then((ms) => console.log(label.padEnd(36), `${ms} ms`));
console.log(`messages: ${N}, ~${LEN} chars each, setup ${setup} ms`);
const each = await page.evaluate(async () => {
  const out = [];
  for (const f of window.__events['chat_id_changed'] ?? []) { const t = performance.now(); await f(); out.push([String(f).slice(0, 70).replace(/\s+/g, ' '), Math.round(performance.now() - t)]); }
  return out;
});
if (process.env.EACH) for (const [f, ms] of each) console.log(`  handler ${ms} ms :: ${f}`);
if (process.env.PROFILE) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start');
  await page.evaluate(async (what) => {
    if (what === 'send') { await window.__runInterceptor('normal'); await window.__runInterceptor('normal'); }
    else { await window.__emit('chat_id_changed'); await new Promise((r) => setTimeout(r, 2500)); }
  }, process.env.PROFILE);
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map(); const dt = profile.timeDeltas; const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  profile.samples.forEach((id, k) => { const n = byId.get(id); const f = n.callFrame; const key = `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`; self.set(key, (self.get(key) ?? 0) + (dt[k] ?? 0) / 1000); });
  console.log('--- top self time (ms) during chat open ---');
  for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(String(Math.round(v)).padStart(6), k);
}
await time('open chat (chat_id_changed)', async () => { const t = performance.now(); await window.__emit('chat_id_changed'); await new Promise((r) => setTimeout(r, 0)); return Math.round(performance.now() - t); });
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
