// 合併重複的人物之後（使用者回報 type.undefined）：
// 給模型的記事清單不再有被合併掉的那條；已經寫給它的更新併回留下的那條（比較新的欄位贏）；
// 畫面上那一層的變化認得出是誰，註明已刪除或合併。
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
for (let i = 0; i < 10; i++) {
  const ai = i % 2 === 1;
  CHAT.push({ name: ai ? '白起' : '米米', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i}`, send_date: `d${i}`, extra: {} });
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

const r = await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  const notes = await import('/src/notes.js');
  const { mergeNotes } = await import('/src/check.js');
  const old = Date.now() - 100000;
  const put = (i, ops, at) => setEntry(i, { v: 2, status: 'ok', time: '', location: '', characters: [], summary: `第${i}層`, ops, hash: floorSource(i).hash, at });
  put(1, [{ op: 'add', id: 'c_a', type: 'character', data: { name: '白起', outfit: '西裝', likes: '米米' } }], old);
  put(3, [{ op: 'add', id: 'c_b', type: 'character', data: { name: '白起', status: '下班', habits: '按頭哄睡' } }], old + 1);
  notes.invalidateNotes();
  // 🩺 檢查的「合併重複記事」：留 c_a，刪 c_b
  mergeNotes('c_a', 'c_b');
  // 合併之後才摘要的第 5 層：模型（看到舊清單）一直更新 c_b
  await new Promise((res) => setTimeout(res, 5));
  put(5, [{ op: 'update', id: 'c_b', data: { outfit: '黑色棉質短袖', status: '側躺讓米米枕手臂' } }], Date.now() + 1000);
  notes.invalidateNotes();
  const final = notes.getNotes().notes;
  const { buildL1Prompt } = await import('/src/summarize.js');
  const prompt = (await buildL1Prompt(7)).prompt;
  const { changesHtml } = await import('/src/ui/message.js');
  return {
    ids: [...final.keys()],
    a: final.get('c_a')?.data,
    promptHasB: prompt.includes('[c_b]'),
    promptHasA: prompt.includes('[c_a]'),
    changes: changesHtml(5).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '),
  };
});
check('merged note gone, kept one stays', JSON.stringify(r.ids) === '["c_a"]', JSON.stringify(r.ids));
check('later updates to the merged note are kept', r.a?.outfit === '黑色棉質短袖' && r.a.status === '側躺讓米米枕手臂', JSON.stringify(r.a));
check('fields from both kept', r.a?.likes === '米米' && r.a.habits === '按頭哄睡', JSON.stringify(r.a));
check('prompt no longer lists the merged note', !r.promptHasB && r.promptHasA);
check('change line names the person, no undefined', r.changes.includes('白起') && r.changes.includes('已刪除或合併') && !r.changes.includes('undefined') && r.changes.includes('當前衣著'), r.changes);

// 手動刪掉一條沒有重複的人物：不會併到別人身上
const solo = await page.evaluate(async () => {
  const notes = await import('/src/notes.js');
  notes.addNoteManual('character', { name: '韓野', status: '幫忙布置' });
  const id = [...notes.getNotes().notes.values()].find((n) => n.data.name === '韓野').id;
  notes.deleteNoteManual(id);
  const n = notes.getNotes().notes;
  return { a: n.get('c_a')?.data.status, han: [...n.values()].some((x) => x.data.name === '韓野') };
});
check('deleting a unique person changes no one else', solo.a === '側躺讓米米枕手臂' && !solo.han, JSON.stringify(solo));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
