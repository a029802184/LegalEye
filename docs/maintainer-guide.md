# 法眼 LegalEye V4 維護交接

還原基線為本次修改前的 `6166d59`。四個核對頁仍由 `src/flows/index.ts` 路由，專利工作表、設定識別碼與既有本機啟動方式相容。法眼 V3 的 [技術維護手冊](技術維護手冊.md) 仍適用於請求、專利、規則與部署。

| 位置 | 責任 |
|---|---|
| `src/core/ingest.ts`、`pdf.ts`、`ocr.ts`、`scanFields.ts` | 先讀原生資料，PDF 掃描頁以本機 Tesseract 逐頁處理，保留原文字、備選文字及欄位區域。戶謄欄位不完整時最多多做一次加強辨識。有同人證據、原欄位均保留且補到欄位才採用替代結果。 |
| `src/core/extract.ts`、`src/flows/flowC.ts` | 用標籤、行距與人物區塊抽取身分證和住址，流程 C 保留人員及頁面的獨立來源。 |
| `src/flows/chromeText.ts` | 每筆貼入資料使用案件、原始 PDF、頁碼、文件角色。用替代頁暫跑原本的規則，再把具該原頁證據的欄位合併到目標案件。原始 `ExtractedDoc` 仍保留，異讀可以一起顯示。 |
| `src/pages/check/ChromeText.tsx`、`Results.tsx`、`src/state/store.tsx` | 提供明確的人工貼入／匯入及原件檢視。貼入的全文和欄位修正留在當次工作階段，結果中的候選與人工更正可追查。 |
| `src/report/report.ts`、`vite.config.ts` | HTML 保留候選位置與人工確認狀態，匯出預設遮罩。正式建置加上 CSP，辨識模型、Worker、PDF 資源皆隨站提供。 |

貼入是逐頁片段機制。變體流程產生的其他案件、無來源的衍生檢查、頁碼未連上的欄位均不匯入。多人物頁請提供能辨別人物的欄位。法院角色、案號或送達受領人不足時，貼入只能保留待確認。貼入記錄未覆蓋原頁時，報告仍可查到自動讀取未完成的資料。已確認的原始資料與暫時貼入來源分別儲存。

## 執行與驗收

在 `legal/` 執行 `npm ci`、`npm run typecheck`、`npm test`、`npm run build`、`npm run test:e2e`。`npm ci` 會複製本機辨識模型與 PDF.js 資源。Windows 可使用 `啟動法眼.bat`，內網部署應整包發布 `dist/`，包括 `ocr/`、`pdfjs/` 和 `assets/`。Playwright 使用已安裝的 Edge，涵蓋六個視窗及一組 11 頁桌面掃描基準。藍底及 11 頁實際掃描測試在桌面尺寸執行。 `node tests/benchmark/v3-address.mjs --v4` 用固定樣本比較 V3 與目前工作區。 [V4 驗收](V4-驗收.md)

正式部署前依公司要求確認存取、檔案留存、DLP 和瀏覽器政策。團隊交接請匯出核准的規則與專利 Excel 主檔，各自按公司核准程序備份。測試、CI 與回報一律使用合成資料。 [Chrome 可行性](chrome-ocr-feasibility.md) · [操作手冊](ocr-user-guide-zh-TW.md)
