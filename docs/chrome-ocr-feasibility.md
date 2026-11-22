# Chrome PDF 本機辨識可行性

驗證日期為 2026-11-22（臺北）。測試只含自行生成的影像型 PDF、虛構姓名與遮罩編號。法眼是 React／Vite 靜態網站，PDF.js 在頁面自己的執行環境讀取使用者選擇的原檔，Tesseract.js 分頁辨識沒有可用文字的 PDF。Word 紅字資訊與 Excel 工作表沿用原解析器。

## 已驗證

- 本機已安裝 Windows 版 Google Chrome `157.0.8103.79`。Chrome 的內建檢視器成功開啟本機三頁影像 PDF。樣張有繁中姓名、證號遮罩、地址、金額與頁次標記，其中第 2 頁使用淺藍底、較小字與較低對比。檔案由每頁 JPEG 構成，沒有文字物件。
- 此次檢視器顯示三頁及「這份 PDF 無法存取，因此無法下載文字擷取檔案，請稍後再試。」開啟時沒有取得可驗證的辨識結果。後續檢查因桌面操作工具無法可靠辨識 `file:` 分頁的 URL 而停止。在此 Chrome 設定下，本次無法驗證可反白、搜尋、複製的端到端結果。
- Google 官方說明，桌面 Chrome PDF 檢視器可對掃描頁在裝置端執行 OCR，完成後可選取、搜尋、複製與貼上。Chromium 的 Screen AI 文件記載，Windows、macOS 與 Linux 元件由 component updater 按需提供。首次安裝、元件可用性和離線啟動要用公司核准的部署方式獨立驗證。 [Chrome PDF 檢視器](https://support.google.com/chrome/answer/16215622?co=GENIE.Platform%3DDesktop&hl=en) · [Chromium Screen AI 元件](https://chromium.googlesource.com/chromium/src/+/refs/tags/126.0.6452.4/services/screen_ai/README.md)
- 法眼的貼入路徑使用一般文字欄位與本機檔案選擇器，合成測試文字經過與原生來源相同的欄位解析與核對。此路徑對已配對的原頁顯示兩種讀值，允許逐欄覆核。詳細測試範圍與數據見 [V4 驗收](V4-驗收.md)。

## 尚未驗證

- 本次 Chrome 設定中 Screen AI 元件的實際安裝情況、首次下載成功與離線重開結果。上述錯誤不足以判斷是元件、企業設定或其他環境因素。
- Chrome 成功辨識後的繁中正確率、逐頁與全文複製時的表格順序、換行、跨頁分隔及低畫質成功率。法眼採逐頁貼入，一段文字不會標成整份 PDF 已讀。
- 閱讀模式在同一受管環境中的純掃描 PDF 行為。Google 的閱讀模式是排版／朗讀網頁文字功能，可按需下載自然語音。公司核准時應依其自身資料流程驗證。 [Chrome 閱讀模式說明](https://support.google.com/chrome/answer/14218344?hl=en)
- 手機真機、公司實際受管設備與 PAD 桌面工作流程，均待公司環境驗證。

## 不支援的直接串接

Chrome 公開的 Web API 清單沒有讀取內建 PDF 檢視器 OCR 的介面。Chromium 的 PDF 外掛和 Screen AI 呼叫屬於瀏覽器內部實作。Chrome 開發者文件討論的 `TextDetector` 以呼叫網站提供的圖片為輸入，也不同於取得其他頁籤 PDF 的辨識內容。V4 的支援方式為使用者自行複製後貼入，或選取本機純文字檔。 [Chrome 公開 AI API](https://developer.chrome.com/docs/ai/built-in-apis) · [圖片辨識 API](https://developer.chrome.com/docs/capabilities/shape-detection) · [Chromium PDF 外掛](https://chromium.googlesource.com/chromium/src/+/1907e156d4d4ec0fff251ebccad9b8b5c52be0d1/pdf/pdf_view_web_plugin.h)

PDF 檢視器的裝置端處理承諾適用於該 OCR 功能。閱讀模式、Lens 搜尋、Google Drive 儲存、瀏覽器同步和企業政策各有自己的行為。Cloud Vision 是雲端服務。工作指引只使用核准的本機 PDF 檢視器與法眼。 [Chrome PDF 檢視器與 Drive 選項](https://support.google.com/chrome/answer/16215622?hl=en) · [Chrome Enterprise 設定](https://support.google.com/chrome/a/answer/2657289?hl=en) · [Cloud Vision](https://cloud.google.com/vision/docs/ocr)

## 需公司核准

請 IT 在核准的 Windows 設備用合成樣張查核 Chrome 版本、是否允許內建 PDF 檢視器開啟本機檔案、元件更新是否成功、離線重開時能否讀取、DLP 與剪貼簿行為。分別記錄清晰頁和淺藍低對比頁的搜尋、選取、複製與貼回結果，再檢查頁次、姓名、證號、地址和金額順序。實際文件僅在公司授權的人員與環境中處理。

PAD 是可選的 Windows 驗證項目。若公司核准，合成樣張 PoC 可由人在前景指定本機 PDF 和頁碼，PAD 協助操作檢視器，使用者確認選取範圍後自行貼回法眼。如果複製失敗、結果缺頁或角色錯置，保留手動途徑。此版未安裝或執行 PAD。正式文件的明文剪貼簿歷史、暫存、記錄與雲端同步須由公司管控。
