// 流程 B：民事強制執行聲請狀 ↔ 支付命令正本、確定證明書、送達證書、債權資料。
// 合併 PDF 先依頁面標題與案號拆組，不把整份全文混在一起比對。

import { caseKey, compareCase, findCaseNumbers, findCourts, fmtCase, type CaseNo } from '../core/court';
import { centsToString, findAmountPairs, findArithmetic, findLabeledAmounts, type AmountKind } from '../core/amount';
import { compareAddress, compareNames, normLoose, uid } from '../core/text';
import { compareIds, validateTwId } from '../core/idno';
import { debtorFields, findAttachmentRefs, findCreditorNames, findIds, findRates, partyBlocks } from '../core/extract';
import { findDates, fmtBoth, parseDate, sameDay, type YMD } from '../core/date';
import { computeInterestStart, detectInterestClause, detectServiceMethod, SERVICE_METHOD_LABEL, type ServiceMethod } from '../core/service';
import { pageRole } from '../core/classify';
import { RULESET_VERSION } from '../core/rules';
import type { BatchIssue, CheckItem, CheckUnit, DocRole, ExtractedDoc, FlowResult, ManualPair } from '../core/types';
import { correctable, ev, item, petitionSections, provAt, type FlowContext } from './common';

/** 使用者在畫面上補充的送達資料（優先於自動辨識） */
export interface ServiceManualInput {
  method?: ServiceMethod;
  serviceDate?: string; // ISO
  pickupDate?: string;
  courtConfirmedEffective?: string;
  multipleDebtorsDiffer?: boolean;
}

export interface FlowBContext extends FlowContext {
  service?: Record<string, ServiceManualInput>; // key: 案件＋配對來源
  manualPairs?: Record<string, ManualPair>;
}

interface SrcPage {
  doc: ExtractedDoc;
  page: number;
  role: DocRole;
  text: string;
}

interface CaseGroup {
  key: string;
  caseNo?: CaseNo;
  court?: string;
  pages: SrcPage[];
}

export interface FlowBExtra {
  sources: { key: string; label: string }[];
}

function groupKey(group: CaseGroup) {
  const first = group.pages[0];
  return `${group.key}:${group.court ?? ''}:${first.doc.file.id}:${first.page}`;
}

function splitSources(docs: ExtractedDoc[], ctx: FlowBContext): CaseGroup[] {
  const groups: CaseGroup[] = [];
  for (const d of docs) {
    let cur: CaseGroup | undefined;
    for (const p of d.pages) {
      const identifiedRole = pageRole(p.text);
      const role = p.roleHint ?? (d.role === 'merged-source' || identifiedRole !== 'unknown' ? identifiedRole : d.role);
      const cases = findCaseNumbers(p.text).filter((x) => !x.isDocRef);
      if (new Set(cases.map(caseKey)).size > 1) { cur = undefined; continue; }
      const c = cases[0];
      const k = c ? caseKey(c) : '';
      if (k) {
        const court = findCourts(p.text.slice(0, c.index), ctx.settings.courtAliases)[0]?.canonical;
        const candidates = groups.filter((g) => g.key === k);
        cur = court ? candidates.find((g) => g.court === court) : candidates.length === 1 ? candidates[0] : undefined;
        if (!cur) {
          cur = { key: k, caseNo: c, court, pages: [] };
          groups.push(cur);
        }
      } else if (role === 'service-proof' || role === 'finality-cert' || identifiedRole !== 'unknown' || p.roleHint) {
        // A new source without an explicit case number cannot inherit the prior case's identity.
        cur = undefined;
      }
      cur?.pages.push({ doc: d, page: p.page, role, text: p.text });
    }
  }
  return groups;
}


