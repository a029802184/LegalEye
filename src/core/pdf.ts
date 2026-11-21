// PDF 文字層抽取與單頁渲染（PDF.js；在 Web Worker 執行解析）。
// 只渲染目前頁面，避免手機一次把 20 頁以上掃描檔轉成大量全解析度圖片。

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PageText } from './types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

function assetUrl(p: string): string {
  return new URL(p, document.baseURI).href;
}

export type PdfDoc = pdfjs.PDFDocumentProxy;

export async function openPdf(data: Uint8Array): Promise<PdfDoc> {
  // PDF.js 會轉移 buffer 所有權，先複製一份避免原始資料被清空
  const copy = data.slice();
  const task = pdfjs.getDocument({
    data: copy,
    cMapUrl: assetUrl('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('pdfjs/standard_fonts/'),
    isEvalSupported: false,
    enableXfa: false,
  });
  try {
    return await task.promise;
  } catch (e) {
    const name = (e as Error).name;
    if (name === 'PasswordException') throw new Error('PDF 有密碼保護，無法讀取');
    if (name === 'InvalidPDFException') throw new Error('PDF 檔案損毀或格式不正確');
    throw new Error('PDF 無法開啟：' + (e as Error).message);
  }
}

interface TItem {
  str: string;
  transform: number[];
  hasEOL?: boolean;
}

export async function extractPdfText(
  data: Uint8Array,
  opts: { signal?: AbortSignal; onPage?: (p: number, total: number) => void } = {},
): Promise<{ pages: PageText[]; numPages: number }> {
  const pdf = await openPdf(data);
  const pages: PageText[] = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      if (opts.signal?.aborted) throw new DOMException('已取消', 'AbortError');
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      let lastY: number | null = null;
      for (const raw of content.items as TItem[]) {
        if (!('str' in raw)) continue;
        const y = raw.transform[5];
        if (lastY !== null && Math.abs(y - lastY) > 2 && !text.endsWith('\n')) text += '\n';
        text += raw.str;
        if (raw.hasEOL) text += '\n';
        lastY = y;
      }
      text = text.replace(/[ \t]+\n/g, '\n').trim();
      const needsOcr = text.replace(/\s/g, '').length < 12;
      pages.push({
        page: i,
        text,
        method: 'pdf-text',
        confidence: needsOcr ? 0 : 1,
        needsOcr,
        rotationSuspect: page.rotate % 180 !== 0,
      });
      page.cleanup();
      opts.onPage?.(i, pdf.numPages);
    }
    return { pages, numPages: pdf.numPages };
  } finally {
    await pdf.destroy();
  }
}

/** 將單頁渲染到 canvas；maxWidth 控制記憶體用量 */
export async function renderPdfPage(
  pdf: PdfDoc,
  pageNo: number,
  canvas: HTMLCanvasElement,
  scale: number,
  maxPixels = 4_000_000,
): Promise<{ width: number; height: number }> {
  const page = await pdf.getPage(pageNo);
  let viewport = page.getViewport({ scale });
  const px = viewport.width * viewport.height;
  if (px > maxPixels) viewport = page.getViewport({ scale: scale * Math.sqrt(maxPixels / px) });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('瀏覽器無法建立繪圖區');
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();
  return { width: canvas.width, height: canvas.height };
}
