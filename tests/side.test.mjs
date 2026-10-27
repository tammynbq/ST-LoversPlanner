// ⭐ 小劇場（v0.13.15）：不寫進正劇摘要、原文不送，但讀一次記下回憶和約定（只新增）；
// 👻 跳過照舊；取消會換回原本的摘要；失敗也照樣不送；多選；壓成一章時可以夾在中間。
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
for (let i = 0; i < 14; i++) {
  const ai = i % 2 === 1;
  CHAT.push({ name: ai ? '白起' : '米米', is_user: !ai, mes: i === 3 ? '【小劇場】穿越到古代，白起是將軍。約好下次一起去看花燈。' : `${ai ? 'AI' : 'U'}${i} 今天也在一起`, send_date: `d${i}`, extra: {} });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, recall: { notes: false, memory: false }, compress: { auto: false } } };
}, CHAT);
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

await page.evaluate(() => {
  window.__generateRaw = async ({ prompt }) => {
    if (prompt.includes('小劇場（番外')) {
      return JSON.stringify({
        summary: '穿越古代的小劇場',
        keepsakes: [{ title: '將軍與花燈', content: '白起在古代當將軍，約好一起看花燈。' }],
        ops: [
          { op: 'add', type: 'promise', data: { title: '看花燈', content: '一起去看花燈', with: '米米' } },
          { op: 'add', type: 'character', data: { name: '古代將軍白起' } },
          { op: 'update', id: 'c1', data: { status: '在古代' } },
        ],
      });
    }
    const m = prompt.match(/AI(\d+) 今天/);
    return JSON.stringify({ summary: `正劇${m ? m[1] : '?'}`, ops: [] });
  };
});
const idle = () => page.evaluate(async () => {
  const { pendingCount } = await import('/src/summarize.js');
  const t0 = Date.now();
  while (pendingCount() && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 50));
});
const entry = (i) => page.evaluate(async (i) => (await import('/src/chat.js')).getEntry(i), i);
const status = (i) => page.evaluate(async (i) => (await import('/src/chat.js')).floorStatus(i), i);

// 先把幾層摘要好（第 3 層先當正劇摘要）
await page.evaluate(async () => {
  const { enqueue } = await import('/src/summarize.js');
  for (const i of [1, 3, 5, 7]) enqueue(i);
});
await idle();
check('floor 3 summarized normally first', (await entry(3))?.summary?.startsWith('正劇') || (await entry(3))?.status === 'ok', JSON.stringify(await entry(3)));
const before3 = (await entry(3)).summary;

// 摘要區塊的按鈕
await page.evaluate(() => document.querySelector('.mes[mesid="3"] [data-lp-act="toggle"]')?.click());
const btns = await page.evaluate(() => [...document.querySelectorAll('.mes[mesid="3"] .lp-sum-actions button')].map((b) => b.textContent));
check('ghost and star buttons', btns.includes('👻 跳過') && btns.includes('⭐ 小劇場') && btns.includes('💝 收藏成回憶'), JSON.stringify(btns));

// ⭐ 小劇場
await page.evaluate(() => { window.__prompts.length = 0; });
await page.evaluate(() => document.querySelector('.mes[mesid="3"] [data-lp-act="side"]')?.click());
check('raw hidden right away while queued', await page.evaluate(async () => (await import('/src/chat.js')).floorStatus(3) === 'side'));
await idle();
const e3 = await entry(3);
check('side entry', e3.status === 'side' && e3.summary === '穿越古代的小劇場' && e3.prev?.summary === before3, JSON.stringify(e3));
check('only new promise kept', e3.ops.length === 1 && e3.ops[0].op === 'add' && e3.ops[0].type === 'promise', JSON.stringify(e3.ops));
check('keepsake marked as side scene', e3.keepsakes.length === 1 && e3.keepsakes[0].theater === true);
const prompt = await page.evaluate(() => window.__prompts[0]?.prompt ?? '');
check('side prompt', prompt.includes('小劇場（番外') && prompt.includes('不是正劇') && !prompt.includes('location：'), prompt.slice(0, 200));
check('call logged as side scene', await page.evaluate(async () => (await import('/src/usage.js')).recentUsage(1)[0]?.purpose === 'side'));

