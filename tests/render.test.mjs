// 長聊天打開不能卡（v0.13.29，使用者回報 3000 多則、幾乎全部隱藏的聊天打開卡 5 分鐘）：
// 酒館打開聊天時每畫一則訊息就通知一次；以前每次都把整個聊天重算「哪些要隱藏」（還要逐筆比對插件標的清單），
// 2000 則要幾十秒。現在算一次記住。這裡畫 2000 則，要在幾秒內畫完，而且「已隱藏」標記要對。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
const N = 2000;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((N) => {
  const body = '兩個人一起吃晚餐，聊了很多事情。'.repeat(80);
  // 幾乎全部都是隱藏的（最新 6 則除外）；send_date 每則都不同
  window.__chat = Array.from({ length: N }, (_, i) => ({ name: i % 2 ? '沈言' : '小雨', is_user: !(i % 2), is_system: i < N - 6, mes: `${i % 2 ? 'AI' : 'U'}${i} ${i % 2 ? body : '嗯'}`, send_date: `d${i}`, extra: {} }));
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, compress: { auto: false }, hide: { stHide: true, markHidden: true } } };
}, N);
await page.goto(URL);
await page.waitForFunction(() => Boolean(globalThis.loversPlannerInterceptor), null, { timeout: 30000 });
await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  const chat = window.__chat;
  for (let i = 1; i < chat.length; i += 2) setEntry(i, { v: 2, status: 'ok', summary: `摘要${i}`, ops: [], hash: floorSource(i).hash, at: i });
  // 一半是戀人手帳自己用酒館隱藏標的（清單很長）
  SillyTavern.getContext().chatMetadata.lovers_planner = { stHidden: chat.filter((m, i) => m.is_system && i % 4 < 2).map((m) => m.send_date) };
});
const ms = await page.evaluate(async () => {
  const chat = window.__chat;
  const box = document.getElementById('chat');
  box.innerHTML = '';
  const t = performance.now();
  for (let i = 0; i < chat.length; i++) {
    const el = document.createElement('div');
    el.className = 'mes';
    el.setAttribute('mesid', String(i));
    el.innerHTML = '<div class="mes_block"><div class="mes_text"></div></div>';
    box.appendChild(el);
    await window.__emit(chat[i].is_user ? 'user_message_rendered' : 'character_message_rendered', i);
  }
  return Math.round(performance.now() - t);
});
check(`rendering ${N} messages stays fast`, ms < 5000, `${ms} ms`);
const marks = await page.evaluate(async () => {
  const { computeHidden } = await import('/src/hide.js');
  const want = computeHidden().hidden;
  const shown = new Set([...document.querySelectorAll('.lp-sum .lp-hidden-tag')].map((x) => Number(x.closest('.mes').getAttribute('mesid'))));
  const ai = [...want].filter((i) => !window.__chat[i].is_user);
  return { want: ai.length, shown: shown.size, same: ai.every((i) => shown.has(i)) };
});
check('hidden marks match the real calculation', marks.same && marks.want === marks.shown && marks.want > 0, JSON.stringify(marks));
// 摘要變了：標記跟著更新（不會被記住的舊結果卡住）
await page.evaluate(async () => {
  const { skipFloor } = await import('/src/summarize.js');
  window.__chat[1].extra = {};
  skipFloor(3);
  window.__chat[5].extra.lovers_planner = null;
  (await import('/src/notes.js')).invalidateNotes();
  await new Promise((r) => setTimeout(r, 50));
  (await import('/src/ui/message.js')).renderAllBlocks();
});
const after = await page.evaluate(() => ({
  f1: Boolean(document.querySelector('.mes[mesid="1"] .lp-hidden-tag')),
  f3: Boolean(document.querySelector('.mes[mesid="3"] .lp-hidden-tag')),
}));
check('marks refresh after changes', after.f1 === false && after.f3 === true, JSON.stringify(after));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
