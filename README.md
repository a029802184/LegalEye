# 法眼 LegalEye｜法務室智慧作業輔助系統

純前端、本機處理的法務室工具：專利案件管理**＋**法律文件核對（四個流程）。
不需後端、資料庫、登入、外部 API 或付費 AI；文件只在使用者的瀏覽器中解析。

> 本系統是「可追溯、可交接、低誤報的法律文件核對輔助工具」，不是能自行判定法律正確性的 AI。
> 每個結果都能回答：哪一筆資料、從哪個來源（檔名／頁碼／儲存格）、為何判定不同、是否已人工確認。

## 功能

| 模組 | 內容 |
|---|---|
| 專利案件管理 | 新增／編輯／刪除（二次確認）、搜尋、狀態／承辦人／期限篩選、主次排序、批次變更狀態、期限提醒（已逾期／7 天／30 天）、資料完整性檢查、Excel／CSV 匯入匯出（相容舊版 LegalDesk 8 欄 CSV）、Excel 範本（狀態下拉、校驗規則、欄位說明、版本） |
| A 法院公文／通知函 | 執行命令 PDF ↔ Word 通知函；依案號＋姓名逐人配對（不依頁序）；紅字（含樣式繼承）辨識；司執≠司執助；遮罩身分證只做部分核對；未記載欄位標「不適用」 |
| B 強制執行聲請狀 | 聲請狀 ↔ 支付命令／確定證明書／送達證書（合併 PDF 自動拆組）；本金、程序費、已清償驗算、國字＝數字；利息起算日（一般送達 S+1、寄存送達 D+11，其餘需人工判斷） |
| C 支付命令批次 | ZIP 內 10–11 人：聲請狀 ↔ 合併戶籍謄本 ↔ 數字檔名帳務；多特徵配對、人工重新配對；缺件、同名、本期應繳、金額待釐清、掃描失敗 |
| D 民事陳報狀 | Excel 分項驗算與總額、國字／數字／附表金額、庭函案號股別（排除發文字號）、附件名稱與份數、是否收入正式附件 PDF |
| 共用底座 | 安全 ZIP（路徑穿越、ZIP Bomb、加密、巢狀、重複、Big5 檔名）、PDF.js 文字層、離線 OCR（Tesseract.js＋繁中語言檔）、DOCX run 字色、XLSX 公式與快取值、provenance、人工覆核、HTML／CSV 報告（預設遮罩） |

## 快速開始（開發者）

```bash
npm install          # 會自動複製 OCR 與 PDF.js 離線資源到 public/
npm run dev          # 開發模式 http://localhost:5173
npm test             # 單元測試（Vitest）
npm run build        # 型別檢查＋正式建置 → dist/
npm run test:e2e     # 響應式 E2E（Playwright＋本機 Edge；需先 build）
npm run icons        # 由 public/icons/legaleye-icon.svg 重新產生 PNG／favicon
```

需要 Node.js 18 以上。一般使用者**不需要**安裝任何東西，只要開啟部署好的網址。

## 部署

`npm run build` 產生的 `dist/` 是純靜態檔案，可放在：
- 公司內網 IIS／Nginx／任何靜態網站伺服器（任意子路徑皆可，`base: './'`）
- 單機：執行 `啟動法眼.bat`（使用 Windows 內建 PowerShell 啟動本機伺服器，只接受本機連線）

**不能**直接雙擊 `dist/index.html`：瀏覽器在 `file://` 下禁止載入 ES 模組與 Web Worker（PDF／OCR 需要）。
詳見 [docs/技術維護手冊.md](docs/技術維護手冊.md)。

## 目錄結構

```
legal/
├─ index.html                 網頁入口
├─ public/
│  ├─ icons/                  新版 Logo（SVG＋32/64/180/192/512 PNG）
│  ├─ favicon.ico, manifest.webmanifest
│  ├─ ocr/                    （npm install 產生）Tesseract worker／wasm／繁中語言檔
│  └─ pdfjs/                  （npm install 產生）PDF.js CMap 與標準字型
├─ src/
│  ├─ core/                   共用底座：zip, docx, xlsx, pdf, ocr, ingest, classify, extract,
│  │                          amount（國字金額）, date（民國年）, court（案號）, idno, service（送達利息）,
│  │                          rules（可維護設定）, hash, types
│  ├─ flows/                  四個流程規則集 flowA–flowD
│  ├─ patent/                 專利資料模型與 Excel／CSV 匯入匯出
│  ├─ report/                 HTML／CSV 報告
│  ├─ pages/, ui/, state/     介面
├─ tests/unit/                單元與整合測試（全部使用虛構資料）
├─ e2e/                       Playwright 響應式測試
├─ docs/                      使用手冊、技術維護手冊、測試報告、截圖
├─ brand/                     品牌素材（新版 legaleye/ 與舊版參考 reference_old_logo/）
└─ legacy/                    舊版 LegalDesk 概念驗證版備份（還原點）
```

## 文件

- [docs/使用手冊.md](docs/使用手冊.md)：給法務同事（網站內「使用說明」頁內容相同）
- [docs/技術維護手冊.md](docs/技術維護手冊.md)：安裝、建置、部署、更新、資料遷移、規則維護
- [docs/測試報告.md](docs/測試報告.md)：測試範圍、結果與未完成項目
- [CHANGELOG.md](CHANGELOG.md)：版本變更與相容性說明
