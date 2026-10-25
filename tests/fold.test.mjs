// 摺疊（記住上次展開的、每個聊天各自記）、各分頁的篩選、總搜尋。
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
  const ai = i % 2 === 0;
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i}`, send_date: `d${i}`, extra: {} });
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => { window.__chat = chat; }, CHAT);

async function setup() {
  await page.goto(URL);
  await page.waitForFunction(() => document.getElementById('lp_wand_entry'));
  await page.evaluate(async () => {
    const { floorSource, setEntry } = await import('/src/chat.js');
    setEntry(0, { v: 2, status: 'ok', time: '清晨', location: '山門', characters: ['沈清晏'], summary: '沈清晏在山門等菜菜。', hash: floorSource(0).hash, at: 1,
      ops: [
        { op: 'add', id: 'c_aaa', type: 'character', data: { name: '沈清晏', identity: '天衍宗弟子', likes: '桂花糕' } },
        { op: 'add', id: 'c_bbb', type: 'character', data: { name: '周管事', identity: '外門管事' } },
        { op: 'add', id: 'i_ccc', type: 'item', data: { name: '下品靈石', quantity: '10', holder: '菜菜' } },
        { op: 'add', id: 't_ddd', type: 'todo', data: { content: '去丹房報到' } },
        { op: 'add', id: 't_eee', type: 'todo', data: { content: '買桂花糕' } },
      ] });
    setEntry(2, { v: 2, status: 'ok', time: '午後', location: '丹房', characters: [], summary: '菜菜到丹房報到，周管事很冷淡。', hash: floorSource(2).hash, at: 2,
      ops: [{ op: 'complete', id: 't_ddd', result: 'done' }] });
    (await import('/src/notes.js')).invalidateNotes();
    await window.__emit('chat_id_changed');
  });
}
const openPanel = async (tab) => {
  await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
  await page.click('#lp_wand_entry');
  if (tab) await page.click(`[data-tab="${tab}"]`);
};
const expanded = (key) => page.getAttribute(`[data-fold-key="${key}"] > .lp-row-head`, 'aria-expanded');

await setup();

// 1. 預設收起，一行顯示
await openPanel('characters');
check('cards folded by default', (await expanded('note:c_aaa')) === 'false' && !(await page.$('[data-fold-key="note:c_aaa"] [data-action="note-edit"]')));
check('folded line shows identity', (await page.textContent('[data-fold-key="note:c_aaa"]')).includes('天衍宗弟子'));
await page.click('[data-fold-key="note:c_aaa"] > .lp-row-head');
check('unfold shows all fields and buttons', (await expanded('note:c_aaa')) === 'true' && (await page.textContent('[data-fold-key="note:c_aaa"]')).includes('桂花糕') && Boolean(await page.$('[data-fold-key="note:c_aaa"] [data-action="note-edit"]')));
// 區塊收起
await page.click('[data-action="fold-sec"][data-key="sec:character"]');
check('section folds', !(await page.$('[data-fold-key="note:c_aaa"]')));
await page.click('[data-action="fold-sec"][data-key="sec:character"]');

// 2. 記住上次展開的：關掉再開、重新整理都還在
await page.keyboard.press('Escape');
await openPanel('characters');
check('remembered after reopen', (await expanded('note:c_aaa')) === 'true' && (await expanded('note:c_bbb')) === 'false');
await setup();
await openPanel('characters');
check('remembered after reload', (await expanded('note:c_aaa')) === 'true');
await page.click('[data-tab="items"]');
check('item folded line shows quantity', (await page.textContent('[data-fold-key="note:i_ccc"]')).includes('×10'));

// 3. 分頁篩選：符合的自動展開、標亮
await page.click('[data-tab="characters"]');
await page.fill('[data-search="characters"]', '外門');
await page.waitForTimeout(300);
check('filter keeps only matches', !(await page.$('[data-fold-key="note:c_aaa"]')) && Boolean(await page.$('[data-fold-key="note:c_bbb"]')));
check('matches auto-expanded and highlighted', (await expanded('note:c_bbb')) === 'true' && (await page.textContent('[data-fold-key="note:c_bbb"] .lp-mark')) === '外門');
check('count shown', (await page.textContent('.lp-note-section')).includes('1／2'));
check('search box keeps focus while typing', await page.evaluate(() => document.activeElement?.dataset?.search === 'characters'));
await page.fill('[data-search="characters"]', '找不到的字');
await page.waitForTimeout(300);
check('no match message', (await page.textContent('.lp-body')).includes('找不到符合的內容'));
await page.fill('[data-search="characters"]', '');
await page.waitForTimeout(300);

// 4. 摘要分頁：樓層預設收起；搜尋時列出符合的
await page.click('[data-tab="summary"]');
check('floor rows folded with preview', (await expanded('floor:d0')) === 'false' && (await page.textContent('[data-fold-key="floor:d0"]')).includes('沈清晏在山門'));
await page.fill('[data-search="summary"]', '丹房');
await page.waitForTimeout(300);
const floorRows = await page.$$eval('.lp-floor-row', (r) => r.map((x) => x.dataset.foldKey));
check('summary search finds by location', floorRows.join() === 'floor:d2', floorRows.join());
await page.fill('[data-search="summary"]', '');
await page.waitForTimeout(300);

// 5. 已完成：收起、篩選
await page.click('[data-tab="done"]');
check('done rows folded', (await expanded('done:t_ddd')) === 'false' && !(await page.$('[data-action="note-reopen"]')));
await page.click('[data-fold-key="done:t_ddd"] > .lp-row-head');
check('done row unfolds with buttons', Boolean(await page.$('[data-action="note-reopen"][data-id="t_ddd"]')));

// 6. 總搜尋：按類型分組，點結果跳過去
await page.click('[data-action="global-toggle"]');
await page.fill('[data-search="global"]', '桂花糕');
await page.waitForTimeout(300);
const groups = await page.$$eval('.lp-result-group > .lp-scope-title', (g) => g.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
check('global search groups', groups.some((g) => g.startsWith('人物')) && groups.some((g) => g.startsWith('待辦')), JSON.stringify(groups));
check('result shows matched field', (await page.textContent('.lp-result[data-key="note:c_aaa"]')).includes('喜歡：桂花糕'));
check('no tab selected during global search', !(await page.$('.lp-tab.lp-on')));
await page.screenshot({ path: `${OUT}/fold-1-global.png` });
await page.click('.lp-result[data-key="note:t_eee"]');
check('goto switches tab, filters and expands', (await page.getAttribute('.lp-tab.lp-on', 'data-tab')) === 'notes' && (await page.inputValue('[data-search="notes"]')) === '桂花糕' && (await expanded('note:t_eee')) === 'true');
check('global search closed after goto', !(await page.$('[data-search="global"]')));
await page.fill('[data-search="notes"]', '');
await page.waitForTimeout(300);
await page.click('[data-action="global-toggle"]');
await page.fill('[data-search="global"]', '山門 等');
await page.waitForTimeout(300);
check('global search: several keywords (AND)', (await page.$$('.lp-result')).length === 1 && Boolean(await page.$('.lp-result[data-key="floor:d0"]')));
await page.click('.lp-result[data-key="floor:d0"]');
check('goto floor expands it in summary tab', (await page.getAttribute('.lp-tab.lp-on', 'data-tab')) === 'summary' && (await expanded('floor:d0')) === 'true');
await page.keyboard.press('Escape');

// 7. 每個聊天各自記
await page.evaluate(async () => { window.__chatId = '另一個聊天'; await window.__emit('chat_id_changed'); });
await openPanel('characters');
check('other chat has its own fold state', (await expanded('note:c_aaa')) === 'false');
await page.keyboard.press('Escape');
await page.evaluate(async () => { window.__chatId = undefined; await window.__emit('chat_id_changed'); });
await openPanel('characters');
check('back to first chat: state restored', (await expanded('note:c_aaa')) === 'true');
await page.screenshot({ path: `${OUT}/fold-2-characters.png` });

console.log(results.join('\n'));
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