const notes = await page.evaluate(async () => {
  const { getNotes } = await import('/src/notes.js');
  const { listMemories } = await import('/src/memories.js');
  return { promises: [...getNotes().notes.values()].filter((n) => n.type === 'promise').map((n) => n.data.title), mem: listMemories().map((m) => ({ t: m.title, theater: m.theater })) };
});
check('promise recorded', notes.promises.includes('看花燈'), JSON.stringify(notes));
check('memory recorded with side-scene badge', notes.mem.some((m) => m.t === '將軍與花燈' && m.theater), JSON.stringify(notes.mem));

// 送出時：原文不送，小劇場的說明也不送
let r = await page.evaluate(() => window.__runInterceptor('normal'));
check('raw not sent', !r.kept.includes('d3'), JSON.stringify(r.kept));
check('side summary not injected', !r.injection.value.includes('穿越古代') && r.injection.value.includes('正劇1'), r.injection.value.slice(0, 300));

// 畫面
await page.evaluate(() => document.querySelector('.mes[mesid="3"] [data-lp-act="toggle"]')?.click());
await page.evaluate(() => document.querySelector('.mes[mesid="3"] [data-lp-act="toggle"]')?.click());
const block = await page.textContent('.mes[mesid="3"] .lp-sum');
check('block shows side state', block.includes('⭐ 小劇場') && block.includes('穿越古代的小劇場') && block.includes('取消小劇場') && block.includes('重新讀小劇場'), block.replace(/\s+/g, ' ').slice(0, 300));
await page.screenshot({ path: `${OUT}/side.png` });

// 取消 → 換回原本的摘要
await page.evaluate(async () => (await import('/src/summarize.js')).unsideFloor(3));
check('unside restores summary', (await entry(3)).status === 'ok' && (await entry(3)).summary === before3);

// 跳過 → 小劇場 → 取消：還是原本的摘要
await page.evaluate(async () => { const s = await import('/src/summarize.js'); s.skipFloor(3); s.sideFloor(3); });
await idle();
check('skip then side keeps original', (await entry(3)).prev?.summary === before3);
await page.evaluate(async () => (await import('/src/summarize.js')).unsideFloor(3));
check('…and back to it', (await entry(3)).summary === before3);

// 失敗：照樣不送
await page.evaluate(async () => { window.__generateRaw = async () => ''; (await import('/src/summarize.js')).sideFloor(5); });
await idle();
const e5 = await entry(5);
check('failed side still side', e5.status === 'side' && e5.error, JSON.stringify(e5));
r = await page.evaluate(() => window.__runInterceptor('normal'));
check('failed side not sent', !r.kept.includes('d5'));
await page.evaluate(() => document.querySelector('.mes[mesid="5"] [data-lp-act="toggle"]')?.click());
check('fail hint', (await page.textContent('.mes[mesid="5"] .lp-sum')).includes('讀取失敗'));

// 壓成一章：中間夾著小劇場可以
const manual = await page.evaluate(async () => (await import('/src/compress.js')).checkManualChapter([1, 7]));
check('side floors allowed in a gap', manual.error === 'gap'); // 3 是 ok，沒選到
const manual2 = await page.evaluate(async () => (await import('/src/compress.js')).checkManualChapter([3, 7]));
check('side floor 5 skipped over', Array.isArray(manual2.floors) && manual2.floors.join() === '3,7', JSON.stringify(manual2));

// 多選
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="summary"]');
check('side filter chip', (await page.textContent('[data-filter="side"]')).includes('⭐ 小劇場 1'));
await page.click('[data-action="sum-select"]');
await page.click('[data-action="sum-pick"][data-index="9"]');
await page.click('[data-action="bulk-side"]');
await idle();
check('bulk side', (await status(9)) === 'side');
if (!(await page.isVisible('[data-role="bulk"]'))) await page.click('[data-action="sum-select"]');
await page.click('[data-action="sum-pick"][data-index="9"]');
await page.click('[data-action="bulk-unside"]');
await idle();
check('bulk unside', (await status(9)) === 'none');

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
