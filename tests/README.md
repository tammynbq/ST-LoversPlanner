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
```

- `skeleton.test.mjs`：骨架（入口、分頁、設定、三語、手機版）
- `custom-api.test.mjs`：自訂 API（拉取模型、測試連接、儲存、CORS 被擋時改走酒館轉發、401）
- `compress.test.mjs`：L2／L3 分層壓縮
- `track.test.mjs`：記錄項目、人物新欄位、物件數量
- `hide.test.mjs`：隱藏舊樓層、注入、強制彈窗
- `notes.test.mjs`：時間／地點／人物＋記事（同步、撤銷、手動修改、已完成）
- `summary.test.mjs`：第 2 步 L1 摘要（自動／手動／跳過／失敗／手動寫／補摘要舊樓層）

每一行輸出是 PASS 或 FAIL，最後一行 ERRORS 應該是 none。
