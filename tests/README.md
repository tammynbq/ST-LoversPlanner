# 測試

沒有酒館也能測：`harness.html` 是一個模擬酒館的頁面（假的 `SillyTavern.getContext()`），
`skeleton.test.mjs` 用 Playwright 開瀏覽器實際點擊。

```bash
# 在 repo 根目錄開一個靜態伺服器
npx http-server -p 8765 -s .   # 換埠號的話，跑測試時加上 PORT=埠號
# 另一個終端機：跑測試，截圖存到 /tmp/shots
mkdir -p /tmp/shots && node tests/skeleton.test.mjs /tmp/shots
node tests/custom-api.test.mjs /tmp/shots
```

- `skeleton.test.mjs`：骨架（入口、分頁、設定、三語、手機版）
- `custom-api.test.mjs`：自訂 API（拉取模型、測試連接、儲存、CORS 被擋時改走酒館轉發、401）

每一行輸出是 PASS 或 FAIL，最後一行 ERRORS 應該是 none。
