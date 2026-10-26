// 無限層壓縮：L4 部、L5 紀、L6…；只送最上層有效的；各層上限；過期往下退；設定遷移。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

// 40 個 AI 樓層（0,2,…,78）＋最後一句使用者發言。
const CHAT = [];
for (let i = 0; i < 81; i++) {
  const ai = i % 2 === 0 && i < 80;
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i}`, send_date: `d${i}`, extra: {} });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  // 每 2 個往上壓一層，40 層就能壓到 L6。
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, recall: { notes: false, memory: false },
    compress: { auto: true, l1PerL2: 2, l2PerL3: 2, higherPer: 2, ratioMin: 30, ratioMax: 40, capL3: 200, capL4: 30, capL5: 500, capMore: 600 } } };
}, CHAT);
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  for (let i = 0; i < 80; i += 2) setEntry(i, { v: 2, status: 'ok', time: `第${i}天`, location: '山門', characters: [], summary: `L1-${i}`, ops: [], hash: floorSource(i).hash, at: 1000 + i });
  window.__n = 0;
  window.__lens = [];
  window.__generateRaw = async ({ prompt }) => {
    const len = prompt.match(/約 (\d+) 字/);
    if (prompt.includes('卷總結')) {
      window.__lens.push({ kind: prompt.includes('第 1 卷') || /［第 \d+ 卷/.test(prompt) ? 'higher' : 'vol', len: Number(len?.[1]), text: prompt });
      return `高層${++window.__n}`;
    }
    if (prompt.includes('章節總結')) return `章${++window.__n}`;
    return '{"summary":"x","ops":[]}';
  };
  await window.__emit('chat_id_changed');
});

// 生成一次：先把到期的全部壓好。
let r = await page.evaluate(() => window.__runInterceptor('normal'));
const st = await page.evaluate(async () => {
  const { structure } = await import('/src/compress.js');
  const s = structure();
  return { chapters: s.chapters.length, levels: s.volumes.map((v) => `${v.level}:${v.number}:${v.state}`), coveredVolumes: s.coveredVolumes.size };
});
const count = (lv) => st.levels.filter((x) => x.startsWith(`${lv}:`)).length;
check('chapters', st.chapters === 19, String(st.chapters));
check('L3 volumes', count(3) === 9, st.levels.join());
check('L4 parts', count(4) === 4, st.levels.join());
check('L5 eras', count(5) === 2, st.levels.join());
check('L6', count(6) === 1, st.levels.join());
check('no L7 (only one L6)', count(7) === 0);

const inj = r.injection.value;
check('top level injected', inj.includes('第 6 層・1'), inj);
check('covered levels not injected', !inj.includes('第 1 紀') && !inj.includes('第 1 部') && !inj.includes('第 1 卷') && !inj.includes('第 1 章'), inj);
check('leftovers at each level injected', inj.includes('第 9 卷') && inj.includes('第 19 章'), inj);
check('injection in story order', inj.indexOf('第 6 層・1') < inj.indexOf('第 9 卷') && inj.indexOf('第 9 卷') < inj.indexOf('第 19 章'), inj);

// 上限：L4 設成 30 tokens → 約 30 字
const higher = await page.evaluate(() => window.__lens.filter((x) => /［第 \d+ 卷/.test(x.text)).map((x) => x.len));
check('L4 length capped', higher.length > 0 && higher.every((n) => n <= 40), JSON.stringify(higher));

// 過期：第 0 層的摘要改了 → 第 1 章過期 → 它上面的卷、部、紀、L6 都失效，改送下面還有效的
await page.evaluate(async () => {
  const { writeSummary } = await import('/src/summarize.js');
  writeSummary(0, { summary: 'L1-0（改過）' });
  const s = SillyTavern.getContext().extensionSettings.lovers_planner;
  s.compress.auto = false; // 先不要自動重壓，看退回的樣子
});
r = await page.evaluate(() => window.__runInterceptor('normal'));
const inj2 = r.injection.value;
check('stale chain falls back', !inj2.includes('第 6 層・1') && inj2.includes('L1-0（改過）') && inj2.includes('第 2 章'), inj2);
check('valid siblings higher up still used', inj2.includes('第 2 紀') || inj2.includes('第 2 部'), inj2);

// 重新壓縮最上層：先修好第 1 章，再一路往上
await page.evaluate(async () => {
  const { structure, runCompression } = await import('/src/compress.js');
  const ch1 = structure().chapters[0];
  await runCompression(ch1.data.id);
  for (let lv = 3; lv <= 6; lv++) {
    const v = structure().volumes.find((x) => x.level === lv && x.number === 1);
    await runCompression(v.data.id);
  }
});
r = await page.evaluate(() => window.__runInterceptor('normal'));
check('recompressed chain back to top', r.injection.value.includes('第 6 層・1') && !r.injection.value.includes('第 2 章'), r.injection.value);

// 摘要分頁：最上層一個群組，點開一層一層往下
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="summary"]');
const tops = await page.$$eval('.lp-floor-list > .lp-group > .lp-group-head', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
check('tree shows L6 at the top', tops.some((x) => x.includes('第 6 層・1') && x.includes('L6')), JSON.stringify(tops));
const l6 = await page.evaluate(async () => (await import('/src/compress.js')).structure().volumes.find((v) => v.level === 6).data.id);
await page.click(`[data-group="${l6}"]`);
const inside = await page.$$eval(`[data-group="${l6}"] ~ .lp-group-body > .lp-group > .lp-group-head`, (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
check('L6 opens into L5 eras', inside.length === 2 && inside.every((x) => x.includes('紀')), JSON.stringify(inside));
await page.screenshot({ path: `${OUT}/levels-tree.png` });

// 篩選「失敗」「過期」也算章和卷（使用者回報：第 1 部失敗、上面還是 0）
await page.evaluate(async () => {
  const { writeSummary } = await import('/src/summarize.js');
  writeSummary(2, { summary: 'L1-2（改過）' }); // 第 1 章過期 → 上面一路過期
  const meta = SillyTavern.getContext().chatMetadata.lovers_planner;
  const v = meta.volumes.find((x) => (x.level ?? 3) === 4);
  v.status = 'fail';
  v.error = '連線中斷';
});
await page.click('[data-tab="summary"]');
const chipNum = async (f) => Number((await page.textContent(`[data-action="sum-filter"][data-filter="${f}"]`)).match(/(\d+)\s*$/)[1]);
const staleN = await chipNum('stale');
const failN = await chipNum('fail');
check('stale chip counts digests', staleN >= 3, String(staleN));
check('fail chip counts digests', failN === 1, String(failN));
await page.click('[data-action="sum-filter"][data-filter="fail"]');
const failRows = await page.$$eval('[data-digest-row]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ')));
check('fail filter lists the failed part', failRows.length === 1 && failRows[0].includes('部') && failRows[0].includes('連線中斷') && failRows[0].includes('重新壓縮'), JSON.stringify(failRows));
await page.click('[data-action="sum-filter"][data-filter="stale"]');
check('stale filter lists stale digests', (await page.$$('[data-digest-row]')).length === staleN);
// 保留現在的總結：失敗的部按一下就好，下面過期的也一起保留；不呼叫模型
await page.evaluate(() => { window.__prompts.length = 0; });
await page.click('[data-action="sum-filter"][data-filter="fail"]');
await page.click('[data-digest-row] [data-action="digest-keep"]');
const afterKeep = await page.evaluate(async () => {
  const { structure } = await import('/src/compress.js');
  const st = structure();
  return { bad: [...st.chapters, ...st.volumes].filter((x) => x.state !== 'ok').map((x) => `${x.level ?? 2}:${x.state}`), calls: window.__prompts.length };
});
check('keep clears the part and the stale ones below it', afterKeep.calls === 0 && !afterKeep.bad.some((x) => x.startsWith('4:') || x.startsWith('3:') || x.startsWith('2:')), JSON.stringify(afterKeep));
await page.click('[data-action="sum-filter"][data-filter="stale"]');
const leftStale = await page.$$('[data-digest-row]');
if (leftStale.length) await page.click('[data-action="digest-keep-all"]');
check('keep all clears the rest', (await page.$$('[data-digest-row]')).length === 0 && (await page.evaluate(() => window.__prompts.length)) === 0);
const injKept = await page.evaluate(() => window.__runInterceptor('normal'));
check('kept top level injected again', injKept.injection.value.includes('第 6 層・1'), injKept.injection.value.slice(0, 200));
await page.click('[data-action="sum-filter"][data-filter="all"]');

// 設定頁
await page.click('[data-tab="settings"]');
await page.click('details[data-sec="compress"] > summary');
check('settings show higher levels and caps', await page.isVisible('input[data-path="compress.higherPer"]') && await page.isVisible('input[data-path="compress.capL4"]'));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const line of results) console.log(line);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
