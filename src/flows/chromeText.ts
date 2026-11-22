import { findCaseNumbers, compareCase } from '../core/court';
import { debtorFields } from '../core/extract';
import { compareIds, validateTwId } from '../core/idno';
import { compareAddress, compareNames, normLoose } from '../core/text';
import type { CheckItem, CheckUnit, ChromePageText, DocRole, Evidence, ExtractedDoc, FieldCorrectionTarget, FlowResult, ManualPair } from '../core/types';
import { personsFromHousehold, type FlowCExtra } from './flowC';
import type { RunOptions } from './index';

const MAX_PAGE_TEXT = 60_000;
const SIDES = ['a', 'b'] as const;

export function validChromeText(text: string): boolean {
  return !!text.trim() && text.length <= MAX_PAGE_TEXT && !/[\u0000\f]/.test(text);
}

export function saveChromePage(entries: ChromePageText[], next: ChromePageText): ChromePageText[] {
  return [...entries.filter((entry) => entry.unitId !== next.unitId || entry.fileId !== next.fileId || entry.page !== next.page), next];
}

function scopedTo(unit: CheckUnit, source: ChromePageText): boolean {
  return unit.docs.some((d) => d.fileId === source.fileId && d.role === source.role && (!d.pages || d.pages.includes(source.page)));
}

function fieldCorrectionType(label: string): FieldCorrectionTarget['field'] | undefined {
  if (/身分證/.test(label)) return 'id';
  if (/地址|住所|住址/.test(label)) return 'address';
  if (/案號/.test(label)) return 'case';
  if (/姓名|^第三人(?:法定代理人)?$/.test(label)) return 'name';
}

function equalValue(label: string, a: string, b: string): boolean {
  switch (fieldCorrectionType(label)) {
    case 'address': return compareAddress(a, b).equal;
    case 'id': return ['full', 'partial'].includes(compareIds(a, b));
    case 'name': return ['exact', 'alias'].includes(compareNames(a, b));
    case 'case': {
      const first = findCaseNumbers(a)[0];
      const second = findCaseNumbers(b)[0];
      return first && second ? compareCase(first, second).equal : normLoose(a) === normLoose(b);
    }
    default: return normLoose(a) === normLoose(b);
  }
}

function compareReviewed(row: CheckItem, field: FieldCorrectionTarget['field']): Pick<CheckItem, 'status' | 'reason'> {
  const a = row.a?.normalized;
  const b = row.b?.normalized;
  if (!a || !b) return { status: 'needs-review', reason: '已記錄人工確認值。另一份文件的欄位仍需確認。' };
  const same = equalValue(row.field, a, b);
  const otherScan = SIDES.some((side) => row[side]?.prov?.method === 'chrome-pasted' || (row[side]?.prov?.method === 'ocr' && (!same || row[side]!.prov!.confidence < 0.6)));
  if (otherScan) return { status: 'needs-review', reason: '已記錄人工確認值。另一份掃描來源仍需看原件。' };
  if (field === 'id') {
    const result = compareIds(a, b);
    if (result === 'unknown') return { status: 'needs-review', reason: '可辨識的位數不足，請看原件。' };
    if (result === 'partial' || (result === 'full' && (!validateTwId(a) || !validateTwId(b)))) {
      return { status: 'partial', reason: '已由人工確認，僅可比對可見部分或檢查碼仍需確認。' };
    }
  }
  return { status: same ? 'match' : 'mismatch', reason: same ? '已由人工確認，欄位一致。' : '已由人工確認原頁，兩份文件內容不同。' };
}

export function addDirectCorrections(result: FlowResult, opt: RunOptions): FlowResult {
  if (result.flow !== 'A' && result.flow !== 'D') return result;
  return { ...result, units: result.units.map((unit) => ({ ...unit, items: unit.items.map((item) => {
    const field = fieldCorrectionType(item.field);
    if (!field || item.status === 'not-applicable' || /內部|內案號|重複/.test(item.field)) return item;
    const next = { ...item };
    for (const side of SIDES) {
      const evidence = item[side];
      if (!evidence?.prov || evidence.correction) continue;
      const loc = evidence.prov;
      const key = JSON.stringify([unit.id, loc.fileId, loc.page, loc.offset, item.field, side]);
      const applied = opt.corrections?.[key];
      next[side] = { ...evidence, normalized: applied?.value ?? evidence.normalized,
        prov: applied ? { ...loc, method: 'manual', confidence: 1 } : loc,
        correction: { key, field, original: evidence.normalized, originalProv: loc, applied } };
    }
    return next.a?.correction?.applied || next.b?.correction?.applied ? { ...next, ...compareReviewed(next, field) } : next;
  }) })) };
}

