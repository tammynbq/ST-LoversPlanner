// 補建舊樓層：預估、舊的粗（整段寫成一章）＋新的細、出錯暫停、回來問要不要繼續、改成逐層細摘、章過期時不藏原文。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = "") => { const l = `${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`; results.push(l); if (process.env.LIVE) console.error(l); };

// 40 個 AI 樓層（1,3,…,79），前面各有一句使用者發言。
const CHAT = [];
for (let i = 0; i < 80; i++) {
  const ai = i % 2 === 1;
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i} 今天也在山門練劍。`, send_date: `d${i}`, extra: {} });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__presetSettings = { lovers_planner: { settingsVersion: 4, recall: { notes: false } } };
  // 假的 toastr：把通知放進頁面，按鈕才點得到。
  const make = (html) => {
    const el = document.createElement('div');
    el.className = 'fake-toast';
    el.innerHTML = html;
    document.body.appendChild(el);
    return { 0: el, remove: () => el.remove() };
  };
  window.toastr = { info: make, success: make, error: make, warning: make };
}, CHAT);
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

await page.evaluate(() => {
  window.__coarseCalls = 0;
  window.__failCoarse = 0; // 第幾次粗略呼叫要失敗（0＝不失敗）
  window.__generateRaw = async ({ prompt }) => {
    if (prompt.includes('舊對話')) {
      const n = ++window.__coarseCalls;
      if (n === window.__failCoarse) throw new Error('連線中斷');
      const ops = n === 1 ? [{ op: 'add', type: 'character', data: { name: '林曉', relation: '師妹' } }] : [];
      return JSON.stringify({ time: `第${n}天 → 第${n + 2}天`, location: '山門', characters: ['林曉'], summary: `粗章${n}`, ops });
    }
    if (prompt.includes('章節總結')) return '一般的章';
    return JSON.stringify({ summary: '細摘', ops: [] });
  };
});
const openPanel = async (tab) => {
  await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
  await page.click('#lp_wand_entry');
  if (tab) await page.click(`[data-tab="${tab}"]`);
};
const idle = async () => {
  // 連續兩次看到佇列是空的才算（兩個工作之間會有一瞬間是空的）。
  let quiet = 0;
  for (let k = 0; k < 200 && quiet < 2; k++) {
    await new Promise((r) => setTimeout(r, 100));
    const n = await page.evaluate(async () => (await import('/src/summarize.js')).pendingCount());
    quiet = n === 0 ? quiet + 1 : 0;
  }
};
const state = () => page.evaluate(async () => {
  const { getChapters } = await import('/src/compress.js');
  const { getCatchup, remaining } = await import('/src/catchup.js');
  const entries = window.__chat.map((m) => m.extra?.lovers_planner ?? null);
  return { chapters: getChapters(), catchup: getCatchup(), remaining: remaining(), entries };
});

// ===== 1. 設定卡片和預估 =====
await openPanel('summary');
check('button counts floors', (await page.textContent('[data-action="backfill-ask"]')).includes('39 層'));
await page.click('[data-action="backfill-ask"]');
await page.fill('[data-cu="fine"]', '5');
await page.fill('[data-cu="block"]', '10');
const est = await page.textContent('[data-role="cu-estimate"]');
check('estimate: 4 rough chapters + 5 floors = 9 calls', est.includes('4 章粗略') && est.includes('5 層細摘') && est.includes('共約 9 次'), est);
check('main API warning', await page.isVisible('[data-role="catchup"] .lp-warn'));
await page.screenshot({ path: `${OUT}/catchup-card.png` });

// ===== 2. 出錯就暫停 =====
await page.evaluate(() => { window.__failCoarse = 2; });
await page.click('[data-action="backfill-yes"]');
await idle();
let s = await state();
check('paused on error', s.catchup?.paused === true && s.catchup.error.includes('連線中斷'), JSON.stringify(s.catchup));
check('first block done before the error', s.chapters.length === 1 && s.chapters[0].coarse && s.chapters[0].summary === '粗章1');
check('later work not started', s.remaining === 29, String(s.remaining));
await page.waitForSelector('[data-role="catchup-paused"]');
check('paused banner', (await page.textContent('[data-role="catchup-paused"]')).includes('10／39'));

// ===== 3. 回到聊天時問要不要繼續 =====
await page.keyboard.press('Escape');
await page.evaluate(async () => {
  document.querySelectorAll('.fake-toast').forEach((x) => x.remove());
  window.__failCoarse = 0;
  await window.__emit('chat_id_changed');
});
await page.waitForSelector('.fake-toast .lp-toast-btn', { timeout: 3000 });
check('resume question shown', (await page.textContent('.fake-toast')).includes('10／39'));
await page.click('.fake-toast .lp-toast-btn.lp-primary');
await idle();
s = await state();
check('catch-up finished and record cleared', !s.catchup && s.remaining === 0, JSON.stringify({ c: s.catchup, left: s.remaining, e77: s.entries[77] }));
const coarse = s.chapters.filter((c) => c.coarse);
check('4 rough chapters', coarse.length === 4 && coarse.map((c) => c.memberIdx.length).join() === '10,10,10,4', coarse.map((c) => c.memberIdx.length).join());
check('chapter time is a range', coarse[0].time === '第1天 → 第3天', coarse[0].time);
const fineFloors = s.entries.map((e, i) => (e && !e.coarse && e.status === 'ok' ? i : -1)).filter((i) => i >= 0);
check('latest 5 floors summarized one by one', fineFloors.join() === '69,71,73,75,77', fineFloors.join());
check('latest floor left for "before" mode', !s.entries[79]);
check('rough floors have no own summary', s.entries[1].coarse && s.entries[1].summary === '' && s.entries[1].time === '第3天');
check('block notes stored on the last floor of the block', s.entries[19].ops?.[0]?.block === true && !s.entries[1].ops.length);
check('done toast', (await page.textContent('body')).includes('補建完成'));

// ===== 4. 注入 =====
let r = await page.evaluate(() => window.__runInterceptor('normal'));
check('rough floors hidden', r.kept.length < 10, r.kept.join());
check('rough chapters injected', r.injection.value.includes('粗章1') && r.injection.value.includes('粗章4'));
check('notes from rough blocks', r.injection.value.includes('林曉'));

// ===== 5. 畫面 =====
await openPanel('summary');
await page.evaluate(async () => (await import('/src/ui/message.js')).renderAllBlocks());
const hint = await page.evaluate(() => document.querySelector('.mes[mesid="1"] .lp-sum')?.textContent ?? '');
check('message block says rough', hint.includes('粗略補建'), hint);
await page.evaluate(() => document.querySelector('.mes[mesid="1"] [data-lp-act="toggle"]')?.click());
check('no per-floor actions on rough floors', await page.evaluate(() => Boolean(document.querySelector('.mes[mesid="1"] .lp-sum-text, .mes[mesid="1"] .lp-sum-hint')) && !document.querySelector('.mes[mesid="1"] [data-lp-act="redo"], .mes[mesid="1"] [data-lp-act="skip"], .mes[mesid="1"] [data-lp-act="edit"]')));
await page.screenshot({ path: `${OUT}/catchup-done.png` });

// ===== 6. 章過期時，那幾層照送原文（不會藏了卻沒內容） =====
await page.keyboard.press('Escape');
await page.evaluate(() => { window.__chat[41].mes += '（改過）'; });
// 'quiet' 不會跳「過期樓層」的彈窗（這裡只看隱藏範圍）。
r = await page.evaluate(() => window.__runInterceptor('quiet'));
check('floors of a stale rough chapter are sent raw', r.kept.includes('d43') && r.kept.includes('d59') && !r.kept.includes('d21'), r.kept.join());
check('stale rough chapter not injected (call #2 failed, so the 3rd chapter is 粗章4)', !r.injection.value.includes('粗章4') && r.injection.value.includes('粗章5'), r.injection.value);

// ===== 7. 改成逐層細摘 =====
const firstId = coarse[0].id;
await openPanel('summary');
await page.click(`[data-group="${firstId}"]`).catch(() => {});
await page.evaluate((id) => {
  const b = document.querySelector(`[data-action="digest-refine"][data-id="${id}"]`);
  b?.click();
}, firstId);
await idle();
s = await state();
check('rough chapter removed', !s.chapters.some((c) => c.id === firstId));
check('its floors now have their own summaries', [1, 3, 19].every((i) => s.entries[i].summary === '細摘' && !s.entries[i].coarse), JSON.stringify([1, 3, 19].map((i) => s.entries[i])));
check('block notes kept after refining', s.entries[19].ops.some((op) => op.block && op.op === 'add'));
const notes = await page.evaluate(async () => [...(await import('/src/notes.js')).getNotes().notes.values()].map((n) => n.data.name));
check('character still there', notes.includes('林曉'), JSON.stringify(notes));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const line of results) console.log(line);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
