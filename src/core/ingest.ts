// 匯入管線：檔案／ZIP → 安全解壓 → 依類型解析 → （必要時）本機 OCR → 內容分類。
// 分批執行並讓出主執行緒；PDF 解析與 OCR 在各自的 Web Worker 中進行；可隨時取消。

import { parseDocx } from './docx';
import { readXlsx, sheetText } from './xlsx';
import { safeUnzip, type SkippedEntry, type ZipLimits } from './zip';
import { sha256Hex } from './hash';
import { classifyDoc, pickRole } from './classify';
import type { DocRole, ExtractedDoc, FileKind, PageText, SourceFile } from './types';
import { uid } from './text';

export interface InputFile {
  name: string;
  data: Uint8Array;
}

export interface IngestProgress {
  phase: 'unzip' | 'parse' | 'ocr' | 'classify' | 'done';
  done: number;
  total: number;
  label: string;
}

export interface IngestOptions {
  signal?: AbortSignal;
  onProgress?: (p: IngestProgress) => void;
  /** 掃描 PDF 是否執行本機 OCR */
  ocr?: boolean;
  lowMemory?: boolean;
  zipLimits?: Partial<ZipLimits>;
  allowedRoles?: DocRole[];
  /** 測試或無 PDF.js 環境可注入 */
  pdfExtractor?: (data: Uint8Array, signal?: AbortSignal) => Promise<PageText[]>;
}

export interface IngestResult {
  docs: ExtractedDoc[];
  skipped: SkippedEntry[];
  folders: string[];
  errors: string[];
}

export const MAX_SINGLE_FILE = 80 * 1024 * 1024;

export function kindOf(name: string): FileKind {
  const ext = (/\.([^.]+)$/.exec(name)?.[1] ?? '').toLowerCase();
  if (ext === 'pdf' || ext === 'docx' || ext === 'xlsx' || ext === 'txt' || ext === 'csv' || ext === 'zip') return ext;
  return 'other';
}

export function decodeText(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('big5').decode(data);
  }
}

const yieldUI = () => new Promise((r) => setTimeout(r, 0));

