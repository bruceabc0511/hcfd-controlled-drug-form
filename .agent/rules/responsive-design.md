---
description: 跨裝置多解析度響應式網頁排版與 A4 列印防跑版永久開發規則
---

# 跨裝置多解析度響應式排版規範 (RWD & Print Anti-Breakage Standard)

1. **全域基礎設定**：
   - CSS 必加 `*, *::before, *::after { box-sizing: border-box; }`。
   - HTML `<head>` 必含 `<meta name="viewport" content="width=device-width, initial-scale=1.0" />`。
2. **螢幕 RWD 與列印 `@media print` 嚴格隔離**：
   - 螢幕斷點一律寫 `@media screen and (max-width: ...)`，避免 A4 縱向列印寬度（~718px）誤觸手機版 `display: block` 規則。
   - 列印樣式 `@media print` 中，表格必須強制宣告 `display: table !important`、`display: table-row !important`、`display: table-cell !important`，並加上 `break-inside: avoid !important` 防止跨頁截斷。
3. **五段式解析度完整適配**：
   - `320px ~ 480px`（極窄手機）：並列輸入框改為 `flex: 1 1 100%` 滿版換行，絕對定位徽章改為 `position: static`。
   - `481px ~ 768px`（手機／小平板）：多欄表格轉為卡片式垂直堆疊，底部與頂部按鈕自動滿版換行。
   - `769px ~ 960px`（平板／小筆電）：縮小表格內距與字距，防止欄位標題換行。
   - `961px+`（桌機）：置中容器並限制最大寬度。
4. **彈性容器防溢出守則**：
   - 禁止在 HTML 行內寫死固定 `px` 寬度；所有橫向 Flex 容器必加 `flex-wrap: wrap`；長文字 `<select>` 與圖片必設 `max-width: 100%`。
