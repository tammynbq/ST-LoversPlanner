// 時間／地點／人物＋記事：模型回報的變化套用到記事、單獨撤銷、手動修改、已完成、重做沿用 id、跳過與 swipe。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

const CHAT = [
  { name: '沈言', is_user: false, mes: 'FLOOR0 林姐把咖啡店交給小雨，沈言送小雨一條銀色手鍊，約好週末去看海。', extra: {}, swipe_id: 0, swipes: ['a'], swipe_info: [{ extra: {} }] },
  { name: '小雨', is_user: true, mes: '週末見。', extra: {} },
  { name: '沈言', is_user: false, mes: 'FLOOR2 週末到了，兩人去了海邊。小雨把手鍊交給沈言保管。', extra: {}, swipe_id: 0, swipes: ['b'], swipe_info: [{ extra: {} }] },
];

// 假模型：看提示詞裡是哪一層，回不同的 JSON；第二層會引用提示詞裡給的 id。
const MODEL = `async ({ prompt }) => {
  if (prompt.includes('FLOOR0')) {
    return JSON.stringify({
      time: '第三天 傍晚', location: '咖啡店', characters: ['沈言', '小雨', '林姐'],
      summary: '林姐把咖啡店交給小雨，沈言送了手鍊並約好看海。',
      ops: [
        { op: 'add', type: 'character', data: { name: '林姐', relation: '咖啡店老闆', status: '回老家' } },
        { op: 'add', type: 'character', data: { name: '沈言', relation: '主角' } },
        { op: 'add', type: 'character', data: { name: '小雨', likes: '熱可可', dislikes: '下雨天' } },
        { op: 'add', type: 'item', data: { name: '銀色手鍊', holder: '小雨' } },
        { op: 'add', type: 'promise', data: { content: '週末去看海', with: '沈言', when: '週末' } },
        { op: 'add', type: 'todo', data: { content: '查車班' } },
      ],
    });
  }
  const pid = prompt.match(/\\[(p_\\w+)\\] 約定/)?.[1];
  window.__floor2Prompt = prompt;
  return JSON.stringify({
    time: '', location: '海邊', characters: ['沈言', '小雨'],
    summary: '兩人去了海邊，小雨把手鍊交給沈言保管。',
    ops: [
      { op: 'complete', id: pid, result: 'kept' },
      { op: 'update', data: { name: '銀色手鍊', holder: '沈言' } },
      { op: 'add', type: 'character', data: { name: '林姐', status: '已回老家' } },
      { op: 'complete', id: 'c_nope', result: 'done' },
    ],
  });
}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => { window.__chat = chat; }, CHAT);
await page.goto(URL);
await page.waitForFunction(() => document.getElementById('lp_wand_entry'));
await page.evaluate(`window.__generateRaw = ${MODEL}`);

// 大視窗裡的卡片和樓層預設是收起來的：點開它們（已經開著就不動）。
const unfold = async (key) => {
  const head = `[data-fold-key="${key}"] > .lp-row-head`;
  await page.waitForSelector(head);
  if ((await page.getAttribute(head, 'aria-expanded')) !== 'true') await page.click(head);
};
const unfoldAll = async () => {
  for (let k = 0; k < 50; k++) {
    const head = await page.$('.lp-folded > .lp-row-head');
    if (!head) return;
    await head.click();
  }
};

const entry = (i) => page.evaluate((i) => window.__chat[i].extra?.lovers_planner ?? null, i);
const notes = () => page.evaluate(async () => {
  const m = await import('/src/notes.js');
  m.invalidateNotes();
  return [...m.getNotes().notes.values()].map((n) => ({ id: n.id, type: n.type, state: n.state, result: n.result, ...n.data }));
});
const openPanel = async (tab) => {
  await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
  await page.click('#lp_wand_entry');
  if (tab) await page.click(`[data-tab="${tab}"]`);
};
const expand = async (i) => {
  if ((await page.getAttribute(`.mes[mesid="${i}"] .lp-sum-head`, 'aria-expanded')) !== 'true') await page.click(`.mes[mesid="${i}"] .lp-sum-head`);
};
const summarize = async (i) => {
  await expand(i);
  await page.click(`.mes[mesid="${i}"] [data-lp-act="summarize"], .mes[mesid="${i}"] [data-lp-act="redo"]`);
  await page.waitForFunction((i) => window.__chat[i].extra?.lovers_planner?.status === 'ok' && !document.querySelector(`.mes[mesid="${i}"] .lp-st-busy, .mes[mesid="${i}"] .lp-st-queued`), i);
  await page.waitForTimeout(100);
};

// 1. 第 0 層：時間／地點／人物＋四種記事
await summarize(0);
const e0 = await entry(0);
check('scene fields stored', e0.time === '第三天 傍晚' && e0.location === '咖啡店' && e0.characters.join() === '沈言,小雨,林姐', JSON.stringify(e0));
check('leads can be characters, with likes', e0.ops.some((o) => o.data?.name === '沈言') && e0.ops.some((o) => o.data?.name === '小雨' && o.data?.likes === '熱可可'));
check('ops normalized with ids', e0.ops.length === 6 && e0.ops.every((o) => o.op === 'add' && /^[cipt]_/.test(o.id)));
check('scene shown in block', (await page.textContent('.mes[mesid="0"] .lp-scene')).includes('咖啡店'));
check('changes listed in block', (await page.$$('.mes[mesid="0"] .lp-change')).length === 6);
let n = await notes();
check('six notes active', n.length === 6 && n.every((x) => x.state === 'active'), JSON.stringify(n));

// 2. 第 2 層：提示詞看得到記事 id 和上一層的時間地點
await summarize(2);
const p2 = await page.evaluate(() => window.__floor2Prompt);
check('prompt lists notes with ids', /\[c_\w+\] 人物｜名字：林姐/.test(p2) && /\[p_\w+\] 約定/.test(p2));
check('prompt has previous scene', p2.includes('時間：第三天 傍晚｜地點：咖啡店'));
const e2 = await entry(2);
check('floor 2 ops: complete + update by name + duplicate add→update; unknown id dropped', e2.ops.map((o) => o.op).join() === 'complete,update,update', JSON.stringify(e2.ops));
n = await notes();
const promise = n.find((x) => x.type === 'promise');
const item = n.find((x) => x.type === 'item');
const chars = n.filter((x) => x.type === 'character' && x.name === '林姐');
check('promise kept → done', promise.state === 'done' && promise.result === 'kept');
check('item holder updated', item.holder === '沈言');
check('identifying name dropped from update', !('name' in e2.ops[1].data), JSON.stringify(e2.ops[1]));
check('no duplicate character', chars.length === 1 && chars[0].status === '已回老家');
await page.screenshot({ path: `${OUT}/notes-1-block.png` });

// 3. 撤銷／恢復某一層的單一變化
await page.click('.mes[mesid="2"] [data-lp-act="undo-op"][data-k="0"]');
check('undo complete → promise active again', (await notes()).find((x) => x.type === 'promise').state === 'active');
check('undone shown struck', await page.isVisible('.mes[mesid="2"] .lp-change.lp-undone'));
await page.click('.mes[mesid="2"] [data-lp-act="redo-op"][data-k="0"]');
check('restore change', (await notes()).find((x) => x.type === 'promise').state === 'done');

// 4. 大視窗：記事分頁
const tabs = async () => page.$$eval('.lp-tab', (b) => b.map((x) => x.dataset.tab).join());
const cards = async () => page.$$eval('.lp-note-section', (s) => s.map((x) => x.querySelectorAll('.lp-note-card').length).join());
await openPanel('characters');
check('tabs: summary, characters, items, notes (calendar + promises), memories, done, settings', (await tabs()) === 'summary,characters,items,notes,memories,done,settings', await tabs());
check('characters tab: 3', (await cards()) === '3', await cards());
await unfoldAll();
check('likes shown on card', (await page.textContent('.lp-note-section')).includes('熱可可'));
check('trace links', (await page.textContent('.lp-note-section')).includes('在 #0 新增'));
await page.screenshot({ path: `${OUT}/notes-2-tab.png` });
await page.click('[data-tab="items"]');
check('items tab: 1', (await cards()) === '1', await cards());
await page.click('[data-tab="notes"]');
check('promises & to-dos tab: 0 promise, 1 todo', (await cards()) === '0,1', await cards());
// 手動新增待辦（按 Enter 儲存）
await page.click('[data-action="note-add"][data-type="todo"]');
await page.fill('[data-note-form] [data-note-field="content"]', '買防曬乳');
await page.press('[data-note-form] [data-note-field="content"]', 'Enter');
check('manual add', (await notes()).some((x) => x.content === '買防曬乳'));
// 標題不能清空
const itemId = (await notes()).find((x) => x.type === 'item').id;
await page.click('[data-tab="items"]');
await unfold(`note:${itemId}`);
await page.click(`[data-action="note-edit"][data-id="${itemId}"]`);
await page.fill('[data-note-form] [data-note-field="name"]', '');
await page.click('[data-action="note-save"]');
check('empty title rejected', (await notes()).find((x) => x.id === itemId).name === '銀色手鍊' && await page.isVisible('[data-note-form]'));
await page.fill('[data-note-form] [data-note-field="name"]', '銀手鍊');
await page.fill('[data-note-form] [data-note-field="status"]', '');
await page.click('[data-action="note-save"]');
check('manual edit', (await notes()).find((x) => x.id === itemId).name === '銀手鍊');
// 完成待辦 → 已完成分頁 → 還原
const todoId = (await notes()).find((x) => x.content === '查車班').id;
await page.click('[data-tab="notes"]');
await unfold(`note:${todoId}`);
await page.click(`[data-action="note-complete"][data-id="${todoId}"]`);
check('todo done', (await notes()).find((x) => x.id === todoId).state === 'done');
await page.click('[data-tab="done"]');
const doneTitles = await page.$$eval('.lp-floor-row .lp-note-title', (els) => els.map((e) => e.textContent));
check('done tab lists promise + todo', doneTitles.includes('週末去看海') && doneTitles.includes('查車班'), doneTitles.join());
await page.screenshot({ path: `${OUT}/notes-3-done.png` });
await unfold(`done:${todoId}`);
await page.click(`[data-action="note-reopen"][data-id="${todoId}"]`);
check('restore from done', (await notes()).find((x) => x.id === todoId).state === 'active');
await page.click('[data-action="done-clear-ask"]');
await page.click('[data-action="done-clear-yes"]');
check('clear all deletes done notes', !(await notes()).some((x) => x.type === 'promise'));
check('manual ops stored in chat metadata', await page.evaluate(() => window.__chatMetadata.lovers_planner.manualOps.length >= 5));
await page.keyboard.press('Escape');

// 5. 重做第 0 層：重新新增同一條時沿用舊 id，第 2 層的更新不會失效
const before = (await entry(0)).ops.map((o) => o.id).join();
await summarize(0);
check('redo reuses ids', (await entry(0)).ops.map((o) => o.id).join() === before);
check('later floor still valid', !(await page.isVisible('.mes[mesid="2"] .lp-change.lp-invalid')));

// 6. 編輯摘要的四個欄位，記事變化保留
await expand(0);
await page.click('.mes[mesid="0"] [data-lp-act="edit"]');
await page.fill('.mes[mesid="0"] [data-field="time"]', '第三天 黃昏');
await page.fill('.mes[mesid="0"] [data-field="characters"]', '沈言、小雨');
await page.click('.mes[mesid="0"] [data-lp-act="save"]');
const e0b = await entry(0);
check('edit four fields', e0b.time === '第三天 黃昏' && e0b.characters.join() === '沈言,小雨' && e0b.ops.length === 6);

// 7. 跳過第 0 層 → 它新增的記事消失，第 2 層引用它的變化顯示「已略過」
await expand(0);
await page.click('.mes[mesid="0"] [data-lp-act="skip"]');
n = await notes();
check('skip removes that floor\'s notes', !n.some((x) => x.type === 'character' && !x.manual) && n.some((x) => x.content === '買防曬乳'));
check('dependent changes marked invalid', await page.isVisible('.mes[mesid="2"] .lp-change.lp-invalid'));
await expand(0);
await page.click('.mes[mesid="0"] [data-lp-act="unskip"]');
check('unskip brings them back', (await notes()).some((x) => x.type === 'character'));

// 8. 換 swipe（extra 被換掉）→ 那層的變化不再算
await page.evaluate(async () => { window.__chat[2].extra = {}; window.__chat[2].mes = '另一個版本'; await window.__emit('message_swiped', 2); });
const item2 = (await notes()).find((x) => x.type === 'item');
check('swipe drops that floor\'s changes', item2.holder === '小雨', JSON.stringify(item2));

console.log(results.join('\n'));
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
