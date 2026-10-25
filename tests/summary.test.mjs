// 第 2 步：L1 單層摘要。用模擬酒館的假聊天、假事件和假 generateRaw 測試整個流程。
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
  { name: '沈言', is_user: false, mes: '歡迎光臨。今天也下雨呢，要喝點什麼？', extra: {} },
  { name: '小雨', is_user: true, mes: '一杯熱可可，謝謝。你什麼時候下班？', extra: {} },
  { name: '沈言', is_user: false, mes: '八點。如果你願意等，我送你回家。', extra: {} },
  { name: '小雨', is_user: true, mes: '好，我等你。', extra: {} },
  { name: '沈言', is_user: false, mes: '沈言把外套披在小雨肩上，兩人撐同一把傘走回家。', extra: {}, swipe_id: 0, swipes: ['x'], swipe_info: [{ extra: {} }] },
];

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

const state = (i) => page.evaluate((i) => document.querySelector(`.mes[mesid="${i}"] .lp-badge`)?.className.match(/lp-st-(\w+)/)?.[1] ?? null, i);
const entry = (i) => page.evaluate((i) => window.__chat[i].extra?.lovers_planner ?? null, i);
const settle = () => page.waitForTimeout(150);
// 魔術棒選單點過一次會收起來（和真的酒館一樣），再打開大視窗前先讓它重新出現。
const openPanel = async () => {
  await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
  await page.click('#lp_wand_entry');
};

// 1. 區塊只出現在 AI 訊息下面
check('blocks on AI messages only', (await page.$$eval('.lp-sum', (b) => b.map((x) => x.dataset.index))).join() === '0,2,4');
check('initial state none', (await state(4)) === 'none');
check('latest hint', (await page.textContent('.mes[mesid="4"] .lp-sum-preview')).includes('最新一層'));
await page.screenshot({ path: `${OUT}/sum-1-initial.png` });

// 2. 使用者送出下一句 → 主 API 生成中先排隊 → 生成結束才摘要上一層
async function userSends(text) {
  await page.evaluate(async (text) => {
    window.__chat.push({ name: '小雨', is_user: true, mes: text, extra: {} });
    window.__renderChat();
    const id = window.__chat.length - 1;
    await window.__emit('user_message_rendered', id);
    await window.__emit('generation_started', 'normal', {}, false);
    await window.__emit('message_sent', id);
  }, text);
}
await userSends('謝謝你送我回來。');
await settle();
check('queued while main API busy', (await state(4)) === 'queued');
check('no call during main generation', await page.evaluate(() => window.__prompts.length === 0));
await page.evaluate(() => window.__emit('generation_ended', 6));
await page.waitForFunction(() => window.__chat[4].extra?.lovers_planner?.status === 'ok');
await settle();
check('summarized after generation ends', (await state(4)) === 'ok');
const e4 = await entry(4);
check('summary stored', e4.summary === '摘要#1' && typeof e4.hash === 'string', JSON.stringify(e4));
check('synced to swipe extra', await page.evaluate(() => window.__chat[4].swipe_info[0].extra.lovers_planner?.summary === '摘要#1'));
const p = await page.evaluate(() => window.__prompts[0]);
check('prompt has user + AI text', p.prompt.includes('小雨: 好，我等你。') && p.prompt.includes('沈言: 沈言把外套'));
check('prompt variables filled', !/\{\{(content|length|notes|char|user|previous)\}\}/.test(p.prompt) && /不超過 \d+ 字/.test(p.prompt), p.prompt.match(/不超過 \d+ 字/)?.[0]);
check('prompt in zh-TW', p.prompt.includes('繁體中文'));
check('response length passed', p.responseLength > 0, String(p.responseLength));
await page.waitForTimeout(500);
check('chat saved', await page.evaluate(() => window.__chatSaves > 0));

// 3. 編輯訊息 → 過期；不會自動重做
await page.evaluate(async () => { window.__chat[4].mes += '（改過）'; await window.__emit('message_edited', 4); });
check('edited → stale', (await state(4)) === 'stale');

// 4. 跳過／取消跳過（從區塊操作）
await page.click('.mes[mesid="2"] .lp-sum-head');
await page.click('.mes[mesid="2"] [data-lp-act="skip"]');
check('skip', (await state(2)) === 'skip' && (await entry(2)).status === 'skip');
await page.click('.mes[mesid="2"] [data-lp-act="unskip"]');
check('unskip', (await state(2)) === 'none' && (await entry(2)) === null);

// 5. 失敗 → 手動寫
await page.evaluate(() => { window.__generateRaw = async () => { throw new Error('boom'); }; });
await page.click('.mes[mesid="2"] [data-lp-act="summarize"]');
await page.waitForFunction(() => window.__chat[2].extra?.lovers_planner?.status === 'fail');
await settle();
check('fail state', (await state(2)) === 'fail');
check('fail shows error', (await page.textContent('.mes[mesid="2"] .lp-sum')).includes('boom'));
await page.screenshot({ path: `${OUT}/sum-2-fail.png` });
await page.click('.mes[mesid="2"] [data-lp-act="write"]');
await page.fill('.mes[mesid="2"] .lp-sum-editor', '沈言說八點下班，願意送小雨回家。');
await page.click('.mes[mesid="2"] [data-lp-act="save"]');
check('manual write → ok', (await state(2)) === 'ok' && (await entry(2)).manual === true);

