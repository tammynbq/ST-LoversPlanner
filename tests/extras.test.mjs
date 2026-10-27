// 1. 章、卷的時間補上日期、地點合併歸納；舊的章、卷不呼叫模型重算。
// 2. 補建前找出番外／小劇場／IF 線：列出、看正文、跳過或照常、決定後才開始、不再問。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

// 20 個 AI 樓層（1,3,…,39）。
const CHAT = [];
for (let i = 0; i < 40; i++) {
  const ai = i % 2 === 1;
  CHAT.push({ name: ai ? '白起' : '米米', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i} 兩人在營地。`, send_date: `d${i}`, extra: {} });
}
// 番外：AI 回覆開頭、使用者要求、標題行；以及正文很後面才提到（不算）。
CHAT[22].mes = '來個小劇場吧';
CHAT[25].mes = '【番外·出差】白起出差三天後提早回家。' + '正文'.repeat(50);
CHAT[29].mes = '正文'.repeat(200) + '\nIF線：如果沒有遇見\n' + '正文'.repeat(20);
CHAT[33].mes = '正文'.repeat(200) + '他說這不是番外，而是我們的日常。';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, recall: { notes: false, memory: false },
    compress: { auto: false, l1PerL2: 2, l2PerL3: 2, higherPer: 2 } } };
}, CHAT);
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

// ===== 1. 地點歸納 =====
const places = await page.evaluate(async () => {
  const { placesOf } = await import('/src/compress.js');
  return {
    few: placesOf(['山門', '山門 → 後山', '後山、丹房']),
    many: placesOf(['恋语市郊区・银杏林营地・C区营位、恋语市郊区・银杏林营地・北面山顶', '恋语市郊区・松烟汤屋・私汤「枫一3」包间、恋语市郊区・松烟汤屋・更衣区', '恋语市郊区・银杏林营地・银杏树下 → 恋语市郊区・银杏林营地・前台小木屋']),
    flat: placesOf(['甲', '乙', '丙', '丁', '戊', '己']),
  };
});
check('dedupe and split', places.few === '山門、後山、丹房', places.few);
check('generalize by levels', places.many === '恋语市郊区・银杏林营地、恋语市郊区・松烟汤屋', places.many);
check('too many flat places', places.flat === '甲、乙、丙、丁 等', places.flat);

// ===== 2. 時間補上日期 =====
await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  const rows = { 1: ['上午', '2025-12-12', '营地'], 3: ['14:52', '', '汤屋'], 5: ['傍晚', '2025-12-12', '营地'], 7: ['08:00', '2025-12-13', '家'] };
  for (const [i, [time, date, location]] of Object.entries(rows)) {
    setEntry(Number(i), { v: 2, status: 'ok', time, location, characters: [], summary: `第${i}層`, ops: [], hash: floorSource(Number(i)).hash, at: 1000 + Number(i), ...(date ? { date } : {}) });
  }
  window.__generateRaw = async ({ prompt }) => (prompt.includes('卷總結') ? '一卷' : prompt.includes('章節總結') ? '一章' : '{"summary":"x","ops":[]}');
  const { runCompression } = await import('/src/compress.js');
  SillyTavern.getContext().extensionSettings.lovers_planner.compress.auto = true;
  await runCompression(null);
  SillyTavern.getContext().extensionSettings.lovers_planner.compress.auto = false;
});
const digest = await page.evaluate(async () => {
  const { getChapters, getVolumes } = await import('/src/compress.js');
  return { ch: getChapters().map((c) => ({ time: c.time, location: c.location, from: c.dateFrom, to: c.dateTo })), vol: getVolumes().map((v) => ({ time: v.time, location: v.location })) };
});
check('same-day chapter: date once', digest.ch[0]?.time === '2025-12-12 上午 → 14:52', JSON.stringify(digest.ch));
check('cross-day chapter: both dates', digest.ch[1]?.time === '2025-12-12 傍晚 → 2025-12-13 08:00', JSON.stringify(digest.ch));
check('chapter dates stored', digest.ch[0]?.from === '2025-12-12' && digest.ch[1]?.to === '2025-12-13');
check('volume time keeps dates', digest.vol[0]?.time === '2025-12-12 上午 → 2025-12-13 08:00', JSON.stringify(digest.vol));
check('volume places merged', digest.vol[0]?.location === '营地、汤屋、家', JSON.stringify(digest.vol));

// 舊的章（以前的格式）：不呼叫模型重算，at 不變
const legacy = await page.evaluate(async () => {
  const meta = SillyTavern.getContext().chatMetadata.lovers_planner;
  const ch = meta.chapters[0];
  Object.assign(ch, { time: '上午 → 14:52', location: '营地 → 汤屋、营地', dateFrom: undefined, dateTo: undefined });
  const at = ch.at;
  window.__prompts.length = 0;
  const changed = (await import('/src/compress.js')).refreshDigestMeta();
  return { changed, time: ch.time, location: ch.location, sameAt: ch.at === at, calls: window.__prompts.length };
});
check('old chapters refreshed without the model', legacy.changed && legacy.time === '2025-12-12 上午 → 14:52' && legacy.location === '营地、汤屋' && legacy.sameAt && legacy.calls === 0, JSON.stringify(legacy));

// ===== 2b. 模型順便歸納地點 =====
const split = await page.evaluate(async () => {
  const { splitPlace } = await import('/src/compress.js');
  return [splitPlace('地點：恋语市郊区・银杏林营地\n兩人去露營。'), splitPlace('［地点］: 恋语市。\n\n總結'), splitPlace('沒有地點那一行的總結')];
});
check('place line split off', split[0].place === '恋语市郊区・银杏林营地' && split[0].summary === '兩人去露營。', JSON.stringify(split[0]));
check('place line variants', split[1].place === '恋语市' && split[1].summary === '總結', JSON.stringify(split[1]));
check('no place line → summary kept, no place', split[2].place === '' && split[2].summary === '沒有地點那一行的總結');
const modelPlace = await page.evaluate(async () => {
  const { getChapters, getVolumes, runCompression, structure, refreshDigestMeta } = await import('/src/compress.js');
  window.__prompts.length = 0;
  window.__generateRaw = async ({ prompt }) => (prompt.includes('卷總結') ? '地點：恋语市\n一卷（重壓）' : '地點：恋语市郊区・银杏林营地\n一章（重壓）');
  const ch = structure().chapters[0];
  await runCompression(ch.data.id);
  const vol = structure().volumes[0];
  await runCompression(vol.data.id);
  const asked = window.__prompts.every((p) => p.prompt.includes('最前面先寫一行「地點：」'));
  refreshDigestMeta();
  const c = getChapters().find((x) => x.id === ch.data.id);
  const v = getVolumes().find((x) => x.id === vol.data.id);
  return { asked, chLoc: c.location, chSum: c.summary, by: c.placeBy, volLoc: v.location, volSum: v.summary };
});
check('prompt asks for a place line', modelPlace.asked);
check('model place used for chapter', modelPlace.chLoc === '恋语市郊区・银杏林营地' && modelPlace.chSum === '一章（重壓）' && modelPlace.by === 'model', JSON.stringify(modelPlace));
check('model place used for volume, kept after refresh', modelPlace.volLoc === '恋语市' && modelPlace.volSum === '一卷（重壓）', JSON.stringify(modelPlace));

// ===== 3. 番外 =====
const found = await page.evaluate(async () => (await import('/src/catchup.js')).findExtras(21, 39).map((x) => `${x.index}:${x.word}`));
check('finds extras (reply start, user message, heading)', JSON.stringify(found) === JSON.stringify(['23:小劇場', '25:番外', '29:IF線']), JSON.stringify(found));
check('a word deep in the story is not an extra', !found.some((x) => x.startsWith('33')));

await page.evaluate(() => {
  window.__coarse = 0;
  window.__generateRaw = async ({ prompt }) => {
    if (prompt.includes('舊對話')) { window.__coarse++; return JSON.stringify({ time: '', location: '', characters: [], summary: '粗章', ops: [] }); }
    return '{"summary":"細摘","ops":[]}';
  };
  document.getElementById('extensionsMenu').style.display = '';
});
await page.click('#lp_wand_entry');
await page.click('[data-tab="summary"]');
await page.click('[data-action="backfill-ask"]');
check('option in the catch-up card', await page.isChecked('input[data-path="catchup.askExtras"]') && (await page.inputValue('#lp-extra-words')).includes('番外'));
await page.fill('[data-cu="from"]', '21');
await page.dispatchEvent('[data-cu="from"]', 'input');
await page.fill('[data-cu="fine"]', '0');
await page.dispatchEvent('[data-cu="fine"]', 'input');
await page.click('[data-action="backfill-yes"]');
check('stops before starting', await page.isVisible('[data-role="extras"]') && (await page.evaluate(() => window.__coarse)) === 0);
const card = await page.textContent('[data-role="extras"]');
check('lists them with text', card.includes('發現 3 層') && card.includes('#25') && card.includes('「番外」') && card.includes('白起出差三天後提早回家') && card.includes('你說：來個小劇場吧'), card.replace(/\s+/g, ' ').slice(0, 300));
check('shows where a later word appears', (await page.textContent('[data-extra="29"] [data-role="extra-around"]')).includes('IF線：如果沒有遇見'));
check('long text expandable', await page.isVisible('[data-extra="29"] .lp-tag-full summary'));
await page.screenshot({ path: `${OUT}/extras.png` });
check('defaults to side scene', (await page.inputValue('[data-role="extra-choice"][data-index="25"]')) === 'side');
await page.selectOption('[data-role="extra-choice"][data-index="23"]', 'skip');
await page.selectOption('[data-role="extra-choice"][data-index="29"]', 'keep');
check('button shows counts', (await page.textContent('[data-action="extras-go"]')).includes('跳過 1 層、小劇場 1 層、照常 1 層'));
await page.click('[data-action="extras-go"]');
for (let k = 0; k < 50; k++) {
  if (await page.evaluate(async () => !(await import('/src/summarize.js')).pendingCount() && window.__coarse > 0)) break;
  await page.waitForTimeout(100);
}
const after = await page.evaluate(async () => {
  const { floorStatus } = await import('/src/chat.js');
  return { s23: floorStatus(23), s25: floorStatus(25), s29: floorStatus(29), s21: floorStatus(21), coarse: window.__coarse };
});
check('skip, side scene and kept one', after.s23 === 'skip' && after.s25 === 'side' && after.s29 === 'ok' && after.s21 === 'ok' && after.coarse > 0, JSON.stringify(after));
const again = await page.evaluate(async () => (await import('/src/catchup.js')).findExtras(0, 39).length);
check('not asked again', again === 0);

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
