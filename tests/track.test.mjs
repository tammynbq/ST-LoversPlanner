// 記錄項目的勾選、人物的新欄位、物件數量的 −／＋。
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
for (let i = 0; i < 8; i++) {
  const ai = i % 2 === 0;
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i} 的內容`, send_date: `d${i}`, extra: {} });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => { window.__chat = chat; }, CHAT);
await page.goto(URL);
await page.waitForFunction(() => document.getElementById('lp_wand_entry'));

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

// 模型：第 0 層新增人物（含新欄位）和物件（含數量）；之後各層什麼都不做。
await page.evaluate(() => {
  window.__generateRaw = async ({ prompt }) => {
    window.__lastPrompt = prompt;
    if (prompt.includes('AI0')) {
      return JSON.stringify({
        time: '清晨', location: '山門', characters: ['沈言'], summary: '沈言在山門等小雨。',
        ops: [
          { op: 'add', type: 'character', data: { name: '沈言', identity: '天衍宗弟子', appearance: '高瘦', outfit: '青色道袍' } },
          { op: 'add', type: 'item', data: { name: '下品靈石', quantity: 10, holder: '小雨' } },
          { op: 'add', type: 'todo', data: { content: '去丹房報到' } },
        ],
      });
    }
    return JSON.stringify({ time: '中午', location: '丹房', characters: [], summary: `${prompt.match(/AI(\d)/)?.[1]}層`, ops: [] });
  };
});
const settings = () => page.evaluate(() => window.__extSettings.lovers_planner);
const openSettings = async () => {
  await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
  await page.click('#lp_wand_entry');
  await page.click('[data-tab="settings"]');
  if (!(await page.isVisible('input[data-path="track.item"]'))) await page.click('details[data-sec="track"] > summary');
};
const summarize = async (i) => {
  const head = `.mes[mesid="${i}"] .lp-sum-head`;
  if ((await page.getAttribute(head, 'aria-expanded')) !== 'true') await page.click(head);
  await page.click(`.mes[mesid="${i}"] [data-lp-act="summarize"], .mes[mesid="${i}"] [data-lp-act="redo"]`);
  await page.waitForFunction((i) => window.__chat[i].extra?.lovers_planner?.status === 'ok' && !document.querySelector(`.mes[mesid="${i}"] .lp-st-busy, .mes[mesid="${i}"] .lp-st-queued`), i);
};

// 1. 全部勾選時的提示詞
await summarize(0);
let p = await page.evaluate(() => window.__lastPrompt);
check('all tracked: rules for every type', ['time：', 'location：', 'characters：', 'character：', 'item：', 'promise ', 'todo '].every((x) => p.includes(x)));
check('format lists new character fields and quantity', p.includes('"identity": "…"') && p.includes('"outfit": "…"') && p.includes('"quantity": 1'));
check('no previous section on first floor', !p.includes('上一層：時間') || p.includes('上一層：（沒有'));
const e0 = await page.evaluate(() => window.__chat[0].extra.lovers_planner);
check('character new fields stored', e0.ops[0].data.identity === '天衍宗弟子' && e0.ops[0].data.outfit === '青色道袍');
check('item quantity stored as text', e0.ops[1].data.quantity === '10');

// 2. 人物分頁顯示新欄位；物件數量 −／＋
await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="characters"]');
await unfoldAll();
const card = await page.textContent('.lp-note-card');
check('character card shows identity/appearance/outfit', card.includes('天衍宗弟子') && card.includes('高瘦') && card.includes('青色道袍'));
await page.click('[data-tab="items"]');
await unfoldAll();
check('quantity shown', (await page.textContent('.lp-qty-val')).trim() === '10');
await page.click('[data-action="note-qty"][data-delta="1"]');
await page.click('[data-action="note-qty"][data-delta="1"]');
await page.click('[data-action="note-qty"][data-delta="-1"]');
check('quantity stepper', (await page.textContent('.lp-qty-val')).trim() === '11');
await page.screenshot({ path: `${OUT}/track-1-items.png` });
const itemId = await page.getAttribute('[data-action="note-qty"]', 'data-id');
await page.click(`[data-action="note-edit"][data-id="${itemId}"]`);
check('quantity input is a number field', (await page.getAttribute('[data-note-field="quantity"]', 'type')) === 'number');
await page.fill('[data-note-field="quantity"]', '3');
await page.click('[data-action="note-save"]');
check('quantity edited in form', (await page.textContent('.lp-qty-val')).trim() === '3');
for (let k = 0; k < 5; k++) await page.click('[data-action="note-qty"][data-delta="-1"]');
check('quantity never below 0', (await page.textContent('.lp-qty-val')).trim() === '0');
await page.keyboard.press('Escape');

// 3. 取消勾選「物件」和「時間」
await openSettings();
await page.screenshot({ path: `${OUT}/track-2-settings.png` });
await page.click('input[data-path="track.item"]');
await page.click('input[data-path="track.time"]');
const s1 = await settings();
check('tracking saved', s1.track.item === false && s1.track.time === false);
check('items tab hidden', !(await page.$('[data-tab="items"]')));
await page.keyboard.press('Escape');
check('item change hidden in block', !(await page.textContent('.mes[mesid="0"] .lp-sum')).includes('下品靈石'));
check('time hidden in block', !(await page.textContent('.mes[mesid="0"] .lp-sum')).includes('清晨') && (await page.textContent('.mes[mesid="0"] .lp-sum')).includes('山門'));
await summarize(2);
p = await page.evaluate(() => window.__lastPrompt);
check('prompt: no item rule, no time key', !p.includes('item：') && !p.includes('"time"') && !p.includes('"quantity"'));
check('prompt: previous shows place only', p.includes('上一層：地點：山門') && !p.includes('時間：清晨'));
check('prompt: notes list without items', p.includes('目前的記事清單') && !p.includes('下品靈石'));
// 模型硬是回報物件 → 被擋掉
await page.evaluate(() => { window.__generateRaw = async () => JSON.stringify({ location: '丹房', summary: '硬塞物件', ops: [{ op: 'add', type: 'item', data: { name: '神行符' } }] }); });
await summarize(4);
check('untracked type ops dropped', (await page.evaluate(() => window.__chat[4].extra.lovers_planner.ops.length)) === 0);
// 注入：沒有物件、沒有時間
const r = await page.evaluate(() => window.__runInterceptor('normal'));
check('injection without items and time', !r.injection.value.includes('下品靈石') && !r.injection.value.includes('清晨') && r.injection.value.includes('山門'), r.injection.value);

// 4. 取消勾選全部記事 → 提示詞沒有 ops、沒有記事清單
await openSettings();
for (const k of ['character', 'promise', 'todo']) await page.click(`input[data-path="track.${k}"]`);
check('notes tabs and done tab hidden (calendar stays in the planner tab)', (await page.$$eval('.lp-tab', (b) => b.map((x) => x.dataset.tab).join())) === 'summary,notes,memories,settings');
await page.keyboard.press('Escape');
await page.evaluate(() => { window.__generateRaw = async ({ prompt }) => { window.__lastPrompt = prompt; return '{"location":"丹房","summary":"只有摘要"}'; }; });
await summarize(2);
p = await page.evaluate(() => window.__lastPrompt);
check('prompt: no ops at all', !p.includes('"ops"') && !p.includes('ops：') && !p.includes('記事清單'), p.slice(0, 400));
check('prompt has no empty-line gaps', !/\n\n\n/.test(p));

// 5. 重新勾選 → 資料回來
await openSettings();
for (const k of ['character', 'item', 'promise', 'todo', 'time']) await page.click(`input[data-path="track.${k}"]`);
await page.click('[data-tab="items"]');
await unfoldAll();
check('re-tick brings items back', (await page.textContent('.lp-qty-val')).trim() === '0');
check('time back in block', (await page.textContent('.mes[mesid="0"] .lp-sum')).includes('清晨'));

console.log(results.join('\n'));
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
