// 四個核對流程共用的工具：證據建立、頁碼／段落定位、檢查項目建立。

import type { CheckItem, CheckStatus, Evidence, ExtractedDoc, FieldCorrection, FieldCorrectionTarget, Provenance, Severity } from '../core/types';
import { disabledReason, type Settings } from '../core/rules';
import { snippet, stripSpaces, uid } from '../core/text';
import { partyBlocks } from '../core/extract';

export interface FlowContext {
  settings: Settings;
  corrections?: Record<string, FieldCorrection>;
}

export interface PageHit<T> {
  hit: T;
  page: number;
  prov: Provenance;
}

/** 切開合併書狀中獨立的具名當事人區塊，保留原頁及頁內位移。 */
export function petitionSections(doc: ExtractedDoc): ExtractedDoc[] {
  const offsets: number[] = [];
  let end = 0;
  for (const page of doc.pages) {
    offsets.push(end);
    end += page.text.normalize('NFKC').length + 1;
  }
  const text = doc.pages.map((p) => p.text.normalize('NFKC')).join('\n');
  const labels = partyBlocks(text);
  const debtors = labels.filter((p) => /^(?:相對人|債務人)/.test(p.role));
  const headers = doc.pages.flatMap((p, i) => i > 0 && /^(?:民事.{0,5}強制執行.{0,2}聲請狀|支付命令聲請狀)/.test(stripSpaces(p.text).slice(0, 32)) ? [offsets[i]] : []);
  if (debtors.length < 2 && !headers.length) return [doc];
  const starts = [...new Set([0, ...headers, ...debtors.map((block, i) => {
    if (!i) return 0;
    const previous = debtors[i - 1].from;
    const creditor = labels.filter((p) => /^(?:聲請人|債權人)/.test(p.role) && p.from > previous && p.from < block.from).pop();
    const pageStart = offsets.filter((at) => at <= block.from).pop() ?? 0;
    return pageStart > previous ? pageStart : creditor?.from ?? block.from;
  })])].sort((a, b) => a - b);
  return starts.map((start, i) => {
    const stop = starts[i + 1] ?? text.length;
    const pages = doc.pages.flatMap((p, n) => {
      const pageStart = offsets[n];
      const from = Math.max(0, start - pageStart);
      const to = Math.min(p.text.normalize('NFKC').length, stop - pageStart);
      return from < to ? [{ ...p, text: ' '.repeat(from) + text.slice(pageStart + from, pageStart + to) }] : [];
    });
    return { ...doc, pages, fullText: text.slice(start, stop) };
  });
}

/** 在文件各頁執行抽取函式，回傳附帶頁碼與來源的結果 */
export function hitsInDoc<T extends { index: number; raw: string }>(
  doc: ExtractedDoc,
  finder: (text: string) => T[],
  pages?: number[],
): PageHit<T>[] {
  const out: PageHit<T>[] = [];
  for (const p of doc.pages) {
    if (pages && !pages.includes(p.page)) continue;
    for (const h of finder(p.text)) {
      out.push({ hit: h, page: p.page, prov: provAt(doc, p.page, h.index, h.raw) });
    }
  }
  return out;
}

export function provAt(doc: ExtractedDoc, page: number, index: number, raw: string): Provenance {
  const p = doc.pages.find((x) => x.page === page);
  const text = p?.text ?? '';
  const key = stripSpaces(raw);
  const lines = key.length > 1 ? p?.scan?.lines.filter((line) => stripSpaces(line.text).includes(key)) : undefined;
  const crop = lines?.length === 1 ? lines[0].region : undefined;
  const left = Math.max(0, (crop?.left ?? 0) - 0.018);
  const top = Math.max(0, (crop?.top ?? 0) - 0.012);
  let para: number | undefined;
  if (doc.paragraphs) {
    // 依頁內文字位移換算段落序號
    let off = 0;
    for (const par of doc.paragraphs.filter((x) => x.page === page)) {
      if (index >= off && index <= off + par.text.length) {
        para = par.index;
        break;
      }
      off += par.text.length + 1;
    }
  }
  return {
    fileId: doc.file.id,
    fileName: doc.file.name,
    path: doc.file.path,
    kind: doc.file.kind,
    page: doc.file.kind === 'xlsx' ? undefined : page,
    sheet: doc.file.kind === 'xlsx' ? doc.sheets?.[page - 1]?.name : undefined,
    para,
    offset: index,
    method: p?.method ?? 'txt',
    confidence: p?.confidence ?? 1,
    raw: text ? snippet(text, index, raw.length) : raw,
    region: crop ? { left, top, width: Math.min(1 - left, crop.width + 0.036), height: Math.min(1 - top, crop.height + 0.024) } : undefined,
  };
}

export function ev(label: string, raw: string, normalized: string, prov?: Provenance): Evidence {
  return { label, raw, normalized, prov };
}

export function correctable(ctx: FlowContext, original: Evidence, unit: string, field: FieldCorrectionTarget['field']): Evidence {
  const p = original.prov;
  if (!p) return original;
  const key = `${unit}:${p.fileId}:${p.page ?? p.sheet}:${p.offset ?? 0}:${field}`;
  const applied = ctx.corrections?.[key];
  return { ...original, normalized: applied?.value ?? original.normalized,
    prov: applied ? { ...p, method: 'manual', confidence: 1 } : p,
    correction: { key, field, original: original.normalized, originalProv: p, applied },
  };
}

export function item(
  ctx: FlowContext,
  checkId: string,
  field: string,
  status: CheckStatus,
  severity: Severity,
  reason: string,
  extra: Partial<Pick<CheckItem, 'a' | 'b' | 'calc' | 'basis'>> = {},
): CheckItem {
  const off = disabledReason(ctx.settings, checkId);
  if (off) {
    return {
      id: uid('c'),
      field,
      status: 'not-applicable',
      severity: 'info',
      reason: `此檢查已於規則設定停用：${off}`,
      ...extra,
      review: { state: 'pending', note: '' },
    };
  }
  // OCR 低信心的證據不能直接判定一致或不一致
  const uncertainScan = [extra.a?.prov, extra.b?.prov].some((p) => p?.method === 'chrome-pasted' || (p?.method === 'ocr' && (p.confidence < 0.6 || status === 'mismatch')));
  let s = status;
  let r = reason;
  if (uncertainScan && (status === 'match' || status === 'mismatch')) {
    s = 'needs-review';
    r = `掃描文字可能有誤，請看原件確認。${reason}`;
  }
  return { id: uid('c'), field, status: s, severity, reason: r, ...extra, review: { state: 'pending', note: '' } };
}

export function mostCommon<T>(arr: T[], key: (x: T) => string): T | undefined {
  const m = new Map<string, { v: T; n: number }>();
  for (const x of arr) {
    const k = key(x);
    const e = m.get(k);
    if (e) e.n++;
    else m.set(k, { v: x, n: 1 });
  }
  let best: { v: T; n: number } | undefined;
  for (const e of m.values()) if (!best || e.n > best.n) best = e;
  return best?.v;
}

export function uniqueBy<T>(arr: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return arr.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
