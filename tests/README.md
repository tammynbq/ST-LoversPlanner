# 測試

沒有酒館也能測：`harness.html` 是一個模擬酒館的頁面（假的 `SillyTavern.getContext()`），
`skeleton.test.mjs` 用 Playwright 開瀏覽器實際點擊。

```bash
# 在 repo 根目錄開一個靜態伺服器
npx http-server -p 8765 -s .   # 換埠號的話，跑測試時加上 PORT=埠號
# 另一個終端機：跑測試，截圖存到 /tmp/shots
mkdir -p /tmp/shots && node tests/skeleton.test.mjs /tmp/shots
```

每一行輸出是 PASS 或 FAIL；最後的 ERRORS 只有找不到網站圖示（favicon）的 404 是正常的。
