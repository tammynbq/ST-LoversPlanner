// 模型回了空的內容、API 服務商只塞了自己的通知（HTML 註解＋<style>＋<div>）：
// 不能當成摘要、自動重試、正常內容後面附了通知照樣能用、補建暫停時的錯誤訊息看得懂。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const OUT = process.argv[2] ?? '.';
const URL = `http://127.0.0.1:${process.env.PORT ?? 8765}/tests/harness.html`;
const results = [];
const errors = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

// 使用者截圖裡的回覆（服務商的通知）。
const AD = '<!-- 响应内容为空,本条免费 —— 小亿API交流群：1107821347 --> <style>.xy4{position:relative;padding:2px;border-radius:1px}.xy4-tag{color:#999}</style><div class="xy4"><span class="xy4-tag">本条免费</span><div class="xy4-foot">小亿API交流群：1107821347</div></div>';

const CHAT = [];
for (let i = 0; i < 8; i++) {
  const ai = i % 2 === 1;
  CHAT.push({ name: ai ? '沈言' : '小雨', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i} 練劍`, send_date: `d${i}`, extra: {} });
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

// ===== 1. cleanReply =====
const c = await page.evaluate(async (ad) => {
  const { cleanReply } = await import('/src/llm.js');
  const { parseL1 } = await import('/src/summarize.js');
  const run = (x) => { try { return { ok: cleanReply(x) }; } catch (e) { return { code: e.code, detail: e.detail }; } };
  const withAd = run(`{"summary":"沈言教小雨練劍","ops":[]}\n${ad}`);
  return {
    ad: run(ad),
    blank: run('   '),
    commentOnly: run('<!-- empty -->'),
    divOnly: run('<div>本条免费</div>'),
    plain: run('沈言教小雨練劍。'),
    withAd,
    parsedWithAd: withAd.ok ? parseL1(withAd.ok).summary : null,
  };
}, AD);
check('provider notice is not a summary', c.ad.code === 'empty_notice' && c.ad.detail.includes('响应内容为空'), JSON.stringify(c.ad));
check('blank reply is empty', c.blank.code === 'empty');
check('comment-only reply is empty', c.commentOnly.code === 'empty_notice' && c.commentOnly.detail === 'empty');
check('html-only reply is empty', c.divOnly.code === 'empty_notice' && c.divOnly.detail.includes('本条免费'));
check('plain text kept', c.plain.ok === '沈言教小雨練劍。');
check('real reply with a notice appended still works', c.parsedWithAd === '沈言教小雨練劍', JSON.stringify(c.withAd));

// ===== 2. 自動重試：前兩次是通知，第三次正常 =====
const retry = await page.evaluate(async (ad) => {
  window.__calls = 0;
  window.__generateRaw = async () => (++window.__calls <= 2 ? ad : '{"summary":"第三次才成功","ops":[]}');
  const { enqueue, pendingCount } = await import('/src/summarize.js');
  enqueue(1);
  const t0 = Date.now();
  while (pendingCount() && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 200));
  return { calls: window.__calls, summary: window.__chat[1].extra.lovers_planner?.summary, status: window.__chat[1].extra.lovers_planner?.status };
}, AD);
check('retried and succeeded', retry.calls === 3 && retry.summary === '第三次才成功' && retry.status === 'ok', JSON.stringify(retry));

// ===== 3. 一直都是通知：單層摘要失敗、訊息看得懂 =====
const fail = await page.evaluate(async (ad) => {
  window.__calls = 0;
  window.__generateRaw = async () => { window.__calls++; return ad; };
  const { enqueue, pendingCount } = await import('/src/summarize.js');
  enqueue(3);
  const t0 = Date.now();
  while (pendingCount() && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 200));
  const e = window.__chat[3].extra.lovers_planner;
  return { calls: window.__calls, status: e?.status, error: e?.error, summary: e?.summary };
}, AD);
check('gives up after 3 tries', fail.calls === 3 && fail.status === 'fail', JSON.stringify(fail));
check('notice never saved as a summary', !fail.summary);
check('error explains what happened', fail.error?.includes('只收到 API 服務商自己的通知') && fail.error.includes('响应内容为空') && fail.error.includes('換一個模型'), fail.error);

// ===== 4. 補建：暫停時一樣看得懂 =====
const cu = await page.evaluate(async () => {
  const { startCatchup, getCatchup } = await import('/src/catchup.js');
  const { pendingCount } = await import('/src/summarize.js');
  startCatchup({ from: 5, to: 7, fineCount: 0, block: 10 });
  const t0 = Date.now();
  while ((pendingCount() || !getCatchup()?.paused) && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 200));
  return getCatchup();
});
check('catch-up paused with a clear message', cu?.paused === true && cu.error?.includes('只收到 API 服務商自己的通知'), JSON.stringify(cu));
check('no rough chapter saved from the notice', await page.evaluate(async () => !(await import('/src/compress.js')).getChapters().length));

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
