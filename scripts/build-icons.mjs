// 由 src/ui/legaleye-icon.svg 同步品牌圖示並產生 PNG 與 favicon.ico。
// 使用 Playwright 驅動本機已安裝的 Microsoft Edge 進行點陣化：npm run icons
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = join(root, 'public', 'icons');
const svg = readFileSync(join(root, 'src', 'ui', 'legaleye-icon.svg'), 'utf8');
writeFileSync(join(iconsDir, 'legaleye-icon.svg'), svg);
const sizes = [32, 64, 180, 192, 512];

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 640, height: 640 } });
const out = {};
for (const size of sizes) {
  await page.setContent(
    `<html><body style="margin:0;background:transparent">` +
      svg.replace('<svg ', `<svg width="${size}" height="${size}" `) +
      `</body></html>`,
  );
  out[size] = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  writeFileSync(join(iconsDir, `legaleye-icon-${size}.png`), out[size]);
}
await browser.close();

// favicon.ico：內嵌 32×32 PNG（現代瀏覽器皆支援 PNG 格式的 ICO）
const png = out[32];
const header = Buffer.alloc(6 + 16);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header.writeUInt8(32, 6);
header.writeUInt8(32, 7);
header.writeUInt8(0, 8);
header.writeUInt8(0, 9);
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);
writeFileSync(join(root, 'public', 'favicon.ico'), Buffer.concat([header, png]));

// 同步一份到 brand/legaleye 作為品牌素材包
const brandDir = join(root, 'brand', 'legaleye');
mkdirSync(brandDir, { recursive: true });
copyFileSync(join(iconsDir, 'legaleye-icon.svg'), join(brandDir, 'legaleye-icon.svg'));
writeFileSync(join(brandDir, 'legaleye-monochrome.svg'), svg.replace(/\s*<rect[^>]*\/>/, '').replaceAll('#203955', 'currentColor'));
for (const s of sizes) copyFileSync(join(iconsDir, `legaleye-icon-${s}.png`), join(brandDir, `legaleye-icon-${s}.png`));
copyFileSync(join(root, 'public', 'favicon.ico'), join(brandDir, 'favicon.ico'));
console.log('icons generated:', sizes.join(', '), '+ favicon.ico');
