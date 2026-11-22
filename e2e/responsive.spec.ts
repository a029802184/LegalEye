// 響應式完整操作驗收：首頁、導覽、專利查找編輯匯出、ZIP 匯入、批次清單、
// 單人詳情、來源／書狀切換、PDF 原頁、人工覆核、下載報告。所有資料為虛構。
import { test, expect, type Page } from '@playwright/test';
import { demoA, demoB, demoC, demoD } from '../tests/fixtures/datasets';
import { demoPatents, exportPatentXlsx } from '../src/patent/io';
import { DEFAULT_STATUSES } from '../src/patent/model';
import { captureDownloads, nextDownload } from './downloads';

async function noHorizontalOverflow(page: Page) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  expect(r.sw, `整頁水平溢出：scrollWidth ${r.sw} > ${r.w}`).toBeLessThanOrEqual(r.w + 1);
}

async function shot(page: Page, name: string) {
  const vp = page.viewportSize()!;
  await page.screenshot({ path: test.info().outputPath(`${vp.width}x${vp.height}-${name}.png`), fullPage: false });
}

async function nav(page: Page, label: string) {
  const w = page.viewportSize()!.width;
  if (w < 1024) {
    await page.getByRole('button', { name: '開啟選單' }).click();
    await page.getByRole('dialog', { name: '選單' }).getByRole('link', { name: label, exact: true }).click();
  } else {
    await page.getByRole('complementary', { name: '側邊導覽' }).getByRole('link', { name: label, exact: true }).click();
  }
}

test('首頁、品牌、導覽', async ({ page }) => {
  await page.goto('./');
  await expect(page).toHaveTitle(/法眼 LegalEye/);
  const w = page.viewportSize()!.width;
  const logo = w >= 1024 ? page.locator('.sidebar .nav-brand img') : page.locator('.topbar .brand img');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveJSProperty('complete', true);
  expect(await logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  const box = (await logo.boundingBox())!;
  // Logo 比例克制：桌面 28–36px、手機 24–30px
  if (w >= 1024) expect(box.width).toBeGreaterThanOrEqual(28), expect(box.width).toBeLessThanOrEqual(36);
  else expect(box.width).toBeGreaterThanOrEqual(24), expect(box.width).toBeLessThanOrEqual(30);
  await expect(page.getByText('LegalDesk')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '今天要處理什麼工作？' })).toBeVisible();
  const cards = page.locator('.flow-card');
  await expect(cards).toHaveCount(4);
  const columns = await page.locator('.flow-grid').evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length);
  expect(columns).toBe(w >= 768 ? 2 : 1);
  await noHorizontalOverflow(page);
  await shot(page, '01-home');
  for (const flow of ['A', 'B', 'C', 'D']) {
    await cards.locator(`[href="#/check/${flow}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/check/${flow}$`));
    await expect(page.getByRole('button', { name: '選擇檔案' })).toBeVisible();
    await expect(page.getByText(/資料只在這台裝置處理/)).toBeVisible();
    await expect(page.getByRole('button', { name: /示範/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '核對結果', exact: true })).toHaveCount(0);
    await noHorizontalOverflow(page);
    if (w === 1440 && (flow === 'A' || flow === 'B')) {
      const files = await (flow === 'A' ? demoA : demoB)();
      await page.getByTestId('file-input').setInputFiles(files.map((file) => ({ name: file.name, mimeType: 'application/octet-stream', buffer: Buffer.from(file.data) })));
      await page.getByRole('button', { name: '開始核對', exact: true }).click();
      await expect(page.getByRole('heading', { name: '核對結果', exact: true })).toBeVisible();
      await expect(page.locator('.unit-list button').first()).toBeVisible();
      if (flow === 'B') {
        const steps = page.locator('.workflow-steps');
        await steps.getByRole('button', { name: '確認案件配對' }).click();
        await steps.getByRole('button', { name: '當事人與金額' }).click();
        await steps.getByRole('button', { name: '利息起算日', exact: true }).click();
        await expect(page.locator('#interest-review')).toBeVisible();
        await expect(page.getByText('補充這一案的送達日期')).toHaveCount(0);
        await steps.getByRole('button', { name: '檢視與下載報告' }).click();
        await expect(page.getByRole('button', { name: '下載核對報告' })).toBeVisible();
      }
    }
    await page.goto('./#/');
  }
  await nav(page, '使用說明');
  await expect(page.getByRole('heading', { name: '使用說明', level: 1 })).toBeVisible();
  await noHorizontalOverflow(page);
});

