// 資料管理：導出（不含金鑰）、刪除（先下載備份、聊天本身不動、共用的記事不動、快照拿掉）、
// 導入（合併、覆蓋、對不上的、設定保留金鑰、壞檔案）、重新檢查所有樓層的番外（一鍵跳過、章變過期）。
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
  CHAT.push({ name: ai ? '白起' : '米米', is_user: !ai, mes: `${ai ? 'AI' : 'U'}${i}`, send_date: `d${i}`, extra: {}, ...(ai ? { swipe_id: 0, swipe_info: [{ extra: {} }] } : {}) });
}
CHAT[5].mes = '【番外】白起出差三天後提早回家。';

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1000, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
await page.addInitScript((chat) => {
  window.__chat = chat;
  window.__presetSettings = { lovers_planner: { settingsVersion: 5, summary: { mode: 'manual' }, recall: { notes: false, memory: false },
    compress: { auto: false, l1PerL2: 2 }, custom: { url: 'https://x', key: 'SECRET', model: 'm' } } };
}, CHAT);
await page.goto(URL);
await page.waitForFunction(() => Boolean(document.getElementById('lp_wand_entry') && globalThis.loversPlannerInterceptor), null, { timeout: 15000 });

// 摘要好 5 層、一章、一條手動記事、行事曆手動事件
await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  for (const i of [1, 3, 5, 7, 9]) setEntry(i, { v: 2, status: 'ok', time: '', location: '山門', characters: [], summary: `第${i}層`, ops: [], hash: floorSource(i).hash, at: 1000 + i, date: '2025-03-01' });
  const meta = SillyTavern.getContext().chatMetadata;
  meta.lovers_planner = { ...(meta.lovers_planner ?? {}), chapters: [{ id: 'ch_x', members: ['d1', 'd3'], memberIdx: [1, 3], memberAts: [1001, 1003], time: '', location: '山門', summary: '第一章', status: 'ok', at: 5 }] };
  (await import('/src/notes.js')).addNoteManual('promise', { content: '一起看海', title: '看海' });
  (await import('/src/calendar.js')).addManualEvent({ type: 'plan', date: '2025-03-08', title: '去看海' });
  // 角色那邊這個聊天的快照
  const s = SillyTavern.getContext().extensionSettings.lovers_planner;
  s.characters = { 'shenyan.png': { chats: { '雨天的約定': { at: 1, lines: ['x'], notes: [] }, '別的聊天': { at: 1, lines: ['y'], notes: [] } } } };
});

// ===== 1. 導出 =====
const backup = await page.evaluate(async () => (await import('/src/backup.js')).buildBackup({ settings: true }));
check('floors exported', backup.floors.length === 5 && backup.floors[0].sendDate === 'd1' && backup.floors[0].entry.summary === '第1層');
check('chat data exported', backup.meta.chapters?.length === 1 && backup.meta.manualOps?.length === 1 && backup.meta.calendar?.manual?.length === 1);
check('settings without keys', backup.settings && backup.settings.custom.key === '' && backup.settings.custom.url === 'https://x' && !backup.settings.characters);

await page.evaluate(() => { document.getElementById('extensionsMenu').style.display = ''; });
await page.click('#lp_wand_entry');
await page.click('[data-tab="settings"]');
await page.click('details[data-sec="data"] > summary');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="data-export"]')]);
check('download named', /^lovers-planner_.*\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
const file = await dl.path();
const { readFileSync, writeFileSync } = await import('node:fs');
const text = readFileSync(file, 'utf8');
check('downloaded file is the backup', JSON.parse(text).floors.length === 5 && !text.includes('SECRET'));

// ===== 2. 刪除：要按兩次、先下載備份 =====
await page.click('[data-action="data-wipe"]');
check('asks first', await page.isVisible('[data-role="data-wipe-confirm"]') && (await page.evaluate(() => window.__chat[1].extra.lovers_planner?.summary)) === '第1層');
const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('[data-role="data-wipe-confirm"] [data-action="data-wipe"]')]);
check('backup downloaded before wiping', JSON.parse(readFileSync(await dl2.path(), 'utf8')).floors.length === 5);
const wiped = await page.evaluate(() => {
  const c = SillyTavern.getContext();
  return {
    floors: window.__chat.filter((m) => m.extra?.lovers_planner).length,
    swipes: window.__chat.filter((m) => m.swipe_info?.some((x) => x.extra?.lovers_planner)).length,
    meta: 'lovers_planner' in c.chatMetadata,
    mes: window.__chat[1].mes,
    snap: Object.keys(c.extensionSettings.lovers_planner.characters['shenyan.png'].chats),
  };
});
check('everything cleared, chat untouched', wiped.floors === 0 && wiped.swipes === 0 && !wiped.meta && wiped.mes === 'AI1', JSON.stringify(wiped));
check('only this chat snapshot removed', JSON.stringify(wiped.snap) === JSON.stringify(['別的聊天']), JSON.stringify(wiped.snap));
check('message shown', (await page.textContent('[data-role="data-message"]')).includes('已刪除'));