// 6. 模型沒照 JSON 格式：純文字直接當摘要；包在 ```json 裡也能解析
await page.evaluate(() => { window.__generateRaw = async () => '沈言招呼小雨，問她要喝什麼。'; });
await page.click('.mes[mesid="0"] .lp-sum-head');
await page.click('.mes[mesid="0"] [data-lp-act="summarize"]');
await page.waitForFunction(() => window.__chat[0].extra?.lovers_planner?.status === 'ok');
check('plain text reply accepted', (await entry(0)).summary === '沈言招呼小雨，問她要喝什麼。');
await page.evaluate(() => { window.__generateRaw = async () => '```json\n{"summary":"重做的摘要","ops":[{"op":"add","type":"item","data":{"name":"傘"}}]}\n```'; });
await page.click('.mes[mesid="4"] .lp-sum-head');
await page.click('.mes[mesid="4"] [data-lp-act="redo"]');
await page.waitForFunction(() => window.__chat[4].extra?.lovers_planner?.summary === '重做的摘要');
await settle();
check('fenced JSON parsed, ops kept', (await entry(4)).ops?.length === 1 && (await state(4)) === 'ok');

// 6b. 回覆被截斷：救回摘要和完整的記事，丟掉寫到一半的，畫面上提醒
await page.evaluate(() => { window.__generateRaw = async () => '{"time":"清晨","summary":"截斷前的完整摘要","ops":[{"op":"add","type":"item","data":{"name":"靈石","quantity":10}},{"op":"add","type":"character","data":{"name":"周'; });
await page.click('.mes[mesid="4"] [data-lp-act="redo"]');
await page.waitForFunction(() => window.__chat[4].extra?.lovers_planner?.summary === '截斷前的完整摘要');
await settle();
const tr = await entry(4);
check('truncated reply salvaged', tr.status === 'ok' && tr.repaired === true && tr.ops.length === 1 && tr.ops[0].data.name === '靈石', JSON.stringify(tr.ops));
check('repaired hint shown', (await page.textContent('.mes[mesid="4"] .lp-sum')).includes('被截斷'));
// 字串裡直接換行
await page.evaluate(() => { window.__generateRaw = async () => '{"summary":"第一行\n第二行","ops":[]}'.replace('\\n', '\n'); });
await page.click('.mes[mesid="4"] [data-lp-act="redo"]');
await page.waitForFunction(() => window.__chat[4].extra?.lovers_planner?.summary?.startsWith('第一行'));
check('raw newline inside string accepted', (await entry(4)).summary === '第一行\n第二行');
// 截在摘要之前、救不回摘要 → 失敗，錯誤訊息附上頭尾
await page.evaluate(() => { window.__generateRaw = async () => '{"time":"清晨","location":"山門","characters":["菜菜","沈'; });
await page.click('.mes[mesid="4"] [data-lp-act="redo"]');
await page.waitForFunction(() => window.__chat[4].extra?.lovers_planner?.status === 'fail');
check('no summary recoverable → fail', (await entry(4)).error.includes('看不懂'));
await page.evaluate(() => { window.__generateRaw = async () => '{"summary":"重做的摘要","ops":[]}'; });
await page.click('.mes[mesid="4"] [data-lp-act="retry"]');
await page.waitForFunction(() => window.__chat[4].extra?.lovers_planner?.status === 'ok');
await settle();
check('output limit generous', (await page.evaluate(() => window.__prompts.at(-1).responseLength)) >= 2000);

// 7. 手動模式：送出時不自動摘要
await page.evaluate(() => { window.__extSettings.lovers_planner.summary.mode = 'manual'; });
const before = await page.evaluate(() => window.__prompts.length);
await page.evaluate(async () => {
  window.__chat.push({ name: '沈言', is_user: false, mes: '晚安，小雨。', extra: {} });
  window.__renderChat();
  await window.__emit('character_message_rendered', window.__chat.length - 1);
  await window.__emit('message_received', window.__chat.length - 1);
});
await userSends('晚安。');
await page.evaluate(() => window.__emit('generation_ended', 8));
await page.waitForTimeout(300);
check('manual mode: no auto summary', (await page.evaluate(() => window.__prompts.length)) === before && (await state(6)) === 'none');
await page.evaluate(() => { window.__extSettings.lovers_planner.summary.mode = 'before'; });

