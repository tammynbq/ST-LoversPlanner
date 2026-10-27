// 約定／待辦的短標題、待辦的「和誰」、完成時的詳情（模型寫的優先，沒有就用完成那一層的摘要）、
// 已完成分頁（完成日期、已過幾天、排序、展開的內容）、幫舊的補標題。
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
for (let i = 0; i < 12; i++) {
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

// ===== 1. 提示詞 =====
const p = await page.evaluate(async () => (await (await import('/src/summarize.js')).buildL1Prompt(1)).prompt);
check('asks for a short title and detail', p.includes('15 字內、看得出是什麼事的短標題') && p.includes('detail') && p.includes('"title": "…"') && p.includes('"detail": "…"'));
check('todo has "with"', /"type": "todo", "data": \{ "content": "…", "title": "…", "with": "…"/.test(p), p.slice(p.indexOf('"type": "todo"'), p.indexOf('"type": "todo"') + 120));

// ===== 2. 資料 =====
await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  const ops = {
    1: [{ op: 'add', id: 'p_a', type: 'promise', data: { content: '带米米从洗手间回帐篷换好保暖衣服，晚上八点在北面山顶观星营火时向米米求婚', title: '求婚', with: '米米' } },
        { op: 'add', id: 't_a', type: 'todo', data: { content: '订松烟汤屋的私汤', title: '订私汤', with: '为米米' } },
        { op: 'add', id: 'p_old', type: 'promise', data: { content: '今天禁欲一天，下午两点陪米米去松烟汤屋单纯泡温泉' } },
        { op: 'add', id: 't_old', type: 'todo', data: { content: '回家后把银杏叶做成标本' } }],
    5: [{ op: 'complete', id: 'p_a', result: 'kept', detail: '白起在营火旁单膝跪地，提起十七岁那年的往事求婚，米米流泪答应。' }],
    7: [{ op: 'complete', id: 'p_old', result: 'kept' }],
  };
  const days = { 1: '2025-12-10', 3: '2025-12-11', 5: '2025-12-12', 7: '2025-12-13', 9: '2025-12-20', 11: '2025-12-31' };
  for (const i of [1, 3, 5, 7, 9, 11]) setEntry(i, { v: 2, status: 'ok', time: '', location: '', characters: [], summary: `第${i}層：${i === 7 ? '两人去泡了温泉' : '日常'}`, ops: ops[i] ?? [], hash: floorSource(i).hash, at: 1000 + i, date: days[i] });
  (await import('/src/notes.js')).invalidateNotes();
});

// ===== 3. 約定分頁：短標題 =====
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="notes"]');
const titles = await page.$$eval('.lp-note-section .lp-note-title', (els) => els.map((e) => e.textContent.trim()));
check('short title shown', titles.includes('订私汤'), titles.join(' / '));
check('no title → content shown', titles.includes('回家后把银杏叶做成标本'));
await page.click('[data-fold-key="note:t_a"] .lp-row-head');
const todo = await page.textContent('[data-fold-key="note:t_a"]');
check('opened: content and "with" listed', todo.includes('订松烟汤屋的私汤') && todo.includes('和誰') && todo.includes('为米米'), todo.replace(/\s+/g, ' '));

// ===== 4. 已完成分頁 =====
await page.click('[data-tab="done"]');
const rows = await page.$$eval('[data-fold-key^="done:"] .lp-note-title', (els) => els.map((e) => e.textContent.trim()));
check('newest completion first', rows[0] === '今天禁欲一天，下午两点陪米米去松烟汤屋单纯泡温泉' && rows[1] === '求婚', rows.join(' / '));
const head = await page.textContent('[data-fold-key="done:p_a"]');
check('folded: title, date, days ago', head.includes('求婚') && head.includes('✓ 12-12') && head.includes('已過 19 天'), head.replace(/\s+/g, ' '));
await page.click('[data-fold-key="done:p_a"] .lp-row-head');
const open = await page.textContent('[data-fold-key="done:p_a"]');
check('opened: with, dates, content', open.includes('米米') && open.includes('約定於') && open.includes('2025-12-10') && open.includes('完成於') && open.includes('2025-12-12') && open.includes('向米米求婚'), open.replace(/\s+/g, ' '));
check('model detail shown', (await page.textContent('[data-fold-key="done:p_a"] [data-role="done-detail"]')).includes('单膝跪地'));
await page.click('[data-fold-key="done:p_old"] .lp-row-head');
const old = await page.textContent('[data-fold-key="done:p_old"] [data-role="done-detail"]');
check('no detail → summary of that floor', old.includes('#7 的摘要') && old.includes('两人去泡了温泉'), old);
await page.screenshot({ path: `${OUT}/done-tab.png` });

// 手動完成：記下當時的故事日期
await page.evaluate(async () => (await import('/src/notes.js')).completeNoteManual('t_a', 'done'));
const manual = await page.evaluate(async () => {
  const { getNotes } = await import('/src/notes.js');
  const { closedDateOf } = await import('/src/notedates.js');
  return closedDateOf(getNotes().notes.get('t_a'));
});
check('manual completion dated', manual === '2025-12-31', manual);

// ===== 5. 幫舊的補標題 =====
check('fill-titles offered', (await page.textContent('[data-role="titles"]')).includes('2 條約定／待辦還沒有短標題'));
await page.evaluate(() => {
  window.__generateRaw = async ({ prompt }) => {
    window.__titlePrompt = prompt;
    return 'JSON：{"p_old": "单纯泡温泉", "t_old": "做银杏叶标本", "nope": "x"}';
  };
});
await page.click('[data-action="titles-fill"]');
for (let k = 0; k < 50 && (await page.$('[data-role="titles"]')); k++) await page.waitForTimeout(100);
const after = await page.evaluate(async () => {
  const { getNotes } = await import('/src/notes.js');
  const n = getNotes().notes;
  return { a: n.get('p_old').data.title, b: n.get('t_old').data.title, prompt: window.__titlePrompt };
});
check('titles filled', after.a === '单纯泡温泉' && after.b === '做银杏叶标本', JSON.stringify(after));
check('prompt lists ids and contents', after.prompt.includes('[p_old] 今天禁欲一天') && after.prompt.includes('15 字內'));
check('bar gone when all have titles', !(await page.$('[data-role="titles"]')));
check('done tab uses the new title', (await page.textContent('[data-fold-key="done:p_old"]')).includes('单纯泡温泉'));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