test('專利：首頁匯入 Excel、查看清單及提醒、編輯和匯出 Excel', async ({ page }) => {
  await captureDownloads(page);
  await page.goto('./');
  const excel = await exportPatentXlsx(demoPatents(), DEFAULT_STATUSES);
  await page.getByTestId('patent-import').setInputFiles({ name: 'patents.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await new Blob([excel]).arrayBuffer()) });
  await page.getByRole('dialog', { name: '匯入預覽' }).getByRole('button', { name: '取代目前清單' }).click();
  await page.getByRole('link', { name: '查看近期提醒' }).click();
  await expect(page.locator('select').filter({ has: page.getByRole('option', { name: '近期提醒（含逾期）' }) })).toHaveValue('recent');
  await page.goto('./#/');
  await page.getByRole('link', { name: '查看案件清單' }).click();
  await page.getByRole('searchbox').fill('DEMO-002');
  await expect(page.getByText('顯示 1 / 4 筆')).toBeVisible();
  await noHorizontalOverflow(page);
  await shot(page, '02-patents');
  const w = page.viewportSize()!.width;
  if (w < 900) await page.getByRole('button', { name: '詳情' }).click();
  await page.getByRole('button', { name: '編輯', exact: true }).first().click();
  const dlg = page.getByRole('dialog', { name: /編輯 DEMO-002/ });
  await expect(dlg).toBeVisible();
  await dlg.getByLabel('承辦人').fill('測試承辦人');
  // 儲存按鈕在對話框底部，鍵盤彈出時仍可捲動點到
  await dlg.getByRole('button', { name: '儲存修改' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.locator(w < 900 ? '.case-detail dd' : 'table.data td').filter({ hasText: '測試承辦人' }).first()).toBeVisible();
  await expect(page.getByText('有尚未匯出的修改')).toBeVisible();
  await page.getByRole('button', { name: '匯出 Excel' }).click();
  const x = await nextDownload(page, /\.xlsx$/);
  expect(x.size).toBeGreaterThan(1000);
  await expect(page.getByText('有尚未匯出的修改')).toBeHidden();
});

test('批次核對：ZIP → 11 人清單 → 單人詳情 → 來源切換 → PDF 原頁 → 覆核 → 報告', async ({ page }) => {
  await captureDownloads(page);
  await page.goto('./#/check/C');
  const [zip] = await demoC();
  await page.getByTestId('file-input').setInputFiles({ name: zip.name, mimeType: 'application/zip', buffer: Buffer.from(zip.data) });
  await expect(page.getByRole('heading', { name: '檔案辨識與確認' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '核對結果', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '開始核對', exact: true }).click();
  await expect(page.getByRole('heading', { name: /債務人（11）/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/戶籍謄本共 10 頁，聲請狀 11 份/)).toBeVisible();
  await noHorizontalOverflow(page);
  await shot(page, '03-batch-list');

  const w = page.viewportSize()!.width;
  await page.locator('.unit-list button', { hasText: '張家豪' }).click();
  if (w < 1024) await expect(page.getByRole('button', { name: '返回清單' })).toBeVisible();
  const detail = page.locator('section', { has: page.locator('#h-detail') });
  await expect(detail.getByRole('heading', { name: '張家豪' })).toBeVisible();
  // 地址不一致項目預設展開
  const addr = detail.getByRole('button', { name: /地址（戶籍）/ });
  await expect(addr).toHaveAttribute('aria-expanded', 'true');
  const twoCol = w >= 1200 || (w >= 1024 && w > page.viewportSize()!.height);
  if (!twoCol) {
    await detail.getByRole('tab', { name: /書狀 B/ }).click();
    await expect(detail.locator('.ev-card h4', { hasText: '待核書狀 B' })).toBeVisible();
    await detail.getByRole('tab', { name: /來源 A/ }).click();
  }
  await expect(detail.locator('.ev-card h4', { hasText: '來源 A' })).toBeVisible();
  // 畫面上的前後文預設遮罩身分證
  expect(await detail.locator('.ev-card').allInnerTexts()).not.toEqual(expect.arrayContaining([expect.stringMatching(/[A-Z][12]d{8}/)]));
  await noHorizontalOverflow(page);
  await shot(page, '04-unit-detail');

  // PDF 原頁：只渲染目前頁，可縮放、可換頁
  if (twoCol) {
    await detail.getByRole('button', { name: '查看原頁' }).first().click();
  } else {
    const original = detail.getByRole('tab', { name: '查看原頁' });
    const summary = detail.getByRole('tab', { name: '核對摘要' });
    await original.click();
    await expect(original).toHaveAttribute('aria-selected', 'true');
    await summary.click();
    await expect(summary).toHaveAttribute('aria-selected', 'true');
    await original.click();
  }
  const canvas = detail.locator('.viewer canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(async () => canvas.evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(100);
  await detail.getByRole('button', { name: '放大' }).click();
  await detail.getByRole('button', { name: '符合寬度' }).click();
  await expect(detail.getByText('繪製中…')).toBeHidden();
  await noHorizontalOverflow(page);
  await shot(page, '05-pdf-view');

  // 人工覆核
  await detail.getByRole('button', { name: '需修正' }).click();
  await detail.getByLabel('覆核備註').fill('請前端更正樓層');
  await detail.getByRole('button', { name: '儲存備註' }).click();
  await expect(detail.getByText(/✔ 需修正/)).toBeVisible();
  if (w < 1024) {
    await page.getByRole('button', { name: '返回清單' }).click();
    await expect(page.locator('.unit-list')).toBeVisible();
  }

  await page.getByRole('button', { name: '下載核對報告' }).click();
  const rep = await nextDownload(page, /核對報告.*\.html$/);
  const { name, text: html } = rep;
  expect(name).toMatch(/核對報告.*\.html$/);
  expect(html).toContain('請前端更正樓層');
  expect(html).toContain('免責說明');
  expect(html).not.toMatch(/[A-Z][12]\d{8}/); // 預設遮罩身分證
  await page.getByText('其他下載格式', { exact: true }).click();
  await page.getByRole('button', { name: '下載 CSV' }).click();
  const csv = await nextDownload(page, /\.csv$/);
  expect(csv.text).toContain('張家豪');
  expect(csv.text).toContain('需修正');

  if (w < 1024) await page.locator('.unit-list button', { hasText: '張家豪' }).click();
  if (!(await addr.getAttribute('aria-expanded') === 'true')) await addr.click();
  const sourceCard = detail.locator('.ev-card').filter({ has: page.getByRole('heading', { name: '來源 A：戶籍謄本' }) });
  await sourceCard.getByText('更正讀取結果', { exact: true }).click();
  await sourceCard.getByLabel('人工確認為').fill('新北市板橋區甲路99號5樓');
  await sourceCard.getByRole('button', { name: '儲存更正並重算' }).click();
  await expect(sourceCard.getByText('已由人工確認')).toBeVisible();
});

test('陳報狀：附件核對與 Excel 驗算（含 XLSX、DOCX、PDF）', async ({ page }) => {
  await page.goto('./#/check/D');
  const [zip] = await demoD();
  await page.getByTestId('file-input').setInputFiles({ name: zip.name, mimeType: 'application/zip', buffer: Buffer.from(zip.data) });
  const courtLetter = page.getByRole('combobox').filter({ has: page.getByRole('option', { name: '法院民事庭函' }) }).first();
  const role = await courtLetter.inputValue();
  await courtLetter.selectOption('unknown');
  await expect(courtLetter).toHaveValue('unknown');
  await courtLetter.selectOption(role);
  await page.getByRole('button', { name: '開始核對', exact: true }).click();
  await expect(page.getByRole('heading', { name: /核對單位（4）/ })).toBeVisible({ timeout: 60_000 });
  await page.locator('.unit-list button', { hasText: '附件核對' }).click();
  const detail = page.locator('section', { has: page.locator('#h-detail') });
  await expect(detail.getByRole('button', { name: /附件二 份數/ })).toBeVisible();
  await noHorizontalOverflow(page);
  await shot(page, '06-attachments');
});

test('惡意 ZIP 路徑與 XSS 檔名不會執行', async ({ page }) => {
  await page.goto('./#/check/A');
  const JSZip = (await import('jszip')).default;
  const z = new JSZip();
  z.file('../../evil.txt', 'x');
  z.file('<img src=x onerror="window.__xss=1">.txt', '通知函 <script>window.__xss=2</script>');
  const data = await z.generateAsync({ type: 'nodebuffer' });
  await page.getByTestId('file-input').setInputFiles({ name: 'bad.zip', mimeType: 'application/zip', buffer: data });
  // JSZip 會自動建立上層資料夾項目，因此可能出現多筆「不安全的路徑」
  await expect(page.getByText(/不安全的路徑/).first()).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test('已移除的舊路徑回到四種核對流程', async ({ page }) => {
  await page.goto('./#/check/quick');
  await expect(page.locator('.flow-card')).toHaveCount(4);
  await expect(page.locator('a[href="#/check/quick"]')).toHaveCount(0);
  await noHorizontalOverflow(page);
  await shot(page, '07-check-types');
});

test('離線 OCR：掃描 PDF 以本機 Tesseract 處理（不連外部網路）', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://localhost:4173') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) external.push(r.url());
  });
  await page.goto('./#/check/C');
  await expect(page.getByText('掃描文字辨識已準備好，可在本機處理檔案。')).toBeVisible();
  const { buildPdf } = await import('../tests/fixtures/builders');
  const pdf = buildPdf([{ lines: [], scanned: true }]);
  await page.getByTestId('file-input').setInputFiles({ name: '99990001.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) });
  await expect(page.getByText(/已在本機辨識 1 張掃描頁/)).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: '查看掃描原頁' }).click();
  await page.getByRole('button', { name: '重新辨識這一頁' }).click();
  await expect(page.getByText(/重新辨識的候選文字/)).toBeVisible({ timeout: 90_000 });
  expect(external, '不得連線外部服務').toEqual([]);
});

test('藍底合成掃描頁可在本機辨識及顯示候選', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('desktop'), '實際掃描辨識在桌面執行');
  await page.goto('./#/check/B');
  const jpeg = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 480;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#c1d8eb';
    ctx.fillRect(0, 0, 900, 480);
    ctx.fillStyle = '#aebfd0';
    ctx.font = '56px Microsoft JhengHei';
    ctx.fillText('測試樣張', 470, 235);
    ctx.translate(40, 60);
    ctx.rotate(0.021);
    ctx.fillStyle = '#21364a';
    ctx.font = '42px Microsoft JhengHei';
    ctx.fillText('國稅局查稅資料　合成測試文件', 20, 40);
    ctx.font = '30px Microsoft JhengHei';
    ctx.fillText('第三人：甲測試股份有限公司', 20, 115);
    ctx.fillText('法定代理人：乙測試', 20, 175);
    return canvas.toDataURL('image/jpeg', 0.88).split(',')[1];
  });
  const { buildPdf } = await import('../tests/fixtures/builders');
  const pdf = buildPdf([{ lines: [], raster: { width: 900, height: 480, jpegHex: Buffer.from(jpeg, 'base64').toString('hex') } }]);
  await page.getByTestId('file-input').setInputFiles({ name: '合成查稅資料.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) });
  await expect(page.getByText(/已在本機辨識 1 張掃描頁/)).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: '查看掃描原頁' }).click();
  await page.getByText('辨識原文及其他候選').click();
  const recognized = await page.locator('.viewer-text details pre').allTextContents();
  expect(recognized.join('').replace(/\s/g, '')).toMatch(/測試|代理人|有限公司/);
  const role = page.getByLabel('合成查稅資料.pdf 的文件角色');
  if (await role.inputValue() !== 'tax-record') await role.selectOption('tax-record');
  await expect(role).toHaveValue('tax-record');
  await noHorizontalOverflow(page);
});