// 7b. 每回正文結束後自動：AI 一回覆完就摘要；「繼續寫」接長後自動重摘
await page.evaluate(() => { window.__extSettings.lovers_planner.summary.mode = 'after'; window.__generateRaw = async () => '{"summary":"回覆完就摘","ops":[]}'; });
await page.evaluate(async () => {
  await window.__emit('generation_started', 'normal', {}, false);
  window.__chat.push({ name: '沈言', is_user: false, mes: '那就明天見。', extra: {} });
  window.__renderChat();
  await window.__emit('character_message_rendered', window.__chat.length - 1);
});
check('after mode: waiting hint while generating', (await page.textContent('.mes[mesid="8"] .lp-sum-preview')).includes('這一回結束後'));
await page.evaluate(() => window.__emit('message_received', 8));
await page.waitForFunction(() => window.__chat[8].extra?.lovers_planner?.summary === '回覆完就摘');
check('after mode: summarized right after reply', true);
await page.evaluate(() => { window.__generateRaw = async () => '{"summary":"接長後重摘","ops":[]}'; });
await page.evaluate(async () => { window.__chat[8].mes += '路上小心。'; await window.__emit('message_received', 8); });
await page.waitForFunction(() => window.__chat[8].extra?.lovers_planner?.summary === '接長後重摘');
await settle();
check('after mode: continue re-summarizes', (await state(8)) === 'ok');
const sentBefore = await page.evaluate(() => window.__prompts.length);
await userSends('明天見。');
await page.evaluate(() => window.__emit('generation_ended', 10));
await page.waitForTimeout(300);
check('after mode: sending does not summarize again', (await page.evaluate(() => window.__prompts.length)) === sentBefore);
await page.evaluate(() => { window.__extSettings.lovers_planner.summary.mode = 'before'; window.__generateRaw = async () => '{"summary":"補上的摘要","ops":[]}'; });

// 8. 自訂 API 沒設定好 → 清楚的錯誤
await page.evaluate(() => { window.__extSettings.lovers_planner.source = 'custom'; });
await page.click('.mes[mesid="6"] .lp-sum-head');
await page.click('.mes[mesid="6"] [data-lp-act="summarize"]');
await page.waitForFunction(() => window.__chat[6].extra?.lovers_planner?.status === 'fail');
check('custom not configured error', (await entry(6)).error.includes('自訂 API 還沒設定好'));
await page.evaluate(() => { window.__extSettings.lovers_planner.source = 'main'; window.__generateRaw = async () => '{"summary":"補上的摘要","ops":[]}'; });

// 9. 大視窗的摘要分頁
await openPanel();
const rows = await page.$$eval('.lp-floor-row .lp-floor-no', (els) => els.map((e) => e.textContent));
check('panel lists AI floors newest first', rows.join() === '#8,#6,#4,#2,#0', rows.join());
await page.click('[data-action="sum-filter"][data-filter="fail"]');
check('filter fail', (await page.$$eval('.lp-floor-row .lp-floor-no', (els) => els.map((e) => e.textContent))).join() === '#6');
await page.click('[data-action="sum-filter"][data-filter="all"]');
await page.screenshot({ path: `${OUT}/sum-3-panel.png` });
await unfold('floor:6');
await page.click('[data-action="sum-act"][data-act="retry"][data-index="6"]');
await page.waitForFunction(() => window.__chat[6].extra?.lovers_planner?.status === 'ok');
await page.waitForTimeout(200);
check('retry from panel', await page.evaluate(() => [...document.querySelectorAll('.lp-floor-row')].find((r) => r.querySelector('.lp-floor-no').textContent === '#6')?.textContent.includes('補上的摘要')));
await unfold('floor:2');
await page.click('[data-action="sum-act"][data-act="jump"][data-index="2"]');
check('jump closes panel and expands block', !(await page.isVisible('.lp-overlay')) && (await page.isVisible('.mes[mesid="2"] .lp-sum-body')));

// 10. 補摘要舊樓層
await page.evaluate(() => { for (const i of [0, 2]) { delete window.__chat[i].extra.lovers_planner; } });
await openPanel();
check('backfill button count', (await page.textContent('[data-action="backfill-ask"]')).includes('2 層'));
await page.click('[data-action="backfill-ask"]');
await page.click('[data-action="backfill-yes"]');
await page.waitForFunction(() => window.__chat[0].extra?.lovers_planner?.status === 'ok' && window.__chat[2].extra?.lovers_planner?.status === 'ok');
await page.waitForTimeout(200);
check('backfill done', await page.isDisabled('[data-action="backfill-ask"]'));

// 11. 關掉插件 → 區塊消失
await page.click('[data-tab="settings"]');
await page.click('input[data-path="enabled"]');
check('disabled removes blocks', (await page.$$('.lp-sum')).length === 0);
await page.click('input[data-path="enabled"]');
check('re-enabled shows blocks', (await page.$$('.lp-sum')).length === 5);

// 12. 手機版
await page.keyboard.press('Escape');
await page.setViewportSize({ width: 390, height: 844 });
await page.click('.mes[mesid="4"] .lp-sum-head');
await page.screenshot({ path: `${OUT}/sum-4-mobile.png` });

console.log(results.join('\n'));
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