export function runFlowB(docs: ExtractedDoc[], ctx: FlowBContext): FlowResult & { extra: FlowBExtra } {
  const issues: BatchIssue[] = [];
  const notDone: string[] = [];
  const petitions = docs.filter((d) => d.role === 'enforcement-petition');
  const sources = docs.filter((d) => ['payment-order', 'finality-cert', 'service-proof', 'merged-source', 'debt-statement'].includes(d.role));
  if (!petitions.length) issues.push({ id: uid('i'), level: 'error', message: '找不到民事強制執行聲請狀（Word）。' });
  if (!sources.length) issues.push({ id: uid('i'), level: 'error', message: '找不到支付命令／確定證明書等來源文件。' });
  for (const d of docs) {
    if (d.status === 'needs-ocr' || d.status === 'error') {
      issues.push({ id: uid('i'), level: 'error', message: `${d.file.path}：${d.warnings.join('；')}`, fileId: d.file.id });
      notDone.push(`${d.file.path} 無法取得文字，相關比對未完成`);
    }
  }
  const groups = splitSources(sources, ctx);
  const used = new Set<CaseGroup>();
  const units: CheckUnit[] = [];

  for (const document of petitions) for (const [section, pet] of petitionSections(document).entries()) {
    const pText = pet.fullText;
    const pCases = findCaseNumbers(pText).filter((c) => !c.isDocRef);
    const refs = new Map(pCases.map((pc) => {
      const court = findCourts(pText.slice(Math.max(0, pc.index - 36), pc.index), ctx.settings.courtAliases).pop()?.canonical;
      return [`${court ?? ''}:${caseKey(pc)}`, { pc, court }];
    }));
    const petName = debtorFields(pText).name?.value;
    if (!refs.size) {
      const id = `b:${pet.file.id}:${section}:unknown`;
      const page = pet.pages[0]?.page;
      const evidence = correctable(ctx, ev('聲請狀', '', '', page ? provAt(pet, page, 0, '') : undefined), id, 'case');
      const supplied = findCaseNumbers(evidence.normalized).find((c) => !c.isDocRef);
      if (supplied) refs.set('unknown', { pc: { ...supplied, raw: '', index: 0 }, court: undefined });
      else {
        units.push({
        id,
        label: petName ?? '此案尚未辨識出債務人',
        subLabel: '聲請狀未辨識到執行名義案號',
        docs: [{ role: 'enforcement-petition', fileId: pet.file.id, pages: pet.pages.map((p) => p.page) }],
        items: [item(ctx, 'B.case', '執行名義案號', pet.fullText.trim() ? 'unreadable' : 'missing', 'high', '聲請狀案號尚未讀出，請看原件後更正此案案號', { b: evidence })],
        match: { score: 0, evidence: ['無案號可配對'], needsManual: true },
      });
        continue;
      }
    }
    for (const [ref, { pc: originalCase, court }] of refs) {
      const unitId = `b:${pet.file.id}:${section}:${ref}`;
      const petitionPage = pagesOfIndex(pet, originalCase.raw);
      const caseProv = provAt(pet, petitionPage, Math.max(0, pet.pages.find((p) => p.page === petitionPage)?.text.indexOf(originalCase.raw) ?? 0), originalCase.raw);
      const filedCase = correctable(ctx, ev('聲請狀', originalCase.raw, originalCase.raw ? fmtCase(originalCase) : '', caseProv), unitId, 'case');
      const pc = filedCase.correction?.applied ? findCaseNumbers(filedCase.normalized)[0] ?? originalCase : originalCase;
      const k = caseKey(pc);
      const caseGroups = groups.filter((x) => x.key === k);
      const exactCourt = caseGroups.filter((x) => court && x.court === court);
      const candidates = exactCourt.length ? exactCourt : caseGroups.filter((x) => !court || !x.court);
      const requested = ctx.manualPairs?.[unitId]?.source;
      const manual = requested ? groups.find((x) => groupKey(x) === requested) : undefined;
      const g = manual ?? (candidates.length === 1 ? candidates[0] : undefined);
      const petitionId = debtorFields(pText).id?.value;
      const identity = g?.pages.filter((p) => p.role === 'payment-order').map((p) => ({ p, ...debtorFields(p.text) })) ?? [];
      const identified = identity.filter((p) => p.name || p.id);
      const matching = identified.filter((p) => petName && p.name && ['exact', 'alias'].includes(compareNames(p.name.value, petName))
        && (!petitionId || !p.id || compareIds(p.id.value, petitionId) !== 'mismatch'));
      const conflict = identified.length > 0 && matching.length !== 1;
      const canCompare = !!g && !!petName && (!conflict || !!manual) && (identified.length < 2 || matching.length === 1);
      const unit: CheckUnit = {
        id: unitId,
        pairKey: unitId,
        label: (refs.size === 1 || canCompare ? petName : undefined) ?? '此案尚未辨識出債務人',
        subLabel: fmtCase(pc),
        docs: [{ role: 'enforcement-petition', fileId: pet.file.id, pages: [petitionPage] }],
        items: [],
        match: g && canCompare ? { score: 0.95, evidence: [`聲請狀第 ${petitionPage} 頁，${manual ? '人工選擇來源' : `依案號 ${fmtCase(pc)} 配對來源`}：${g.pages.map((pg) => `${pg.doc.file.name} 第 ${pg.page} 頁`).join('、')}`], needsManual: false }
          : { score: 0, evidence: [conflict ? '聲請狀與來源的債務人不同，請確認案件配對' : candidates.length > 1 ? '多份來源使用相同案號，請確認法院及當事人' : '尚未確定對應的來源文件與債務人'], needsManual: true },
      };
      if (!g || !canCompare) {
        // 案號可能誤植：列出來源中的其他案號
        const others = groups.filter((x) => x.caseNo).map((x) => fmtCase(x.caseNo!));
        unit.items.push(
          item(ctx, 'B.case', '執行名義案號', 'needs-review', 'high', `${unit.match!.evidence[0]}${others.length ? `；來源案號：${others.join('、')}` : ''}`, {
            b: filedCase,
          }),
        );
        units.push(unit);
        continue;
      }
      used.add(g);
      const serviceKey = `${unitId}:${caseKey(pc)}:${groupKey(g)}`;
      unit.serviceKey = serviceKey;
      const ambiguousGroup = identified.length > 1;
      const requireRecipientId = identified.filter((p) => petName && p.name && ['exact', 'alias'].includes(compareNames(p.name.value, petName))).length > 1;
      const scoped = { ...g, pages: g.pages.filter((pg) => !ambiguousGroup || pg.role !== 'payment-order' || pg === matching[0]?.p) };
      for (const pg of scoped.pages) {
        const ex = unit.docs.find((d) => d.fileId === pg.doc.file.id && d.role === pg.role);
        if (ex) ex.pages = [...(ex.pages ?? []), pg.page];
        else unit.docs.push({ role: pg.role, fileId: pg.doc.file.id, pages: [pg.page] });
      }
      unit.items = [
        ...compareB(pet, pc, scoped, ctx, unitId, serviceKey, refs.size > 1, requireRecipientId, filedCase),
        ...compareThirdParties(pet, pc, court ?? g.court, docs.filter((d) => d.role === 'tax-record'), ctx),
      ];
      units.push(unit);
    }
  }
  for (const g of groups) {
    if (!used.has(g) && g.caseNo) {
      issues.push({ id: uid('i'), level: 'info', message: `來源中的 ${fmtCase(g.caseNo)}（${g.pages.length} 頁）未被任何聲請狀引用`, fileId: g.pages[0].doc.file.id });
    }
  }
  return { flow: 'B', units, batchIssues: issues, notDone, ruleVersion: RULESET_VERSION, createdAt: new Date().toISOString(), extra: {
    sources: groups.map((g) => ({ key: groupKey(g), label: `${g.court ?? '法院尚未辨識'} ${fmtCase(g.caseNo!)} · ${g.pages[0].doc.file.name} 第 ${g.pages[0].page} 頁` })),
  } };
}

