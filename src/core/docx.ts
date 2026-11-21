// DOCX 解析：段落、表格、頁首頁尾、文字方塊，以及 OOXML run 字色（含樣式繼承）。
// 一般純文字擷取器會遺失紅字資訊，因此直接讀 word/document.xml。

import JSZip from 'jszip';
import type { Paragraph, RedSpan, TextRun } from './types';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export interface DocxResult {
  paragraphs: Paragraph[];
  redSpans: RedSpan[];
  pageCount: number;
  warnings: string[];
  /** 是否使用 Word 上次排版的分頁標記（非明確分頁符號） */
  usedRenderedBreaks: boolean;
}

/** 判斷色碼是否為紅色系（明確紅字：R 高、G/B 低） */
export function isRedColor(hex: string | undefined | null): boolean {
  if (!hex) return false;
  const h = hex.replace('#', '').toUpperCase();
  if (h === 'AUTO' || !/^[0-9A-F]{6}$/.test(h)) return false;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return r >= 0xb0 && g <= 0x70 && b <= 0x70 && r - Math.max(g, b) >= 0x60;
}

function kids(el: Element, local?: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstElementChild; n; n = n.nextElementSibling) {
    if (!local || n.localName === local) out.push(n);
  }
  return out;
}

function kid(el: Element | null | undefined, local: string): Element | null {
  if (!el) return null;
  for (let n = el.firstElementChild; n; n = n.nextElementSibling) if (n.localName === local) return n;
  return null;
}

function attr(el: Element | null, name: string): string | null {
  if (!el) return null;
  return el.getAttributeNS(W, name) ?? el.getAttribute('w:' + name);
}

interface StyleInfo {
  basedOn?: string;
  color?: string;
}

function parseStyles(xml: Document | null): { styles: Map<string, StyleInfo>; defaultColor?: string } {
  const styles = new Map<string, StyleInfo>();
  let defaultColor: string | undefined;
  if (!xml) return { styles };
  const root = xml.documentElement;
  const dd = kid(root, 'docDefaults');
  const rprDef = kid(kid(dd, 'rPrDefault'), 'rPr');
  defaultColor = attr(kid(rprDef, 'color'), 'val') ?? undefined;
  for (const s of kids(root, 'style')) {
    const id = attr(s, 'styleId');
    if (!id) continue;
    const basedOn = attr(kid(s, 'basedOn'), 'val') ?? undefined;
    const color = attr(kid(kid(s, 'rPr'), 'color'), 'val') ?? undefined;
    styles.set(id, { basedOn, color });
  }
  return { styles, defaultColor };
}

function styleColor(styles: Map<string, StyleInfo>, id: string | null | undefined): string | undefined {
  let cur = id ?? undefined;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const s = styles.get(cur);
    if (!s) return undefined;
    if (s.color) return s.color;
    cur = s.basedOn;
  }
  return undefined;
}

interface Ctx {
  styles: Map<string, StyleInfo>;
  defaultColor?: string;
  paragraphs: Paragraph[];
  page: number;
  explicitBreaks: number;
  renderedBreaks: number;
  useRendered: boolean;
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('XML 結構錯誤');
  return doc;
}

function collectRuns(container: Element, out: { runs: TextRun[]; breaksAfter: number; renderedBreaksBefore: number }, ctx: Ctx, pColor: string | undefined) {
  for (const n of kids(container)) {
    switch (n.localName) {
      case 'r': {
        const rPr = kid(n, 'rPr');
        const direct = attr(kid(rPr, 'color'), 'val');
        const rStyle = attr(kid(rPr, 'rStyle'), 'val');
        const color = direct ?? styleColor(ctx.styles, rStyle) ?? pColor ?? ctx.defaultColor;
        let text = '';
        for (const c of kids(n)) {
          if (c.localName === 't') text += c.textContent ?? '';
          else if (c.localName === 'tab') text += '\t';
          else if (c.localName === 'noBreakHyphen') text += '-';
          else if (c.localName === 'br') {
            const type = attr(c, 'type');
            if (type === 'page') {
              if (text) out.runs.push({ text, red: isRedColor(color), color: color ?? undefined });
              text = '';
              out.runs.push({ text: '\f', red: false });
              ctx.explicitBreaks++;
            } else text += '\n';
          } else if (c.localName === 'lastRenderedPageBreak') {
            ctx.renderedBreaks++;
            if (ctx.useRendered) {
              if (text) out.runs.push({ text, red: isRedColor(color), color: color ?? undefined });
              text = '';
              out.runs.push({ text: '\f', red: false });
            }
          }
        }
        if (text) out.runs.push({ text, red: isRedColor(color), color: color ?? undefined });
        break;
      }
      case 'del':
      case 'moveFrom':
        break; // 追蹤修訂的刪除文字不列入
      case 'ins':
      case 'moveTo':
      case 'hyperlink':
      case 'smartTag':
      case 'fldSimple':
      case 'customXml':
        collectRuns(n, out, ctx, pColor);
        break;
      case 'sdt':
        collectRuns(kid(n, 'sdtContent') ?? n, out, ctx, pColor);
        break;
      default:
        break;
    }
  }
}

