// 本機 OCR（Tesseract.js）。worker、wasm 核心與繁體中文語言檔均由本站提供
// （public/ocr/，由 npm install 自動複製），不連線任何 CDN 或雲端 OCR。
// OCR 結果一律標示信心分數，不可視為已查證事實。

import { openPdf, renderPdfPage } from './pdf';
import type { PageText } from './types';

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

export async function createOcrWorker(onProgress?: (p: number) => void): Promise<TWorker> {
  const { createWorker } = await import('tesseract.js');
  return createWorker('chi_tra', 1 /* LSTM_ONLY */, {
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
  const worker = await createOcrWorker();
  const canvas = document.createElement('canvas');
  const out = pages.map((p) => ({ ...p }));
  try {
    let done = 0;
    for (const t of targets) {
      if (opts.signal?.aborted) throw new DOMException('已取消', 'AbortError');
      await renderPdfPage(pdf, t.page, canvas, 2, opts.lowMemory ? 2_500_000 : 6_000_000);
      const res = await worker.recognize(canvas);
      const text = (res.data.text ?? '').replace(/(?<=[一-鿿]) (?=[一-鿿])/g, '').trim();
      const conf = Math.max(0, Math.min(1, (res.data.confidence ?? 0) / 100));
      const idx = out.findIndex((p) => p.page === t.page);
      out[idx] = {
        ...out[idx],
        text,
        method: 'ocr',
        confidence: conf,
        needsOcr: false,
        ocrFailed: text.replace(/\s/g, '').length < 8 || conf < 0.35,
      };
      done++;
      opts.onPage?.(done, targets.length);
    }
  } finally {
    canvas.width = canvas.height = 0;
    await worker.terminate();
    await pdf.destroy();
  }
  return out;
}