export async function parseOne(file: SourceFile, opts: IngestOptions): Promise<ExtractedDoc> {
  const base: ExtractedDoc = { file, status: 'ok', warnings: [], pages: [], fullText: '', role: 'unknown', roleCandidates: [] };
  try {
    switch (file.kind) {
      case 'docx': {
        const r = await parseDocx(file.data);
        base.paragraphs = r.paragraphs;
        base.redSpans = r.redSpans;
        base.warnings.push(...r.warnings);
        const pages: PageText[] = [];
        for (let p = 1; p <= r.pageCount; p++) {
          const text = r.paragraphs.filter((x) => x.page === p).map((x) => x.text).join('\n');
          pages.push({ page: p, text, method: 'docx', confidence: 1 });
        }
        base.pages = pages;
        base.fullText = r.paragraphs.map((x) => x.text).join('\n');
        if (!base.fullText.trim()) {
          base.status = 'partial';
          base.warnings.push('DOCX 沒有可讀取的文字（可能只有圖片）');
        }
        break;
      }
      case 'xlsx': {
        const r = await readXlsx(file.data);
        base.sheets = r.sheets;
        base.warnings.push(...r.warnings);
        base.pages = r.sheets.map((s, i) => ({ page: i + 1, text: `【工作表：${s.name}】\n` + sheetText(s), method: 'xlsx' as const, confidence: 1 }));
        base.fullText = base.pages.map((p) => p.text).join('\n');
        if (r.warnings.some((w) => w.includes('公式'))) base.status = 'partial';
        break;
      }
      case 'txt':
      case 'csv': {
        const text = decodeText(file.data);
        // 以換頁字元（\f）分頁，方便以文字檔代表多頁文件
        const parts = text.split('\f');
        base.pages = parts.map((t, i) => ({ page: i + 1, text: t.trim(), method: 'txt' as const, confidence: 1 }));
        base.fullText = text.replace(/\f/g, '\n');
        break;
      }
      case 'pdf': {
        const extractor =
          opts.pdfExtractor ??
          (async (d: Uint8Array, signal?: AbortSignal) => (await (await import('./pdf')).extractPdfText(d, { signal })).pages);
        let pages = await extractor(file.data, opts.signal);
        const scan = pages.filter((p) => p.needsOcr).length;
        if (scan && opts.ocr) {
          const { ocrPdfPages } = await import('./ocr');
          pages = await ocrPdfPages(file.data, pages, {
            signal: opts.signal,
            lowMemory: opts.lowMemory,
            onPage: (d, t) => opts.onProgress?.({ phase: 'ocr', done: d, total: t, label: file.name }),
          });
          const failed = pages.filter((p) => p.ocrFailed).length;
          base.warnings.push(`已在本機辨識 ${scan} 張掃描頁${failed ? `，其中 ${failed} 頁的文字需要看原件確認` : ''}。`);
          base.status = failed ? 'partial' : 'ok';
        } else if (scan) {
          base.warnings.push(`有 ${scan} 頁為掃描圖片。啟用掃描文字辨識後可重新讀取。`);
          base.status = scan === pages.length ? 'needs-ocr' : 'partial';
        }
        if (pages.some((p) => p.rotationSuspect)) base.warnings.push('部分頁面為橫向或旋轉，請核對原頁影像。');
        base.pages = pages;
        base.fullText = pages.map((p) => p.text).join('\n');
        break;
      }
      default:
        base.status = 'unsupported';
        base.warnings.push('不支援的檔案類型');
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    base.status = 'error';
    base.warnings.push((e as Error).message);
  }
  base.roleCandidates = classifyDoc(base, opts.allowedRoles);
  base.role = pickRole(base.roleCandidates);
  return base;
}

export async function ingest(inputs: InputFile[], opts: IngestOptions = {}): Promise<IngestResult> {
  const skipped: SkippedEntry[] = [];
  const errors: string[] = [];
  const folders: string[] = [];
  const files: { path: string; name: string; data: Uint8Array }[] = [];

  for (const f of inputs) {
    const k = kindOf(f.name);
    if (k === 'zip') {
      opts.onProgress?.({ phase: 'unzip', done: 0, total: 1, label: f.name });
      try {
        const r = await safeUnzip(f.data, {
          limits: opts.zipLimits,
          signal: opts.signal,
          onProgress: (d, t, p) => opts.onProgress?.({ phase: 'unzip', done: d, total: t, label: p }),
        });
        files.push(...r.files);
        skipped.push(...r.skipped);
        folders.push(...r.folders);
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        errors.push(`${f.name}：${(e as Error).message}`);
      }
    } else if (k === 'other') {
      skipped.push({ path: f.name, reason: '不支援的檔案類型' });
    } else if (f.data.length > MAX_SINGLE_FILE) {
      skipped.push({ path: f.name, reason: '檔案超過 80 MB 上限' });
    } else {
      files.push({ path: f.name, name: f.name, data: f.data });
    }
  }

  const docs: ExtractedDoc[] = [];
  let i = 0;
  for (const f of files) {
    if (opts.signal?.aborted) throw new DOMException('已取消', 'AbortError');
    opts.onProgress?.({ phase: 'parse', done: i, total: files.length, label: f.path });
    const src: SourceFile = { id: uid('f'), name: f.name, path: f.path, kind: kindOf(f.name), size: f.data.length, sha256: sha256Hex(f.data), data: f.data };
    docs.push(await parseOne(src, opts));
    i++;
    await yieldUI();
  }
  opts.onProgress?.({ phase: 'done', done: files.length, total: files.length, label: '完成' });
  return { docs, skipped, folders, errors };
}
