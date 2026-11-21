// 將 Tesseract.js 的 worker、wasm 核心與繁體中文語言檔複製到 public/ocr/，
// 讓網站在完全離線（無 CDN）的情況下仍可執行本機 OCR。
// 執行時機：npm install 後自動執行；也可手動 `npm run ocr:assets`。
import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'public', 'ocr');
mkdirSync(join(out, 'lang'), { recursive: true });

function copy(from, to) {
  if (!existsSync(from)) {
    console.warn(`[ocr-assets] 找不到 ${from}，略過（OCR 將顯示「未安裝語言資料」）`);
    return false;
  }
  copyFileSync(from, to);
  return true;
}

copy(join(nm, 'tesseract.js', 'dist', 'worker.min.js'), join(out, 'worker.min.js'));

const coreDir = join(nm, 'tesseract.js-core');
if (existsSync(coreDir)) {
  for (const f of readdirSync(coreDir)) {
    // 只需 LSTM 引擎版本（含 SIMD 加速版），減少部署體積
    if (/^tesseract-core(-simd)?-lstm\.(wasm\.js|wasm|js)$/.test(f)) copy(join(coreDir, f), join(out, f));
  }
}

// @tesseract.js-data/chi_tra 提供 4.0.0_best_int 版語言檔（.traineddata.gz）
const langPkg = join(nm, '@tesseract.js-data', 'chi_tra');
let langOk = false;
if (existsSync(langPkg)) {
  const stack = [langPkg];
  while (stack.length && !langOk) {
    const dir = stack.pop();
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) stack.push(p);
      else if (f.name === 'chi_tra.traineddata.gz' && p.includes('best_int')) {
        langOk = copy(p, join(out, 'lang', 'chi_tra.traineddata.gz'));
        break;
      }
    }
  }
}
console.log(`[ocr-assets] 完成；繁中語言檔：${langOk ? '已複製' : '未找到（可手動放入 public/ocr/lang/chi_tra.traineddata.gz）'}`);

// PDF.js：中文字型 CMap 與標準字型資料（離線提供，抽取繁中文字層與渲染需要）
import { cpSync } from 'node:fs';
const pdfjsDir = join(nm, 'pdfjs-dist');
if (existsSync(pdfjsDir)) {
  for (const sub of ['cmaps', 'standard_fonts']) {
    const from = join(pdfjsDir, sub);
    if (existsSync(from)) cpSync(from, join(root, 'public', 'pdfjs', sub), { recursive: true });
  }
  console.log('[pdfjs-assets] 已複製 cmaps 與 standard_fonts 到 public/pdfjs/');
}
