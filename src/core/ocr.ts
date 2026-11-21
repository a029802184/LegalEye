// 本機 OCR（Tesseract.js）。worker、wasm 核心與繁體中文語言檔均由本站提供
// （public/ocr/，由 npm install 自動複製），不連線任何 CDN 或雲端 OCR。
// 文字與候選保留在本機，信心僅供後續分流。

import { openPdf, renderPdfPage } from './pdf';
import type { PageRegion, PageText } from './types';

function assetUrl(p: string): string {
  return new URL(p, document.baseURI).href;
}

export async function ocrAvailable(): Promise<boolean> {
  try {
    const r = await fetch(assetUrl('ocr/lang/chi_tra.traineddata.gz'), { method: 'HEAD' });
    return r.ok;
  } catch {
    return false;
  }
}

type TWorker = Awaited<ReturnType<(typeof import('tesseract.js'))['createWorker']>>;

function enhance(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rgba = image.data;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < rgba.length; i += 4) {
    const gray = Math.round(rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114);
    histogram[gray]++;
  }
  let sum = 0;
  let white = 255;
  for (let i = 0; i < 256; i++) {
    sum += histogram[i];
    if (sum >= rgba.length / 4 * 0.9) { white = i; break; }
  }
  const gain = 255 / Math.max(110, white);
  for (let i = 0; i < rgba.length; i += 4) {
    const gray = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) * gain;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = gray;
  }
  ctx.putImageData(image, 0, 0);
}

function cleanOcr(text: string) {
  return text.replace(/(?<=[一-鿿])[ \t]+(?=[一-鿿])/g, '').trim();
}

function cropContent(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  let left = width, top = height, right = 0, bottom = 0;
  for (let y = 0; y < height; y += 3) for (let x = 0; x < width; x += 3) {
    const i = (y * width + x) * 4;
    if (data[i + 3] > 100 && Math.min(data[i], data[i + 1], data[i + 2]) < 238) {
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right - left < 18 || bottom - top < 18) return { canvas, left: 0, top: 0 };
  left = Math.max(0, left - 24);
  top = Math.max(0, top - 24);
  const cropped = document.createElement('canvas');
  cropped.width = Math.min(width - left, right - left + 24);
  cropped.height = Math.min(height - top, bottom - top + 24);
  cropped.getContext('2d')!.drawImage(canvas, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
  return { canvas: cropped, left, top };
}

export async function renderScanRegion(data: Uint8Array, page: number, region?: PageRegion, lowMemory = false) {
  const pdf = await openPdf(data);
  const canvas = document.createElement('canvas');
  try {
    await renderPdfPage(pdf, page, canvas, 3, lowMemory ? 2_500_000 : 7_000_000);
    if (!region) return canvas;
    const out = document.createElement('canvas');
    const w = Math.max(1, Math.ceil(region.width * canvas.width));
    const h = Math.max(1, Math.ceil(region.height * canvas.height));
    const scale = Math.min(2, Math.sqrt(2_000_000 / (w * h)));
    out.width = Math.max(1, Math.round(w * scale));
    out.height = Math.max(1, Math.round(h * scale));
    out.getContext('2d')!.drawImage(canvas, region.left * canvas.width, region.top * canvas.height, w, h, 0, 0, out.width, out.height);
    canvas.width = canvas.height = 0;
    return out;
  } finally { await pdf.destroy(); }
}

export async function retryScan(data: Uint8Array, page: number, region?: PageRegion, lowMemory = false) {
  const canvas = await renderScanRegion(data, page, region, lowMemory);
  let worker: TWorker | undefined;
  try {
    enhance(canvas);
    worker = await createOcrWorker();
    if (region) {
      const { PSM } = await import('tesseract.js');
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
    }
    return (await worker.recognize(canvas)).data.text.trim();
  } finally {
    canvas.width = canvas.height = 0;
    await worker?.terminate();
  }
}

export async function createOcrWorker(onProgress?: (p: number) => void): Promise<TWorker> {
  const { createWorker, PSM } = await import('tesseract.js');
  const worker = await createWorker('chi_tra', 1 /* LSTM_ONLY */, {
    workerPath: assetUrl('ocr/worker.min.js'),
    corePath: assetUrl('ocr/'),
    langPath: assetUrl('ocr/lang'),
    gzip: true,
    workerBlobURL: false,
    cacheMethod: 'none',
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') onProgress?.(m.progress);
    },
  });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
  return worker;
}

/** 對 PDF 中需要 OCR 的頁面逐頁辨識（一次只渲染一頁） */
export async function ocrPdfPages(
  data: Uint8Array,
  pages: PageText[],
  opts: { signal?: AbortSignal; onPage?: (done: number, total: number) => void; lowMemory?: boolean } = {},
): Promise<PageText[]> {
  const targets = pages.filter((p) => p.needsOcr);
  if (!targets.length) return pages;
  const pdf = await openPdf(data);
  let worker: TWorker | undefined;
  const canvas = document.createElement('canvas');
  const out = pages.map((p) => ({ ...p }));
  try {
    worker = await createOcrWorker();
    let done = 0;
    for (const t of targets) {
      if (opts.signal?.aborted) throw new DOMException('已取消', 'AbortError');
      opts.onPage?.(done + 1, targets.length);
      await renderPdfPage(pdf, t.page, canvas, 2, opts.lowMemory ? 2_500_000 : 6_000_000);
      const res = await worker.recognize(canvas);
      const raw = res.data.text ?? '';
      let selected = res.data;
      let alternate: string | undefined;
      let left = 0, top = 0;
      if (!opts.signal?.aborted && ((selected.confidence ?? 0) < 55 || cleanOcr(raw).length < 8)) {
        const frame = cropContent(canvas);
        try {
          enhance(frame.canvas);
          const { PSM } = await import('tesseract.js');
          await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
          const contrast = (await worker.recognize(frame.canvas)).data;
          await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
          if (cleanOcr(contrast.text) !== cleanOcr(raw)) alternate = contrast.text;
          if (!raw.trim() && contrast.text.trim()) {
            selected = contrast;
            ({ left, top } = frame);
          }
        } finally {
          if (frame.canvas !== canvas) frame.canvas.width = frame.canvas.height = 0;
        }
      }
      const text = cleanOcr(selected.text);
      const conf = Math.max(0, Math.min(1, (selected.confidence ?? 0) / 100));
      const idx = out.findIndex((p) => p.page === t.page);
      out[idx] = {
        ...out[idx],
        text,
        method: 'ocr',
        confidence: conf,
        needsOcr: false,
        ocrFailed: text.replace(/\s/g, '').length < 8 || conf < 0.35,
        scan: { raw, alternate, lines: (selected.lines ?? []).map(({ text, bbox }) => ({ text, region: {
          left: (bbox.x0 + left) / canvas.width, top: (bbox.y0 + top) / canvas.height,
          width: (bbox.x1 - bbox.x0) / canvas.width, height: (bbox.y1 - bbox.y0) / canvas.height,
        } })) },
      };
      done++;
    }
  } finally {
    canvas.width = canvas.height = 0;
    await worker?.terminate();
    await pdf.destroy();
  }
  return out;
}
