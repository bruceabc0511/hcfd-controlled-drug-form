# 📱💻🖨️ 跨裝置多解析度排版檢測報告與未來開發通用規範（RWD & 列印防跑版學習手冊）

本手冊紀錄了《新竹縣政府消防局管制藥品事故報告單》在各種螢幕解析度與 A4 列印模式下的全面排版檢測結果，並將其中的實戰經驗提煉為**未來開發任何網頁與系統時可直接套用的標準規範（SOP）**。

---

## 一、全解析度目標範圍與斷點架構

| 設備類型 | 解析度寬度範圍 | 排版策略重點 |
| :--- | :--- | :--- |
| **1. 極窄手機** (iPhone SE / 舊款 Android) | `320px ~ 480px` | 雙欄或多欄並列元件（如日期+時間、數量+單位）必須 `100%` 滿版換行，禁止寫死固定 `px` 寬度。 |
| **2. 一般手機／直向小平板** | `481px ~ 768px` | 複雜的多欄 `<table>` 轉為卡片式垂直堆疊（`display: block`），標籤改為靠左對齊，按鈕滿版易點擊。 |
| **3. 橫向平板／小筆電** (iPad / 13" 筆電分割視窗) | `769px ~ 960px` | 維持桌面版多欄結構，但自動縮小儲存格內距（`padding`）與字距（`letter-spacing`），防止 4 字標題被擠成兩行。 |
| **4. 桌機／大螢幕** | `961px ~ 1920px+` | 設定容器最大寬度（如 `max-width: 1020px; margin: 0 auto`），避免在超寬螢幕上欄位被無限拉寬難以閱讀。 |
| **5. A4 紙本列印／PDF 匯出** | `@media print` (~718px) | **必須與螢幕 RWD 隔離**，強制維持標準 `display: table` 比例與固定欄寬，嚴格控制分頁（`break-inside: avoid`）。 |

---

## 二、本次網頁排版全面檢測與修復紀錄（7 大實戰案例）

### 案例 1：`@media (max-width: 768px)` 誤傷 A4 PDF 列印排版（最關鍵陷阱！）
- **跑版原因**：A4 縱向紙張在瀏覽器列印引擎（96 DPI）中的可視寬度約為 **`718px`**（小於 `768px`）。若 CSS 只寫 `@media (max-width: 768px)`，在列印／匯出 PDF 時會誤觸手機版規則，導致整個表格變成單欄垂直長條！
- **標準解法**：
  1. 所有給螢幕用的響應式規則，一律加上 **`screen`** 關鍵字：`@media screen and (max-width: 768px)`（見 [styles.css](file:///D:/Antigravity/管制藥事故報告單/styles.css#L1182)）。
  2. 在 `@media print` 中明確宣告 `display: table !important`、`display: table-row !important`、`display: table-cell !important`（見 [styles.css](file:///D:/Antigravity/管制藥事故報告單/styles.css#L1336-L1364)）。

### 案例 2：HTML 行內固定像素寬度（`style="width:150px"`）在手機溢出或參差不齊
- **跑版原因**：「報案證明」中的受理單位、日期、文號原本寫死 `style="width:150px"` 等固定寬度，在 `320px~414px` 手機上會因為「文字標籤＋輸入框」寬度總和尷尬而產生參差不齊的斷行。
- **標準解法**：移除 HTML 行內固定寬度，改用彈性容器 `.police-field-item { display: inline-flex; flex: 1 1 180px; }`（見 [index.html](file:///D:/Antigravity/管制藥事故報告單/index.html#L436-L450)、[styles.css](file:///D:/Antigravity/管制藥事故報告單/styles.css#L759-L768)），桌機自動均分、小螢幕自動 `100%` 滿版對齊。

### 案例 3：絕對定位標籤（`position: absolute`）在小螢幕覆蓋正文
- **跑版原因**：「分隊長主管意見」右上角的 `✍️ 紙本手寫欄位` 標籤原本使用 `position: absolute; top: 6px; right: 10px;`，在螢幕較窄時會直接疊在「`□能確定責任 □無法確定責任`」文字上方。
- **標準解法**：改用彈性列 `.handwriting-badge-row` 或在小螢幕（`<= 480px`）自動轉為 `position: static; display: inline-block;`（見 [styles.css](file:///D:/Antigravity/管制藥事故報告單/styles.css#L805-L812)、[styles.css](file:///D:/Antigravity/管制藥事故報告單/styles.css#L1301-L1309)），徹底消除文字重疊。

### 案例 4：簽章與日期欄 `min-width` + `gap` 總和超過小手機寬度
- **跑版原因**：`.paper-sign-footer` 原本未設 `flex-wrap: wrap`，且 `min-width: 170px` 加上 `gap: 36px` 與日期欄總寬達 `370px`，在 `320px~360px` 手機上會產生水平捲軸。
- **標準解法**：加上 `flex-wrap: wrap`，並在手機斷點調降 `min-width: 120px` 與 `gap: 6px 16px`（見 [styles.css](file:///D:/Antigravity/管制藥事故報告單/styles.css#L857-L865)、[styles.css](file:///D:/Antigravity/管制藥事故報告單/styles.css#L1273-L1281)）。

### 案例 5：日期＋時間並排輸入框在窄螢幕擠壓
- **跑版原因**：`<input type="date">` 與 `<input type="time">` 在 iOS / Android 瀏覽器具有原生最小內建寬度，若硬塞在同一行且未設 `flex-wrap: wrap` 會撐破容器。
- **標準解法**：使用 `.datetime-group { display: flex; flex-wrap: wrap; gap: 6px; }` 搭配 `flex: 1 1 135px`（見 [styles.css](file:///D:/Antigravity/管制藥事故報告單/styles.css#L547-L560)），空間足夠時並排、窄螢幕時自動上下堆疊。

### 案例 6：長文字 `<select>` 下拉選單撐破手機螢幕
- **跑版原因**：「列印輸出模式」的 `<option>` 文字較長，若未限制 `max-width: 100%`，瀏覽器會依最長選項撐開 `<select>` 寬度。
- **標準解法**：為外層與 `<select>` 加上 `max-width: 100%; text-overflow: ellipsis;`（見 [styles.css](file:///D:/Antigravity/管制藥事故報告單/styles.css#L266-L289)）。

### 案例 7：中型平板（`769px ~ 960px`）表格標題字距過大導致單字換行
- **跑版原因**：為求美觀設定的 `letter-spacing: 6px` 在桌機很漂亮，但在 `800px` 平板上會讓窄欄標題提早換行。
- **標準解法**：新增 `@media screen and (max-width: 960px)` 中繼斷點，自動收斂 `padding` 與 `letter-spacing`（見 [styles.css](file:///D:/Antigravity/管制藥事故報告單/styles.css#L1160-L1179)）。

---

## 三、未來開發網頁必備「防跑版黃金守則 Checklist」

1. **必加基礎設定**：全域務必宣告 `*, *::before, *::after { box-sizing: border-box; }`，且 HTML `<head>` 必含 `<meta name="viewport" content="width=device-width, initial-scale=1.0" />`。
2. **禁止寫死超過 `300px` 的固定寬度**：任何區塊或輸入框禁止單獨寫 `width: 400px`；一律改用 `width: 100%; max-width: 400px;` 或 `flex: 1 1 200px;`。
3. **所有橫向排列（`display: flex`）預設加上 `flex-wrap: wrap`**：只要包含文字或輸入框的 Flex 容器，一律加上 `flex-wrap: wrap; gap: 8px;`，讓窄螢幕有退路可以換行。
4. **圖片與媒體防溢出**：所有圖片、Canvas、嵌入式元件必設 `max-width: 100%; height: auto; object-fit: contain;`。
5. **螢幕 RWD 與列印 `@media print` 嚴格分家**：螢幕斷點永遠寫 `@media screen and (max-width: ...)`，避免汙染 A4 PDF 列印引擎。
6. **避免用 `position: absolute` 放置說明文字或徽章**：優先使用 `display: flex; justify-content: space-between;`，若真要用 `absolute`，在手機版斷點務必改回 `position: static`。
7. **多欄表格（Table）雙棲設計**：
   - `> 768px`：使用 `table-layout: fixed` 搭配百分比 `<colgroup>`。
   - `<= 768px`：使用 `@media screen and (max-width: 768px)` 將 `table, tbody, tr, th, td` 轉為 `display: block; width: 100% !important;` 卡片式排版。
8. **上線前 4 個必測寬度**：打開瀏覽器 F12 開發者工具（切換裝置模擬器），依序拉到 **`320px` → `375px` → `768px` → `1024px`** 並按 **`Ctrl + P`** 檢查列印預覽，確認完全無水平捲軸（Horizontal Scrollbar）即告完成！