// ===== 3. 導入（合併）：從檔案 =====
await page.evaluate(async () => {
  const { floorSource, setEntry } = await import('/src/chat.js');
  setEntry(3, { v: 2, status: 'ok', time: '', location: '', characters: [], summary: '新的第3層', ops: [], hash: floorSource(3).hash, at: 9 });
  window.__chat[9].mes = 'AI9 改過了'; // 原文改過 → 過期
  window.__chat[7].send_date = 'd7-other'; // 對不上
});
const path = `${OUT}/backup-test.json`;
writeFileSync(path, text);
await page.setInputFiles('[data-role="data-file"]', path);
await page.waitForSelector('[data-role="data-file-info"]');
check('file info shown', (await page.textContent('[data-role="data-file-info"]')).includes('5 層'));
await page.click('[data-action="data-import"]');
const merged = await page.evaluate(async () => {
  const { floorStatus } = await import('/src/chat.js');
  const meta = SillyTavern.getContext().chatMetadata.lovers_planner;
  return { s1: window.__chat[1].extra.lovers_planner?.summary, s3: window.__chat[3].extra.lovers_planner?.summary, st9: floorStatus(9), s7: window.__chat[7].extra.lovers_planner, chapters: meta?.chapters?.length, ops: meta?.manualOps?.length };
});
check('merge fills missing floors', merged.s1 === '第1層' && merged.s3 === '新的第3層', JSON.stringify(merged));
check('changed text → stale', merged.st9 === 'stale');
check('unmatched floor left alone', !merged.s7);
check('chat data restored', merged.chapters === 1 && merged.ops === 1);
check('import result message', /對上 3 層，1 層已經有摘要沒動，1 層在這個聊天裡找不到/.test(await page.textContent('[data-role="data-message"]')), await page.textContent('[data-role="data-message"]'));

// ===== 4. 導入（覆蓋＋設定）：要確認、金鑰保留 =====
await page.evaluate(() => { SillyTavern.getContext().extensionSettings.lovers_planner.summary.mode = 'after'; });
await page.setInputFiles('[data-role="data-file"]', path);
await page.waitForSelector('[data-role="data-file-info"]');
await page.check('input[data-key="mode"][value="replace"]');
await page.check('input[data-key="importSettings"]');
await page.click('[data-action="data-import"]');
check('replace asks first', (await page.textContent('[data-action="data-import"]')).includes('確定覆蓋'));
await page.click('[data-action="data-import"]');
const replaced = await page.evaluate(() => {
  const s = SillyTavern.getContext().extensionSettings.lovers_planner;
  return { s3: window.__chat[3].extra.lovers_planner?.summary, mode: s.summary.mode, key: s.custom.key, chars: Object.keys(s.characters ?? {}) };
});
check('replace overwrote floors', replaced.s3 === '第3層', JSON.stringify(replaced));
check('settings imported, key kept, snapshots kept', replaced.mode === 'manual' && replaced.key === 'SECRET' && replaced.chars.includes('shenyan.png'), JSON.stringify(replaced));

// 壞檔案
writeFileSync(`${OUT}/bad.json`, '{"hello": 1}');
await page.setInputFiles('[data-role="data-file"]', `${OUT}/bad.json`);
await page.waitForFunction(() => document.querySelector('[data-role="data-message"]')?.textContent.includes('不是戀人手帳的備份'));
check('bad file rejected', await page.isDisabled('[data-action="data-import"]'));

// ===== 5. 重新檢查所有樓層的番外 =====
await page.click('[data-action="data-rescan"]');
check('opens the list in the summary tab', await page.isVisible('[data-role="extras"]') && (await page.textContent('[data-role="extras"]')).includes('重新檢查：發現 1 層'));
check('summarized floor listed', (await page.textContent('[data-extra="5"]')).includes('「番外」'));
check('chapter badge for floors inside a chapter', await page.evaluate(async () => { const { findExtrasAll } = await import('/src/catchup.js'); window.__chat[1].mes = '番外：一'; const r = findExtrasAll().find((x) => x.index === 1); window.__chat[1].mes = 'AI1'; return r?.chapter === 1; }));
await page.click('[data-action="extras-apply"]');
const rs = await page.evaluate(async () => ({ s5: (await import('/src/chat.js')).floorStatus(5), again: (await import('/src/catchup.js')).findExtrasAll().length }));
check('one click marks it a side scene', rs.s5 === 'side' && rs.again === 0, JSON.stringify(rs));
await page.screenshot({ path: `${OUT}/data.png` });

const missing = await page.evaluate(async () => (await import('/src/i18n.js')).missingKeys());
check('i18n keys complete', !missing.length, JSON.stringify(missing));

for (const l of results) console.log(l);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
