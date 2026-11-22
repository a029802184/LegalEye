import { expect, test } from '@playwright/test';
import { buildPdf, fakeId } from '../tests/fixtures/builders';
import { captureDownloads, nextDownload } from './downloads';

const personId = fakeId('Y', '10000001');
const address = '新北市甲區甲里20鄰甲路98巷3號';
const text = `戶籍謄本\n姓名：林測試國民身分證統一編號：${personId}\n戶籍地址：241 ${address.replace('20鄰', '020鄰')}`;

test('逐頁貼入、來源檢視、人工確認及遮罩報告只走本機', async ({ page }, info) => {
  const unexpected: string[] = [];
  const logged: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && (url.origin !== 'http://localhost:4173' || !['GET', 'HEAD'].includes(request.method()) || request.postData())) unexpected.push(`${request.method()} ${url.origin}`);
  });
  page.on('console', (message) => logged.push(message.text()));
  await captureDownloads(page);
  await page.goto('./#/check/C');
  await page.getByRole('checkbox', { name: '自動辨識掃描文件中的文字' }).uncheck();
  const petition = buildPdf([{ lines: ['支付命令聲請狀', '案件編號：70010001', '債務人：林測試', `身分證字號：${personId}`, `住所：${address}`, '請求本金新臺幣14,876元'] }]);
  const source = buildPdf([{ lines: [], scanned: true }, { lines: [], scanned: true }]);
  await page.getByTestId('file-input').setInputFiles([
    { name: '支付命令聲請狀.pdf', mimeType: 'application/pdf', buffer: Buffer.from(petition) },
    { name: '合成戶籍謄本.pdf', mimeType: 'application/pdf', buffer: Buffer.from(source) },
  ]);
  await expect(page.getByRole('heading', { name: '檔案辨識與確認' })).toBeVisible();
  await page.getByRole('button', { name: '使用 Chrome 協助讀取掃描文件' }).click();
  const form = page.locator('#chrome-text-form');
  await expect(form.getByText(/等文字可反白選取後/)).toBeVisible();
  await form.getByLabel('案件／當事人').selectOption({ index: 1 });
  await form.getByLabel('原始 PDF').selectOption({ label: '合成戶籍謄本.pdf' });
  await form.getByLabel('文件類型').selectOption('household-register');
  await form.getByLabel('原件頁碼').selectOption('2');
  await form.getByRole('button', { name: '檢查這一頁' }).click();
  await expect(form.locator('canvas')).toBeVisible();
  await expect.poll(() => form.locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBeGreaterThan(100);
  await form.getByRole('button', { name: '收合原件' }).click();
  if (info.project.name.startsWith('phone')) {
    await form.getByLabel('從本機匯入一頁純文字（.txt）').setInputFiles({ name: 'p2.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
    await expect(form.getByLabel('貼上 Chrome 辨識的文字')).toHaveValue(text);
  } else await form.getByLabel('貼上 Chrome 辨識的文字').fill(text);
  expect(await page.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('v4-chrome-paste.png') });
  await form.getByRole('button', { name: '重新核對這一頁' }).click();
  await expect(page.getByText(/第 2 頁・已比對此段文字/)).toBeVisible();
  const addressRow = page.getByRole('button', { name: /^地址（戶籍）/ });
  await addressRow.click();
  const field = addressRow.locator('..');
  await expect(field.getByText(/由使用者從 Chrome PDF 貼入/).first()).toBeVisible();
  const correction = field.getByText('更正讀取結果').first();
  await correction.click();
  await field.getByLabel('人工確認為').fill(address);
  await field.getByRole('button', { name: '儲存更正並重算' }).click();
  await expect(addressRow).toContainText('已由人工確認，欄位一致');
  expect(await page.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('v4-chrome-results.png') });
  await page.getByRole('button', { name: '下載核對報告' }).click();
  const { text: report } = await nextDownload(page, /核對報告.*\.html$/);
  expect(report).toContain('由使用者從 Chrome PDF 貼入');
  expect(report).not.toContain(personId);
  await page.getByRole('button', { name: '清除本次資料' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '清除', exact: true }).click();
  await expect(page.getByText(/第 2 頁・已比對此段文字/)).toHaveCount(0);
  expect(await page.evaluate((id) => Object.values(localStorage).join('').includes(id) || Object.values(sessionStorage).join('').includes(id), personId)).toBe(false);
  expect(logged.some((message) => message.includes(personId))).toBe(false);
  expect(unexpected).toEqual([]);
});
