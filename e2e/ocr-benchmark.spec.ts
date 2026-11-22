import { expect, test } from '@playwright/test';
import { buildPdf } from '../tests/fixtures/builders';

test('11 頁掃描合併檔記錄每頁處理時間', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('desktop'), '效能樣本在固定桌面尺寸測量');
  info.setTimeout(240_000);
  await page.goto('./#/check/C');
  await expect(page.getByText('掃描文字辨識已準備好，可在本機處理檔案。')).toBeVisible();
  const images = await page.evaluate(() => Array.from('甲乙丙丁戊己庚辛壬癸子', (name, index) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1100;
    canvas.height = 535;
    const ctx = canvas.getContext('2d')!;
    const difficult = index % 4 === 2;
    ctx.fillStyle = difficult ? '#c1d8eb' : '#ffffff';
    ctx.fillRect(0, 0, 1100, 535);
    ctx.translate(35, 35);
    if (difficult) ctx.rotate(0.023);
    ctx.fillStyle = difficult ? '#34536d' : '#121212';
    ctx.font = `${difficult ? 27 : 38}px Microsoft JhengHei`;
    [
      `戶籍謄本　合成樣張　第 ${index + 1} 頁`,
      `姓名：林測${name}　國民身分證統一編號：Y1****${2100 + index}`,
      `戶籍地址：新北市甲區甲里020鄰甲路98巷${index + 10}號`,
      `總欠費：新臺幣${14876 + index}元`,
    ].forEach((line, row) => ctx.fillText(line, 6, 66 + row * 92));
    return canvas.toDataURL('image/jpeg', difficult ? 0.58 : 0.90).split(',')[1];
  }));
  const pdf = buildPdf(images.map((data) => ({ lines: [], raster: { width: 1100, height: 535, jpegHex: Buffer.from(data, 'base64').toString('hex') } })));
  await page.evaluate(() => {
    const samples = [{ page: 0, at: performance.now() }];
    const observer = new MutationObserver(() => {
      const status = [...document.querySelectorAll('[role="status"]')].map((el) => el.textContent).join(' ');
      const match = /第 (\d+)／11 掃描頁/.exec(status);
      if (match && !samples.some((sample) => sample.page === Number(match[1]))) samples.push({ page: Number(match[1]), at: performance.now() });
      if (document.querySelector('#h-files')) {
        samples.push({ page: 12, at: performance.now() });
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    Object.assign(window, { legalEyeOcrSampleTiming: samples });
  });
  await page.getByTestId('file-input').setInputFiles({ name: '戶籍謄本_合成十一頁.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) });
  await expect(page.getByText(/已在本機辨識 11 張掃描頁/)).toBeVisible({ timeout: 210_000 });
  const samples = await page.evaluate(() => (window as unknown as { legalEyeOcrSampleTiming: { page: number; at: number }[] }).legalEyeOcrSampleTiming);
  expect(samples.map((sample) => sample.page)).toEqual(Array.from({ length: 13 }, (_, i) => i));
  const ms = samples.slice(1, -1).map((sample, index) => Math.round(samples[index + 2].at - sample.at));
  await page.getByRole('button', { name: '查看掃描原頁' }).click();
  const found = { name: 0, identifier: 0, address: 0, amount: 0 };
  const names = [...'甲乙丙丁戊己庚辛壬癸子'];
  for (const [index, name] of names.entries()) {
    await page.locator('.viewer-bar select').selectOption(String(index + 1), { timeout: 5_000 });
    const preview = page.locator('.viewer-text').filter({ hasText: '電腦從掃描圖片讀出的文字' });
    const recognized = (await preview.innerText({ timeout: 5_000 })).normalize('NFKC').replace(/\s/g, '');
    if (recognized.includes(`林測${name}`)) found.name++;
    if (recognized.includes(`Y1****${2100 + index}`)) found.identifier++;
    if (recognized.includes(`甲路98巷${index + 10}號`)) found.address++;
    if (recognized.includes(`${14876 + index}元`)) found.amount++;
  }
  const timing = JSON.stringify({ pageMs: ms, totalMs: Math.round(samples[12].at - samples[0].at), recognizedOf11: found });
  await info.attach('合成 11 頁 Tesseract 本機處理時間', { body: timing, contentType: 'application/json' });
  await info.attach('合成 11 頁純掃描 PDF', { body: Buffer.from(pdf), contentType: 'application/pdf' });
  console.log(`V4 11-page benchmark ${timing}`);
});