function relatedParty(text: string) {
  const blocks = partyBlocks(text);
  const third = blocks.filter((p) => p.role === '第三人');
  if (third.length !== 1) return { multiple: third.length > 1 };
  const main = third[0];
  const after = blocks[blocks.indexOf(main) + 1];
  const agent = after && /^(?:第三人)?法定代理人$/.test(after.role) ? after : undefined;
  const nameOf = (p: typeof main) => p.text.split(/\n|\s+(?:住|設)|[（(]|(?:統一編號|統編)/, 1)[0].trim();
  const name = nameOf(main);
  const id = /(?:統一編號|統編)\s*[:：]?\s*(\d{8})(?!\d)/.exec(main.text);
  return {
    multiple: false,
    name: name ? { value: name, index: main.valueAt } : undefined,
    id: id ? { value: id[1], index: main.valueAt + id.index } : undefined,
    representative: agent && nameOf(agent) ? { value: nameOf(agent), index: agent.valueAt } : undefined,
  };
}

function compareThirdParties(pet: ExtractedDoc, pc: CaseNo, court: string | undefined, tax: ExtractedDoc[], ctx: FlowBContext): CheckItem[] {
  const local = pet.pages.map((p) => ({ ...p, party: relatedParty(p.text) })).filter((p) => p.party.name || p.party.multiple);
  if (!local.length) return [item(ctx, 'B.party', '第三人及法定代理人', 'not-applicable', 'info', '本案不需要核對第三人')];
  if (local.length > 1 || local[0].party.multiple) return [item(ctx, 'B.party', '第三人及法定代理人', 'needs-review', 'high', '同案有多筆第三人，請依原件逐一確認')];
  const subjectId = debtorFields(pet.fullText).id?.value;
  const candidates = tax.flatMap((doc) => doc.pages.flatMap((p) => {
    const exactCase = !!court && findCourts(p.text, ctx.settings.courtAliases).some((c) => c.canonical === court)
      && findCaseNumbers(p.text).some((c) => !c.isDocRef && caseKey(c) === caseKey(pc));
    const sourceId = debtorFields(p.text).id?.value;
    if (!exactCase && !(subjectId && sourceId && validateTwId(subjectId) && compareIds(subjectId, sourceId) === 'full')) return [];
    const party = relatedParty(p.text);
    return party.name && !party.multiple ? [{ doc, page: p.page, party }] : [];
  }));
  const filed = local[0];
  const source = candidates.length === 1 ? candidates[0] : undefined;
  const rows = [['name', '第三人'], ['id', '第三人統一編號'], ['representative', '第三人法定代理人']] as const;
  return rows.flatMap(([field, label]) => {
    const a = source?.party[field];
    const b = filed.party[field];
    if (!a && !b && field === 'id') return [];
    const same = a && b && normLoose(a.value) === normLoose(b.value);
    return [item(ctx, 'B.party', label, !a || !b ? 'needs-review' : same ? 'match' : 'mismatch', 'high',
      !a ? `請確認${label}資料來源` : !b ? `聲請狀尚未讀出${label}` : same ? `${label}一致` : `${label}不同，請確認`, {
        a: a && source ? ev('查稅資料', a.value, a.value, provAt(source.doc, source.page, a.index, a.value)) : undefined,
        b: b ? ev('聲請狀', b.value, b.value, provAt(pet, filed.page, b.index, b.value)) : undefined,
      })];
  });
}

function pagesOfIndex(doc: ExtractedDoc, raw: string): number {
  return doc.pages.find((p) => p.text.normalize('NFKC').includes(raw))?.page ?? 1;
}

/** 在文件各頁尋找第一個符合的值並附來源 */
function firstHit<T extends { index: number; raw: string }>(pages: { doc: ExtractedDoc; page: number; text: string }[], finder: (t: string) => T[]) {
  for (const p of pages) {
    const h = finder(p.text)[0];
    if (h) return { hit: h, prov: provAt(p.doc, p.page, h.index, h.raw) };
  }
  return undefined;
}

function compareB(pet: ExtractedDoc, pc: CaseNo, g: CaseGroup, ctx: FlowBContext, unitId: string, serviceKey: string, multiCase: boolean, requireRecipientId: boolean, filedCase: ReturnType<typeof ev>): CheckItem[] {
  const items: CheckItem[] = [];
  const petPages = pet.pages.map((p) => ({ doc: pet, page: p.page, text: p.text }));
  const orderPages = g.pages.filter((p) => p.role === 'payment-order');
  const certPages = g.pages.filter((p) => p.role === 'finality-cert');
  const debtor = debtorFields(pet.fullText);
  const servicePages = g.pages.filter((p) => {
    if (p.role !== 'service-proof' || !debtor.name) return false;
    const recipients = [...p.text.matchAll(/(?:應受送達人|受送達人|收件人)[ \t]*[:：][ \t]*([^\n；，]+)/g)];
    if (recipients.length !== 1) return false;
    const line = recipients[0][1].split(/[ \t]*(?:身分證|統一編號)/, 1)[0].trim();
    if (!['exact', 'alias'].includes(compareNames(line, debtor.name.value))) return false;
    const ids = findIds(p.text);
    if (requireRecipientId) return ids.length === 1 && !!debtor.id && compareIds(ids[0].value, debtor.id.value) === 'full';
    return !debtor.id || !ids.length || (ids.length === 1 && compareIds(ids[0].value, debtor.id.value) !== 'mismatch');
  });
  const srcMain = orderPages;
  const location = (pages: typeof petPages, raw: string) => {
    if (!raw) return undefined;
    const hits = pages.flatMap((p) => {
      const index = p.text.normalize('NFKC').indexOf(raw);
      return index < 0 ? [] : [provAt(p.doc, p.page, index, raw)];
    });
    return hits.length === 1 ? hits[0] : undefined;
  };
  const partyEvidence = (pages: typeof petPages, field: 'name' | 'id' | 'address', label: string) => {
    const found = firstHit(pages, (t) => [debtorFields(t)[field]].filter((x) => !!x));
    const first = pages[0];
    const prov = found?.prov ?? (first ? provAt(first.doc, first.page, 0, '') : undefined);
    return correctable(ctx, ev(label, found?.hit.raw ?? '', found?.hit.value ?? '', prov), unitId, field);
  };

  // 1. 當事人
  const pCred = firstHit(petPages, findCreditorNames);
  const oCred = firstHit(srcMain, findCreditorNames);
  if (pCred && oCred) {
    const same = normLoose(pCred.hit.value) === normLoose(oCred.hit.value);
    items.push(item(ctx, 'B.party', '債權人', same ? 'match' : 'mismatch', 'high', same ? '債權人名稱一致' : '債權人名稱不同', { a: ev('支付命令', oCred.hit.raw, oCred.hit.value, oCred.prov), b: ev('聲請狀', pCred.hit.raw, pCred.hit.value, pCred.prov) }));
  } else items.push(item(ctx, 'B.party', '債權人', 'missing', 'medium', !oCred ? '來源未辨識到債權人' : '聲請狀未辨識到債權人'));
  const pDeb = partyEvidence(petPages, 'name', '聲請狀');
  const oDeb = partyEvidence(srcMain, 'name', '支付命令');
  if (pDeb.normalized && oDeb.normalized) {
    const r = compareNames(oDeb.normalized, pDeb.normalized);
    const st = r === 'exact' || r === 'alias' ? 'match' : r === 'variant-suspect' ? 'needs-review' : 'mismatch';
    items.push(item(ctx, 'B.party', '債務人', st, 'high', r === 'alias' ? '以別名（即／原名）對應一致' : r === 'variant-suspect' ? '姓名一字不同或疑似異體字' : st === 'match' ? '債務人姓名一致' : '債務人姓名不同', { a: oDeb, b: pDeb }));
  } else items.push(item(ctx, 'B.party', '債務人', 'unreadable', 'high', '債務人姓名尚未讀出，請看原件', { a: oDeb, b: pDeb }));
  const pId = partyEvidence(petPages, 'id', '聲請狀');
  const oId = partyEvidence(srcMain, 'id', '支付命令');
  if (pId.normalized && oId.normalized) {
    const r = compareIds(oId.normalized, pId.normalized);
    const checksum = validateTwId(pId.normalized);
    items.push(item(ctx, 'B.party', '身分證字號', r === 'full' ? checksum ? 'match' : 'needs-review' : r === 'partial' ? 'partial' : r === 'mismatch' ? 'mismatch' : 'missing', 'high', r === 'full' ? checksum ? '全碼一致' : '全碼一致但檢查碼不符，請確認原件' : r === 'partial' ? '來源遮罩，僅可見部分一致' : r === 'mismatch' ? '身分證字號不同' : '可見位數不足', { a: oId, b: pId }));
  } else if (pId.normalized && !validateTwId(pId.normalized) && !/[*X]/.test(pId.normalized)) {
    items.push(item(ctx, 'B.party', '身分證字號', 'needs-review', 'medium', '聲請狀身分證字號檢查碼不符，請看原件', { a: oId, b: pId }));
  } else items.push(item(ctx, 'B.party', '身分證字號', 'unreadable', 'info', '尚未取得可比對的身分證字號', { a: oId, b: pId }));

  // 2. 住址
  const pAddr = partyEvidence(petPages, 'address', '聲請狀');
  const oAddr = partyEvidence(srcMain, 'address', '支付命令');
  if (pAddr.normalized && oAddr.normalized) {
    const r = compareAddress(oAddr.normalized, pAddr.normalized, oAddr.prov?.method === 'ocr' || pAddr.prov?.method === 'ocr');
    items.push(
      item(ctx, 'B.address', '債務人住址', r.equal ? 'match' : 'needs-review', 'medium', r.equal ? r.detail : `${r.detail}。請確認兩份資料的日期與地址用途。`, {
        a: oAddr,
        b: pAddr,
      }),
    );
  } else items.push(item(ctx, 'B.address', '債務人住址', 'unreadable', 'low', '債務人住址尚未讀出，請看原件', { a: oAddr, b: pAddr }));

  // 3. 法院與案號
  const oCase = g.caseNo!;
  const cmp = compareCase(oCase, pc);
  const originCase = g.pages.find((p) => p.text.includes(oCase.raw));
  items.push(item(ctx, 'B.case', '年度／字別／案號', cmp.equal ? 'match' : 'mismatch', 'high', cmp.equal ? '案號一致' : cmp.diffs.join('；'), { a: ev('來源', oCase.raw, fmtCase(oCase), originCase ? provAt(originCase.doc, originCase.page, originCase.text.indexOf(oCase.raw), oCase.raw) : undefined), b: filedCase }));
  // 聲請狀中緊鄰案號前的法院 = 執行名義法院
  const pIdx = pet.fullText.normalize('NFKC').indexOf(filedCase.raw);
  const pCourt = findCourts(pet.fullText.slice(Math.max(0, pIdx - 30), pIdx + 2), ctx.settings.courtAliases).pop();
  const oCourt = firstHit(srcMain, (t) => findCourts(t, ctx.settings.courtAliases));
  if (pCourt && oCourt) {
    const same = pCourt.canonical === oCourt.hit.canonical;
    items.push(item(ctx, 'B.case', '執行名義法院', same ? 'match' : 'mismatch', 'high', same ? '法院一致' : '法院不同', { a: ev('支付命令', oCourt.hit.raw, oCourt.hit.canonical, oCourt.prov), b: ev('聲請狀', pCourt.raw, pCourt.canonical) }));
  } else items.push(item(ctx, 'B.case', '執行名義法院', 'missing', 'medium', !oCourt ? '來源未辨識到法院' : '聲請狀案號前未記載法院'));

  // 4. 執行名義與附件
  const cites = (re: RegExp) => re.test(pet.fullText);
  const titleChecks: [string, RegExp, SrcPage[]][] = [
    ['支付命令', /支付命令/, orderPages],
    ['確定證明書', /確定證明/, certPages],
    ['送達證書', /送達證書/, servicePages],
  ];
  for (const [name, re, found] of titleChecks) {
    if (!cites(re)) continue;
    items.push(item(ctx, 'B.title', `附件：${name}`, found.length ? 'match' : 'missing', 'high', found.length ? `聲請狀引用${name}，來源中找到 ${found.length} 頁` : `聲請狀引用${name}，但來源中找不到`));
  }
  const refs = findAttachmentRefs(pet.fullText);
  if (refs.length) {
    items.push(item(ctx, 'B.title', '附件清單', 'needs-review', 'info', `聲請狀列出附件：${refs.map((r) => `${r.label} ${r.name}${r.count ? `（${r.count}份）` : ''}`).join('；')}。請確認實際檢附。`));
  }

  // 5. 金額
  const pAm = findLabeledAmounts(pet.fullText);
  const oText = srcMain.map((p) => p.text).join('\n');
  const oAm = findLabeledAmounts(oText);
  const byKind = (arr: typeof pAm, k: AmountKind) => arr.filter((a) => a.kind === k);
  const oPrincipal = byKind(oAm, 'principal')[0];
  const pPrincipal = multiCase ? undefined : byKind(pAm, 'principal')[0];
  if (oPrincipal && pPrincipal) {
    const same = oPrincipal.cents === pPrincipal.cents;
    items.push(
      item(ctx, 'B.amount', '本金', same ? 'match' : 'mismatch', 'high', same ? '本金一致' : '本金不同', {
        a: ev('支付命令', oPrincipal.raw, centsToString(oPrincipal.cents), location(srcMain, oPrincipal.raw)),
        b: ev('聲請狀', pPrincipal.raw, centsToString(pPrincipal.cents), location(petPages, pPrincipal.raw)),
      }),
    );
  } else items.push(item(ctx, 'B.amount', '本金', multiCase ? 'needs-review' : 'missing', 'high', multiCase ? '聲請狀同段引用多件案號，請確認這一案的本金' : !oPrincipal ? '支付命令未辨識到本金' : '聲請狀未辨識到本金'));
  const oFee = byKind(oAm, 'fee')[0];
  const pFee = multiCase ? undefined : byKind(pAm, 'fee')[0];
  if (oFee && pFee) {
    const same = oFee.cents === pFee.cents;
    items.push(item(ctx, 'B.amount', '程序費用', same ? 'match' : 'mismatch', 'medium', same ? '程序費用一致' : '程序費用不同', { a: ev('支付命令', oFee.raw, centsToString(oFee.cents), location(srcMain, oFee.raw)), b: ev('聲請狀', pFee.raw, centsToString(pFee.cents), location(petPages, pFee.raw)) }));
  } else if (oFee || pFee) items.push(item(ctx, 'B.amount', '程序費用', 'needs-review', 'low', oFee ? '支付命令有程序費用，聲請狀未辨識到（可能未請求）' : '聲請狀有程序費用，支付命令未辨識到'));
  // 驗算式
  for (const a of findArithmetic(pet.fullText)) {
    items.push(item(ctx, 'B.amount', '驗算式', a.ok ? 'match' : 'mismatch', 'high', a.ok ? `${a.expr} 計算正確` : `${a.expr} 計算錯誤，應為 ${centsToString(a.expected)}`, { calc: a.expr }));
  }
  // 已清償後餘額
  const paid = byKind(pAm, 'paid')[0];
  const bal = byKind(pAm, 'balance')[0];
  if (pPrincipal && paid && bal) {
    const exp = pPrincipal.cents - paid.cents;
    items.push(
      item(ctx, 'B.amount', '扣除已清償後餘額', exp === bal.cents ? 'match' : 'mismatch', 'high', exp === bal.cents ? '餘額計算正確' : `餘額應為 ${centsToString(exp)}`, {
        calc: `${centsToString(pPrincipal.cents)} − ${centsToString(paid.cents)} = ${centsToString(exp)}（書狀記載 ${centsToString(bal.cents)}）`,
      }),
    );
  }
  // 國字＝數字
  for (const pr of findAmountPairs(pet.fullText)) {
    const ok = pr.chinese.cents === pr.arabic.cents;
    items.push(item(ctx, 'B.amount', '國字與數字金額', ok ? 'match' : 'mismatch', 'high', ok ? '國字金額與阿拉伯數字等值' : '國字金額與阿拉伯數字不等', { a: ev('國字', pr.chinese.raw, centsToString(pr.chinese.cents)), b: ev('數字', pr.arabic.raw, centsToString(pr.arabic.cents)) }));
  }

  // 6. 利息起算日
  const clause = detectInterestClause(oText, parseDate);
  const manual = ctx.service?.[serviceKey] ?? {};
  const svcText = servicePages.map((p) => p.text).join('\n');
  const autoMethod: ServiceMethod = servicePages.length ? detectServiceMethod(svcText) : 'unknown';
  const autoDates = servicePages.map((pg) => serviceDateFromText(pg.text)).filter((d) => d !== null);
  const autoDate = autoDates.length && autoDates.every((d) => sameDay(autoDates[0], d)) ? autoDates[0] : null;
  const method = manual.method ?? autoMethod;
  const scanService = servicePages.some((p) => {
    const method = p.doc.pages.find((page) => page.page === p.page)?.method;
    return method === 'ocr' || method === 'chrome-pasted';
  });
  const svcDate = manual.serviceDate ? parseDate(manual.serviceDate) : scanService ? null : autoDate;
  const res = computeInterestStart({
    clause: clause.clause,
    method,
    serviceDate: svcDate,
    pickupDate: manual.pickupDate ? parseDate(manual.pickupDate) : null,
    courtConfirmedEffective: manual.courtConfirmedEffective ? parseDate(manual.courtConfirmedEffective) : null,
    multipleDebtorsDiffer: manual.multipleDebtorsDiffer || (!!autoDates.length && !autoDate),
  });
  const petStart = multiCase ? null : petitionInterestStart(pet.fullText);
  const clauseProv = location(srcMain, clause.raw);
  const serviceProv = servicePages.length === 1 ? provAt(servicePages[0].doc, servicePages[0].page, 0, '') : undefined;
  const inputs = [
    `執行名義利息條款：${clause.raw || '未辨識'}`,
    `送達方式：${SERVICE_METHOD_LABEL[method]}${manual.method ? '（人工輸入）' : servicePages.length ? '（自送達證書辨識）' : ''}`,
    `送達／寄存日：${svcDate ? fmtBoth(svcDate) : '未取得'}${manual.serviceDate ? '（人工輸入）' : ''}`,
    `書狀填寫起息日：${petStart ? fmtBoth(petStart.date) : '未辨識'}`,
  ];
  if (scanService && !manual.serviceDate) inputs.push('送達日期來自掃描文字，請開啟原件確認後填入。');
  if (!servicePages.length && clause.clause.type === 'after-service' && !manual.serviceDate && !manual.courtConfirmedEffective) {
    inputs.push('注意：來源無送達證書；確定證明書日期不是送達日，不能用來推算起息日');
  }
  let st: CheckItem['status'];
  let reason: string;
  if (res.status === 'manual' || !res.interestStart) {
    st = 'needs-review';
    reason = `需人工判斷：${res.warnings.join('；') || res.formula}`;
  } else if (!petStart) {
    st = 'missing';
    reason = '聲請狀未辨識到利息起算日期';
  } else {
    st = sameDay(res.interestStart, petStart.date) ? 'match' : 'mismatch';
    reason = st === 'match' ? '書狀起息日與計算結果一致' : `書狀起息日 ${fmtBoth(petStart.date)} 與計算結果 ${fmtBoth(res.interestStart)} 不同`;
  }
  if (clause.clause.type !== 'unknown' || petStart || /起息|利息/.test(pet.fullText)) items.push(
    item(ctx, 'B.interest', '利息起算日', st, 'high', reason, {
      a: ev('依規則計算', res.formula, res.interestStart ? fmtBoth(res.interestStart) : '尚需確認', serviceProv ?? clauseProv),
      b: petStart ? ev('聲請狀', petStart.raw, fmtBoth(petStart.date), location(petPages, petStart.raw)) : undefined,
      calc: [res.formula, ...inputs].join('\n'),
      basis: [...res.basis, `規則版本 ${res.ruleVersion}`],
    }),
  );
  const oRate = findRates(oText)[0];
  const pRate = multiCase ? undefined : findRates(pet.fullText)[0];
  if (oRate && pRate) {
    items.push(item(ctx, 'B.interest', '利率', oRate.value === pRate.value ? 'match' : 'mismatch', 'high', oRate.value === pRate.value ? `年利率 ${oRate.value}% 一致` : '利率不同', { a: ev('支付命令', oRate.raw, oRate.value + '%', location(srcMain, oRate.raw)), b: ev('聲請狀', pRate.raw, pRate.value + '%', location(petPages, pRate.raw)) }));
  } else if (oRate || pRate) items.push(item(ctx, 'B.interest', '利率', 'missing', 'medium', oRate ? '聲請狀未辨識到利率' : '支付命令未辨識到利率'));
  return items;
}

/** 送達證書：優先取「寄存」或「送達」旁的日期 */
export function serviceDateFromText(text: string): YMD | null {
  const t = text.normalize('NFKC');
  const dates = findDates(t).filter((d) => d.valid);
  if (!dates.length) return null;
  const near = dates.filter((d) => /(?:送達|寄存|收受|簽收)(?:日(?:期)?|時間)?[ \t]*[:：]?[ \t]*$/.test(t.slice(Math.max(0, d.index - 16), d.index)));
  return near.length && near.every((d) => sameDay(d.value, near[0].value)) ? near[0].value : null;
}

/** 聲請狀「自○年○月○日起至清償日止」 */
export function petitionInterestStart(text: string): { date: YMD; raw: string } | null {
  const t = text.normalize('NFKC');
  for (const d of findDates(t)) {
    if (!d.valid) continue;
    const before = t.slice(Math.max(0, d.index - 3), d.index);
    const after = t.slice(d.index + d.raw.length, d.index + d.raw.length + 16);
    if (/自\s*$/.test(before) && /起/.test(after.slice(0, 3)) && /清償|利息/.test(t.slice(d.index, d.index + 60))) {
      return { date: d.value, raw: t.slice(Math.max(0, d.index - 1), d.index + d.raw.length + 8) };
    }
  }
  return null;
}