function handleParagraph(p: Element, ctx: Ctx, part: Paragraph['part']) {
  const pPr = kid(p, 'pPr');
  if (kid(pPr, 'pageBreakBefore') && attr(kid(pPr, 'pageBreakBefore'), 'val') !== '0' && ctx.paragraphs.length) {
    ctx.page++;
    ctx.explicitBreaks++;
  }
  const pStyle = attr(kid(pPr, 'pStyle'), 'val');
  const pColor = styleColor(ctx.styles, pStyle);
  const acc = { runs: [] as TextRun[], breaksAfter: 0, renderedBreaksBefore: 0 };
  collectRuns(p, acc, ctx, pColor);
  // 依分頁符號把段落拆開，讓每一頁的文字歸屬正確
  let cur: TextRun[] = [];
  const flush = () => {
    const text = cur.map((r) => r.text).join('');
    ctx.paragraphs.push({ index: ctx.paragraphs.length, page: ctx.page, part, text, runs: mergeRuns(cur) });
    cur = [];
  };
  for (const r of acc.runs) {
    if (r.text === '\f') {
      if (cur.length) flush();
      ctx.page++;
    } else cur.push(r);
  }
  flush();
  // 段落內的分節符號（非最後一節）預設為「下一頁」
  const sect = kid(pPr, 'sectPr');
  if (sect) {
    const type = attr(kid(sect, 'type'), 'val');
    if (!type || type === 'nextPage' || type === 'oddPage' || type === 'evenPage') {
      ctx.page++;
      ctx.explicitBreaks++;
    }
  }
}

function mergeRuns(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && last.red === r.red) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

function walkBlock(el: Element, ctx: Ctx, part: Paragraph['part']) {
  for (const n of kids(el)) {
    if (n.localName === 'p') handleParagraph(n, ctx, part);
    else if (n.localName === 'tbl') {
      for (const tr of kids(n, 'tr')) for (const tc of kids(tr, 'tc')) walkBlock(tc, ctx, 'table');
    } else if (n.localName === 'sdt') walkBlock(kid(n, 'sdtContent') ?? n, ctx, part);
    else if (n.localName === 'customXml') walkBlock(n, ctx, part);
  }
}

export async function parseDocx(data: Uint8Array): Promise<DocxResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new Error('DOCX 檔無法開啟（可能已損毀、加密，或其實不是 DOCX）');
  }
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('找不到 word/document.xml，這不是有效的 DOCX 文件');
  const warnings: string[] = [];
  const doc = parseXml(await docFile.async('string'));
  const stylesFile = zip.file('word/styles.xml');
  const { styles, defaultColor } = parseStyles(stylesFile ? parseXml(await stylesFile.async('string')) : null);
  const body = doc.getElementsByTagNameNS(W, 'body')[0] ?? doc.documentElement;

  const run = (useRendered: boolean): Ctx => {
    const ctx: Ctx = { styles, defaultColor, paragraphs: [], page: 1, explicitBreaks: 0, renderedBreaks: 0, useRendered };
    walkBlock(body, ctx, 'body');
    return ctx;
  };
  let ctx = run(false);
  let usedRenderedBreaks = false;
  if (ctx.explicitBreaks === 0 && ctx.renderedBreaks > 0) {
    ctx = run(true);
    usedRenderedBreaks = true;
    warnings.push('文件沒有明確分頁符號，已依 Word 上次排版的分頁位置切頁；若頁面歸屬不正確請人工確認。');
  }

  // 文字方塊
  const txbx = doc.getElementsByTagNameNS(W, 'txbxContent');
  if (txbx.length) {
    const seenText = new Set<string>();
    let added = 0;
    for (const t of Array.from(txbx)) {
      const before = ctx.paragraphs.length;
      walkBlock(t, ctx, 'body');
      const newOnes = ctx.paragraphs.splice(before);
      for (const p of newOnes) {
        if (!p.text.trim() || seenText.has(p.text)) continue;
        seenText.add(p.text);
        p.index = ctx.paragraphs.length;
        ctx.paragraphs.push(p);
        added++;
      }
    }
    if (added) warnings.push(`文件含 ${added} 段文字方塊內容，已附加在內文最後，頁碼可能不精確。`);
  }

  // 頁首頁尾
  const hf = Object.keys(zip.files).filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n)).sort();
  for (const name of hf) {
    try {
      const x = parseXml(await zip.file(name)!.async('string'));
      const part = name.includes('header') ? 'header' : 'footer';
      const tmp: Ctx = { ...ctx, paragraphs: [], page: 0 };
      walkBlock(x.documentElement, tmp, part);
      for (const p of tmp.paragraphs) {
        if (!p.text.trim()) continue;
        p.index = ctx.paragraphs.length;
        ctx.paragraphs.push(p);
      }
    } catch {
      warnings.push(`頁首／頁尾 ${name} 無法解析`);
    }
  }
  if (hf.length) warnings.push('頁首／頁尾文字已讀取（頁碼標示為 0，代表適用於所有頁）。');
  if (zip.file('word/comments.xml')) warnings.push('文件含註解（Comments），註解內容未列入比對。');

  const redSpans: RedSpan[] = [];
  for (const p of ctx.paragraphs) {
    let off = 0;
    for (const r of p.runs) {
      if (r.red && r.text.trim()) redSpans.push({ text: r.text, page: p.page, para: p.index, offset: off });
      off += r.text.length;
    }
  }
  const pageCount = Math.max(1, ...ctx.paragraphs.filter((p) => p.page > 0).map((p) => p.page));
  return { paragraphs: ctx.paragraphs, redSpans, pageCount, warnings, usedRenderedBreaks };
}
