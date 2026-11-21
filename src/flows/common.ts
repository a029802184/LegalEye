// 四個核對流程共用的工具：證據建立、頁碼／段落定位、檢查項目建立。

import type { CheckItem, CheckStatus, Evidence, ExtractedDoc, Provenance, Severity } from '../core/types';
import { disabledReason, type Settings } from '../core/rules';
import { snippet, uid } from '../core/text';

export interface FlowContext {
  settings: Settings;
}

export interface PageHit<T> {
  hit: T;
  page: number;
  prov: Provenance;
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
  };
}

export function ev(label: string, raw: string, normalized: string, prov?: Provenance): Evidence {
  return { label, raw, normalized, prov };
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
  const lowConf = [extra.a?.prov, extra.b?.prov].some((p) => p && p.method === 'ocr' && p.confidence < 0.6);
  let s = status;
  let r = reason;
  if (lowConf && (status === 'match' || status === 'mismatch')) {
    s = 'needs-review';
    r = `${reason}（來源為低信心 OCR，請對照原頁影像確認）`;
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
