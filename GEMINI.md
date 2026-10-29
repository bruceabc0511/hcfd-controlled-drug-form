# 專案與網頁開發永久規則 (Permanent Development Rules)

## 1. 跨裝置多解析度響應式排版規範 (RWD & Print Anti-Breakage Standard)
所有開發之網頁、電子表單與前端介面，必須確保在所有解析度設備上正常開啟且絕不跑版：

1. **五種必備解析度環境適配**：
   - **極窄手機 (`320px ~ 480px`)**：並列輸入框（如日期+時間、數量+單位、報案資訊等）必須自動換行並 `100%` 滿版（`flex: 1 1 100%`），嚴禁出現水平捲軸（Horizontal Scrollbar）。
   - **一般手機與直向小平板 (`481px ~ 768px`)**：多欄資料表格（`<table>`）必須轉為卡片式垂直堆疊（`display: block; width: 100% !important;`），按鈕與操作列需自動換行並易於觸控點擊。
   - **橫向平板與小型筆電 (`769px ~ 960px`)**：維持多欄表格結構，但需透過 `@media screen and (max-width: 960px)` 自動收斂儲存格 `padding` 與 `letter-spacing`，避免欄位標題不自然斷行。
   - **桌機與寬螢幕 (`961px ~ 1920px+`)**：設定合理容器最大寬度（`max-width`）與置中對齊（`margin: 0 auto`）。
   - **A4 列印與 PDF 匯出 (`@media print`)**：嚴格控制在 1~2 頁內，1:1 還原紙本表格欄位比例，設定 `break-inside: avoid` 防止表格列被跨頁切斷。

2. **螢幕 RWD 與列印樣式嚴格隔離**：
   - 所有螢幕響應式斷點必須明確標註 `screen`（即 `@media screen and (max-width: ...)`），**禁止**只寫 `@media (max-width: 768px)`，以避免 A4 縱向列印寬度（約 `718px`）誤觸手機版直排規則導致 PDF 表格崩潰。
   - 在 `@media print` 中必須明確指定 `display: table !important`、`display: table-row !important`、`display: table-cell !important`。

3. **禁止寫死破壞彈性排版的行內樣式**：
   - 禁止在 HTML 元素上寫死超過 `300px` 的固定像素寬度（如 `style="width: 400px"`），一律改用 CSS Flex/Grid 彈性伸縮（`flex: 1 1 ...`）搭配 `max-width: 100%`。
   - 所有包含文字或表單控制項的 `display: flex` 容器，預設必須加上 `flex-wrap: wrap`。
   - 避免使用 `position: absolute` 放置提示徽章或說明文字，或必須在小螢幕斷點（`<= 480px`）將其改回 `position: static`，防止覆蓋正文。
