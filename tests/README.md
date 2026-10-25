# 測試

沒有酒館也能測：`harness.html` 是一個模擬酒館的頁面（假的 `SillyTavern.getContext()`），
`skeleton.test.mjs` 用 Playwright 開瀏覽器實際點擊。

```bash
# 在 repo 根目錄開一個靜態伺服器
npx http-server -p 8765 -s .   # 換埠號的話，跑測試時加上 PORT=埠號
# 另一個終端機：跑測試，截圖存到 /tmp/shots
mkdir -p /tmp/shots && node tests/skeleton.test.mjs /tmp/shots
node tests/custom-api.test.mjs /tmp/shots
node tests/summary.test.mjs /tmp/shots
node tests/notes.test.mjs /tmp/shots
node tests/hide.test.mjs /tmp/shots
node tests/track.test.mjs /tmp/shots
node tests/compress.test.mjs /tmp/shots
node tests/fold.test.mjs /tmp/shots
node tests/recall.test.mjs /tmp/shots
node tests/update.test.mjs
node tests/carry.test.mjs /tmp/shots
node tests/catchup.test.mjs /tmp/shots
node tests/filter.test.mjs /tmp/shots
node tests/check.test.mjs /tmp/shots
node tests/calendar.test.mjs /tmp/shots
node tests/levels.test.mjs /tmp/shots
node tests/memories.test.mjs /tmp/shots
node tests/theme.test.mjs /tmp/shots
```

- `skeleton.test.mjs`：骨架（入口、分頁、設定、三語、手機版）
- `custom-api.test.mjs`：自訂 API（拉取模型、測試連接、儲存、CORS 被擋時改走酒館轉發、401）
- `fold.test.mjs`：摺疊和搜尋
- `recall.test.mjs`：只送相關的記事、回憶召回、向量
- `update.test.mjs`：更新後自動重新整理
- `carry.test.mjs`：帶走、即時共用、前情提要、匯入
- `catchup.test.mjs`：補建舊樓層
- `filter.test.mjs`：摘要時跳過的內容
- `check.test.mjs`：🩺 檢查
- `calendar.test.mjs`：行事曆
- `levels.test.mjs`：無限層壓縮
- `memories.test.mjs`：回憶錄、想起過去
- `theme.test.mjs`：美化主題蓋住大視窗
- `compress.test.mjs`：L2／L3 分層壓縮
- `track.test.mjs`：記錄項目、人物新欄位、物件數量
- `hide.test.mjs`：隱藏舊樓層、注入、強制彈窗
- `notes.test.mjs`：時間／地點／人物＋記事（同步、撤銷、手動修改、已完成）
- `summary.test.mjs`：第 2 步 L1 摘要（自動／手動／跳過／失敗／手動寫／補摘要舊樓層）

每一行輸出是 PASS 或 FAIL，最後一行 ERRORS 應該是 none。