function householdPair(base: FlowResult, unit: CheckUnit, docs: ExtractedDoc[], doc: ExtractedDoc, page: number): string | undefined {
  const revised = personsFromHousehold(doc).filter((person) => person.page === page);
  const previous = (base as FlowResult & { extra?: FlowCExtra }).extra?.persons.filter((person) => person.doc.file.id === doc.file.id && person.page === page) ?? [];
  const selected = previous.find((person) => unit.items.some((item) => item.a?.correction?.key.startsWith(`${unit.pairKey}:${person.key}:`)));
  const filing = unit.docs.find((link) => link.role === 'payment-order-petition');
  const petition = docs.find((original) => original.file.id === filing?.fileId);
  const identity = debtorFields(petition?.pages.filter((p) => !filing?.pages || filing.pages.includes(p.page)).map((p) => p.text).join('\n') ?? '');
  const id = selected?.id ?? identity.id?.value;
  const name = selected?.name || identity.name?.value;
  const same = revised.filter((person) => {
    const namesAgree = !!name && !!person.name && compareNames(name, person.name) === 'exact';
    const knownId = id && person.id ? compareIds(id, person.id) : 'unknown';
    return knownId === 'full' || (knownId !== 'mismatch' && namesAgree && !!selected);
  });
  if (same.length === 1) return same[0].key;
  // When the page has several people, unlabelled fragments cannot identify any one of them.
  if (revised.length !== 1 || previous.length > 1) return undefined;
  const person = revised[0];
  if (selected || (!person.name && !person.id)) return person.key;
  // Otherwise leave normal multi-signal pairing to flow C.
  return undefined;
}

function sourceEvidence(evidence: Evidence | undefined, source: ChromePageText): evidence is Evidence & { prov: NonNullable<Evidence['prov']> } {
  return evidence?.prov?.fileId === source.fileId && evidence.prov.page === source.page && evidence.prov.method === 'chrome-pasted' && !!evidence.normalized;
}

function sourcedElsewhere(evidence: Evidence | undefined, source: ChromePageText): boolean {
  return !!evidence?.normalized && !!evidence.prov && (evidence.prov.fileId !== source.fileId || evidence.prov.page !== source.page);
}

function mergeItems(unit: CheckUnit, variant: CheckUnit, source: ChromePageText, opt: RunOptions): { items: CheckItem[]; used: boolean } {
  const items = [...unit.items];
  let used = false;
  for (const candidate of variant.items) {
    if (candidate.status === 'not-applicable') continue;
    const side = SIDES.find((key) => sourceEvidence(candidate[key], source));
    if (!side) continue;
    const other = side === 'a' ? 'b' : 'a';
    const incoming = candidate[side]!;
    const relevant = items.map((row, index) => ({ row, index })).filter(({ row }) => row.field === candidate.field);
    if (relevant.length > 1) continue;
    const current = relevant[0]?.row;
    if (current?.status === 'not-applicable' && current.reason.includes('規則設定停用')) continue;
    const original = current?.[side];
    if (sourcedElsewhere(original, source)) continue;
    // A variant can pair a different supporting document. Preserve the original comparison partner.
    const counterpart = current?.[other]?.normalized ? current[other] : candidate[other] ?? current?.[other];
    if (current?.[other]?.prov && candidate[other]?.prov && current[other].prov.fileId !== candidate[other].prov.fileId) continue;

    const value = incoming.correction?.original || incoming.normalized;
    const known = fieldCorrectionType(candidate.field);
    const key = `chrome:${unit.id}:${source.fileId}:${source.page}:${source.role}:${candidate.field}:${side}`;
    const applied = original?.correction?.applied ?? (known ? opt.corrections?.[key] : undefined);
    const originalValue = original?.correction?.original ?? original?.normalized ?? '';
    const distinct = !!originalValue && !equalValue(candidate.field, originalValue, value);
    const status: CheckItem['status'] = current?.status === 'match' && !distinct && !!originalValue ? 'match' : 'needs-review';
    const reason = status === 'match' ? current!.reason : distinct
      ? '這個欄位有兩種讀取結果，請看原件確認。'
      : '使用者貼入的文字已用於核對，請對照指定原頁確認這個欄位。';
    const alternatives = [...(original?.candidates ?? [])];
    const originalProv = original?.correction?.originalProv ?? original?.prov;
    if (originalProv && originalValue && !alternatives.length) alternatives.push({ value: originalValue, prov: originalProv });
    alternatives.push({ value, prov: incoming.prov! });
    const evidence: Evidence = {
      ...(original?.normalized ? original : incoming),
      normalized: applied?.value ?? (original?.normalized || value),
      prov: applied ? { ...(originalProv ?? incoming.prov!), method: 'manual', confidence: 1 } : original?.normalized ? original.prov : incoming.prov,
      candidates: alternatives,
      correction: known ? { key: original?.correction?.key ?? key, field: known, original: originalValue || value, originalProv: originalProv ?? incoming.prov, applied } : undefined,
    };
    const row = { ...(current ?? candidate), [side]: evidence, [other]: counterpart, status, reason };
    if (known && applied) Object.assign(row, compareReviewed(row, known));
    if (relevant[0]) items[relevant[0].index] = row;
    else items.push(row);
    used = true;
  }
  return { items, used };
}

