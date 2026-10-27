// 人物資料：新的欄位、逐欄說明的提示詞、可以關掉的欄位、舊的「關係」照樣顯示、
// 自動認出 {{user}}／{{char}}、手動指定／取消、提示詞裡標出主角。
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
for (let i = 0; i < 6; i++) {
  const ai = i % 2 === 1;
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i}`, send_date: `d${i}`, extra: {} });
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

await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  const ops = [
    { op: 'add', id: 'c_shen', type: 'character', data: { name: '沈言', identity: '劍修', relUser: '戀人', appearance: '左眉有疤', relation: '師兄（舊資料）' } },
    { op: 'add', id: 'c_yu', type: 'character', data: { name: '小雨', alias: '雨兒、小師妹', relChar: '戀人' } },
    { op: 'add', id: 'c_lin', type: 'character', data: { name: '林曉', relUser: '師姐', age: '22', bogus: 'x' } },
  ];
  setEntry(1, { v: 2, status: 'ok', time: '', location: '', characters: [], summary: '第1層', ops, hash: floorSource(1).hash, at: 1001 });
  (await import('/src/notes.js')).invalidateNotes();
});

// ===== 1. 提示詞 =====
const prompt = async () => page.evaluate(async () => (await (await import('/src/summarize.js')).buildL1Prompt(3)).prompt);
let p = await prompt();
check('field-by-field rules', p.includes('appearance：外貌和身體特徵') && p.includes('note：長期有用、上面欄位放不下的設定') && p.includes('不要寫發生過的事') && p.includes('status：會持續一段時間的狀態，用短詞組、20～40 字') && p.includes('relUser：和 小雨 的關係'), p.slice(p.indexOf('character：'), p.indexOf('character：') + 300));
check('json example lists new fields', p.includes('"alias": "…"') && p.includes('"relChar": "…"') && !p.includes('"relation"'));
check('leads marked in the notes list', p.includes('[c_shen] 主角：沈言｜') && p.includes('[c_yu] 主角：小雨｜') && !p.includes('[c_lin] 主角'), p.slice(p.indexOf('[c_'), p.indexOf('[c_') + 400));
await page.evaluate(() => { SillyTavern.getContext().extensionSettings.lovers_planner.track.fields.age = false; });
p = await prompt();
check('unchecked field left out', !p.includes('age：年齡') && !p.includes('"age"'));
check('recorded value still kept', await page.evaluate(async () => (await import('/src/notes.js')).getNotes().notes.get('c_lin').data.age === '22'));
check('unknown fields dropped', await page.evaluate(async () => !('bogus' in (await import('/src/notes.js')).getNotes().notes.get('c_lin').data)));

// ===== 2. 畫面 =====
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="characters"]');
const tag = (id) => page.evaluate((id) => document.querySelector(`[data-fold-key="note:${id}"] [data-role-tag]`)?.dataset.roleTag ?? null, id);
check('auto roles', (await tag('c_shen')) === 'char' && (await tag('c_yu')) === 'user' && (await tag('c_lin')) === null);
await page.click('[data-fold-key="note:c_shen"] .lp-row-head');
const card = await page.textContent('[data-fold-key="note:c_shen"]');
check('labels use names', card.includes('和 小雨 的關係') && card.includes('外貌特徵'), card.replace(/\s+/g, ' '));
check('legacy relation still shown', card.includes('師兄（舊資料）'));
await page.click('[data-fold-key="note:c_lin"] .lp-row-head');
await page.click('[data-fold-key="note:c_lin"] [data-action="note-role"][data-role-set="user"]');
check('manual role moves the badge', (await tag('c_lin')) === 'user' && (await tag('c_yu')) === null);
p = await prompt();
check('prompt follows manual role', p.includes('[c_lin] 主角：小雨｜') && !p.includes('[c_yu] 主角'));
await page.click('[data-fold-key="note:c_lin"] [data-action="note-role"][data-role-set=""]');
check('unmark goes back to auto', (await tag('c_lin')) === null && (await tag('c_yu')) === 'user');
await page.screenshot({ path: `${OUT}/characters.png` });

// 編輯：舊欄位有資料的才出現在表單
await page.click('[data-fold-key="note:c_shen"] [data-action="note-edit"]');
check('edit form has new and legacy fields', await page.isVisible('[data-note-field="relation"]') && await page.isVisible('[data-note-field="habits"]'));
await page.fill('[data-note-field="relation"]', '');
await page.click('[data-action="note-save"]');
const shen = await page.evaluate(async () => (await import('/src/notes.js')).getNotes().notes.get('c_shen').data);
check('legacy field can be cleared', !('relation' in shen) && shen.appearance === '左眉有疤', JSON.stringify(shen));

// ===== 3. 設定 =====
await page.click('[data-tab="settings"]');
await page.click('details[data-sec="track"] > summary');
check('field toggles in settings', await page.isVisible('[data-role="char-fields"] input[data-path="track.fields.appearance"]') && !(await page.isChecked('input[data-path="track.fields.age"]')));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