export function applyChromePages(
  base: FlowResult, docs: ExtractedDoc[], roles: DocRole[], opt: RunOptions,
  check: (docs: ExtractedDoc[], pairs: Record<string, ManualPair> | undefined) => FlowResult,
): FlowResult {
  return { ...base, units: base.units.map((unit) => {
    const sources = opt.chromePages!.filter((entry) => entry.unitId === unit.id);
    if (!sources.length) return unit;
    let updated = unit;
    const chromeSources: NonNullable<CheckUnit['chromeSources']> = [];
    for (const source of sources) {
      const doc = docs.find((d) => d.file.id === source.fileId && d.file.kind === 'pdf');
      if (!doc?.pages.some((p) => p.page === source.page) || !roles.includes(source.role) || !validChromeText(source.text)) continue;
      const link = { fileId: source.fileId, page: source.page, role: source.role, used: false };
      chromeSources.push(link);
      const recorded = unit.docs.filter((d) => d.role === source.role && d.pages?.length);
      if (recorded.length && !scopedTo(unit, source)) continue;
      if (!scopedTo(unit, source) && doc.role !== 'unknown' && doc.role !== 'merged-source' && doc.role !== source.role) continue;
      const pages = doc.pages.map((p) => p.page === source.page ? { page: p.page, text: source.text.replace(/\r\n?/g, '\n'), method: 'chrome-pasted' as const, confidence: 0, roleHint: source.role } : p);
      const role = doc.role === 'merged-source' || (base.flow === 'B' && doc.pages.length > 1 && ['payment-order', 'service-proof', 'finality-cert'].includes(source.role)) ? 'merged-source' : source.role;
      const variant = { ...doc, pages, role, status: 'partial' as const, fullText: pages.map((p) => p.text).join('\n') };
      let pairs = opt.manualPairs;
      if (base.flow === 'C' && role === 'household-register' && unit.pairKey) {
        const person = householdPair(base, unit, docs, variant, source.page);
        if (person) pairs = { ...pairs, [unit.pairKey]: { ...pairs?.[unit.pairKey], person } };
      }
      const checked = check(docs.map((d) => d === doc ? variant : d), pairs);
      const exact = checked.units.find((row) => row.id === unit.id);
      const samePage = base.flow === 'B' && unit.id.endsWith(':unknown') && source.role === 'enforcement-petition' && scopedTo(unit, source)
        ? checked.units.filter((row) => scopedTo(row, source)) : [];
      const result = exact ?? (samePage.length === 1 ? samePage[0] : undefined);
      if (!result) continue;
      const merged = mergeItems(updated, result, source, opt);
      if (merged.used) {
        link.used = true;
        updated = { ...updated, items: merged.items };
      }
    }
    return { ...updated, chromeSources };
  }) };
}
