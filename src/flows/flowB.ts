// 流程 B：民事強制執行聲請狀 ↔ 支付命令正本、確定證明書、送達證書、債權資料。
// 合併 PDF 先依頁面標題與案號拆組，不把整份全文混在一起比對。

import { caseKey, compareCase, findCaseNumbers, findCourts, fmtCase, type CaseNo } from '../core/court';
import { centsToString, findAmountPairs, findArithmetic, findLabeledAmounts, type AmountKind } from '../core/amount';
import { compareAddress, compareNames, normLoose, uid } from '../core/text';
import { compareIds, maskId, validateTwId } from '../core/idno';
import { findAddresses, findAttachmentRefs, findCreditorNames, findDebtorNames, findIds, findRates } from '../core/extract';
import { findDates, fmtBoth, parseDate, sameDay, type YMD } from '../core/date';
import { computeInterestStart, detectInterestClause, detectServiceMethod, SERVICE_METHOD_LABEL, type ServiceMethod } from '../core/service';
import { pageRole } from '../core/classify';
import { RULESET_VERSION } from '../core/rules';
import type { BatchIssue, CheckItem, CheckUnit, DocRole, ExtractedDoc, FlowResult } from '../core/types';
import { ev, item, provAt, type FlowContext } from './common';

/** 使用者在畫面上補充的送達資料（優先於自動辨識） */
export interface ServiceManualInput {
  method?: ServiceMethod;
  serviceDate?: string; // ISO
  pickupDate?: string;
  courtConfirmedEffective?: string;
  multipleDebtorsDiffer?: boolean;
}

export interface FlowBContext extends FlowContext {
  service?: Record<string, ServiceManualInput>; // key: caseKey
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
  pages: SrcPage[];
}

function splitSources(docs: ExtractedDoc[]): CaseGroup[] {
  const groups: CaseGroup[] = [];
  for (const d of docs) {
    let cur: CaseGroup | undefined;
    for (const p of d.pages) {
      const role = d.role === 'merged-source' ? pageRole(p.text) : pageRole(p.text) !== 'unknown' ? pageRole(p.text) : d.role;
      const c = findCaseNumbers(p.text).find((x) => !x.isDocRef);
      const k = c ? caseKey(c) : '';
      if (k) {
        cur = groups.find((g) => g.key === k);
        if (!cur) {
          cur = { key: k, caseNo: c, pages: [] };
          groups.push(cur);
        }
      } else if (!cur) {
        cur = { key: `__${d.file.id}`, pages: [] };
        groups.push(cur);
      }
      cur.pages.push({ doc: d, page: p.page, role, text: p.text });
    }
  }
  return groups;
}


export function runFlowB(docs: ExtractedDoc[], ctx: FlowBContext): FlowResult {
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
  const groups = splitSources(sources);
  const usedKeys = new Set<string>();
  const units: CheckUnit[] = [];

  for (const pet of petitions) {
    const pText = pet.fullText;
    const pCases = findCaseNumbers(pText).filter((c) => !c.isDocRef);
    const refKeys = [...new Set(pCases.map(caseKey))];
    const targets = refKeys.map((k) => groups.find((g) => g.key === k)).filter((g): g is CaseGroup => !!g);
    if (!refKeys.length) {
      units.push({
        id: uid('u'),
        label: pet.file.name,
        subLabel: '聲請狀未辨識到執行名義案號',
        docs: [{ role: 'enforcement-petition', fileId: pet.file.id }],
        items: [item(ctx, 'B.case', '執行名義案號', 'missing', 'high', '聲請狀未辨識到執行名義案號，無法與來源拆組配對')],
        match: { score: 0, evidence: ['無案號可配對'], needsManual: true },
      });
      continue;
    }
    for (const k of refKeys) {
      const g = groups.find((x) => x.key === k);
      const pc = pCases.find((c) => caseKey(c) === k)!;
      const unit: CheckUnit = {
        id: uid('u'),
        label: findDebtorNames(pText)[0]?.value ?? pet.file.name,
        subLabel: fmtCase(pc),
        docs: [{ role: 'enforcement-petition', fileId: pet.file.id }],
        items: [],
        match: g ? { score: 0.95, evidence: [`依案號 ${fmtCase(pc)} 配對來源 ${g.pages.length} 頁`], needsManual: false } : { score: 0, evidence: ['來源文件中找不到相同案號'], needsManual: true },
      };
      if (!g) {
        // 案號可能誤植：列出來源中的其他案號
        const others = groups.filter((x) => x.caseNo).map((x) => fmtCase(x.caseNo!));
        unit.items.push(
          item(ctx, 'B.case', '執行名義案號', 'mismatch', 'high', `聲請狀引用的案號在來源文件中找不到${others.length ? `；來源案號為：${others.join('、')}` : ''}`, {
            b: ev('聲請狀', pc.raw, fmtCase(pc), provAt(pet, pagesOfIndex(pet, pc.raw), 0, pc.raw)),
          }),
        );
        units.push(unit);
        continue;
      }
      usedKeys.add(k);
      for (const pg of g.pages) {
        const ex = unit.docs.find((d) => d.fileId === pg.doc.file.id && d.role === pg.role);
        if (ex) ex.pages = [...(ex.pages ?? []), pg.page];
        else unit.docs.push({ role: pg.role, fileId: pg.doc.file.id, pages: [pg.page] });
      }
      unit.items = compareB(pet, pc, g, ctx, targets.length > 1);
      units.push(unit);
    }
  }
  for (const g of groups) {
    if (!usedKeys.has(g.key) && g.caseNo) {
      issues.push({ id: uid('i'), level: 'info', message: `來源中的 ${fmtCase(g.caseNo)}（${g.pages.length} 頁）未被任何聲請狀引用`, fileId: g.pages[0].doc.file.id });
    }
  }
  return { flow: 'B', units, batchIssues: issues, notDone, ruleVersion: RULESET_VERSION, createdAt: new Date().toISOString() };
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

function compareB(pet: ExtractedDoc, pc: CaseNo, g: CaseGroup, ctx: FlowBContext, multi: boolean): CheckItem[] {
  const items: CheckItem[] = [];
  const petPages = pet.pages.map((p) => ({ doc: pet, page: p.page, text: p.text }));
  const orderPages = g.pages.filter((p) => p.role === 'payment-order');
  const certPages = g.pages.filter((p) => p.role === 'finality-cert');
  const servicePages = g.pages.filter((p) => p.role === 'service-proof');
  const srcMain = orderPages.length ? orderPages : g.pages;

  // 1. 當事人
  const pCred = firstHit(petPages, findCreditorNames);
  const oCred = firstHit(srcMain, findCreditorNames);
  if (pCred && oCred) {
    const same = normLoose(pCred.hit.value) === normLoose(oCred.hit.value);
    items.push(item(ctx, 'B.party', '債權人', same ? 'match' : 'mismatch', 'high', same ? '債權人名稱一致' : '債權人名稱不同', { a: ev('支付命令', oCred.hit.raw, oCred.hit.value, oCred.prov), b: ev('聲請狀', pCred.hit.raw, pCred.hit.value, pCred.prov) }));
  } else items.push(item(ctx, 'B.party', '債權人', 'missing', 'medium', !oCred ? '來源未辨識到債權人' : '聲請狀未辨識到債權人'));
  const pDeb = firstHit(petPages, findDebtorNames);
  const oDeb = firstHit(srcMain, findDebtorNames);
  if (pDeb && oDeb) {
    const r = compareNames(oDeb.hit.value, pDeb.hit.value);
    const st = r === 'exact' || r === 'alias' ? 'match' : r === 'variant-suspect' ? 'needs-review' : 'mismatch';
    items.push(item(ctx, 'B.party', '債務人', st, 'high', r === 'alias' ? '以別名（即／原名）對應一致' : r === 'variant-suspect' ? '姓名一字不同或疑似異體字' : st === 'match' ? '債務人姓名一致' : '債務人姓名不同', { a: ev('支付命令', oDeb.hit.raw, oDeb.hit.value, oDeb.prov), b: ev('聲請狀', pDeb.hit.raw, pDeb.hit.value, pDeb.prov) }));
  } else items.push(item(ctx, 'B.party', '債務人', 'missing', 'high', !oDeb ? '來源未辨識到債務人' : '聲請狀未辨識到債務人'));
  const pId = firstHit(petPages, findIds);
  const oId = firstHit(srcMain, findIds);
  if (pId && oId) {
    const r = compareIds(oId.hit.value, pId.hit.value);
    items.push(item(ctx, 'B.party', '身分證字號', r === 'full' ? 'match' : r === 'partial' ? 'partial' : r === 'mismatch' ? 'mismatch' : 'missing', 'high', r === 'full' ? '全碼一致' : r === 'partial' ? '來源遮罩，僅可見部分一致' : r === 'mismatch' ? '身分證字號不同' : '可見位數不足', { a: ev('支付命令', maskId(oId.hit.value), maskId(oId.hit.value), oId.prov), b: ev('聲請狀', maskId(pId.hit.value), maskId(pId.hit.value), pId.prov) }));
  } else if (pId && !validateTwId(pId.hit.value) && !/[*X]/.test(pId.hit.value)) {
    items.push(item(ctx, 'B.party', '身分證字號', 'needs-review', 'medium', '聲請狀身分證字號檢查碼不符（來源未提供可比對資料）', { b: ev('聲請狀', maskId(pId.hit.value), maskId(pId.hit.value), pId.prov) }));
  } else items.push(item(ctx, 'B.party', '身分證字號', 'not-applicable', 'info', '來源或聲請狀未記載身分證字號'));

  // 2. 住址
  const pAddr = firstHit(petPages, findAddresses);
  const oAddr = firstHit(srcMain, findAddresses);
  if (pAddr && oAddr) {
    const r = compareAddress(oAddr.hit.value, pAddr.hit.value);
    items.push(
      item(ctx, 'B.address', '債務人住址', r.equal ? 'match' : 'needs-review', 'medium', r.equal ? '住址一致（已正規化全半形、郵遞區號、臺台）' : `住址不同（自第 ${(r.diffAt ?? 0) + 1} 字起）；不同日期文件住址可能不同，請以戶籍或最新確認資料判斷`, {
        a: ev('支付命令', oAddr.hit.raw, oAddr.hit.value, oAddr.prov),
        b: ev('聲請狀', pAddr.hit.raw, pAddr.hit.value, pAddr.prov),
      }),
    );
  } else items.push(item(ctx, 'B.address', '債務人住址', 'missing', 'low', !oAddr ? '來源未辨識到住址' : '聲請狀未辨識到住址'));

  // 3. 法院與案號
  const oCase = g.caseNo!;
  const cmp = compareCase(oCase, pc);
  items.push(item(ctx, 'B.case', '年度／字別／案號', cmp.equal ? 'match' : 'mismatch', 'high', cmp.equal ? '一致' : cmp.diffs.join('；'), { a: ev('來源', oCase.raw, fmtCase(oCase)), b: ev('聲請狀', pc.raw, fmtCase(pc)) }));
  // 聲請狀中緊鄰案號前的法院 = 執行名義法院
  const pIdx = pet.fullText.normalize('NFKC').indexOf(pc.raw);
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
  const oPrincipal = byKind(oAm, 'principal')[0] ?? oAm.find((a) => a.kind === 'other');
  const pPrincipal = byKind(pAm, 'principal')[0];
  if (oPrincipal && pPrincipal) {
    const same = oPrincipal.cents === pPrincipal.cents;
    items.push(
      item(ctx, 'B.amount', '本金', same ? 'match' : 'mismatch', 'high', same ? '本金一致' : '本金不同', {
        a: ev('支付命令', oPrincipal.raw, centsToString(oPrincipal.cents)),
        b: ev('聲請狀', pPrincipal.raw, centsToString(pPrincipal.cents)),
      }),
    );
  } else items.push(item(ctx, 'B.amount', '本金', 'missing', 'high', !oPrincipal ? '支付命令未辨識到本金' : '聲請狀未辨識到本金'));
  const oFee = byKind(oAm, 'fee')[0];
  const pFee = byKind(pAm, 'fee')[0];
  if (oFee && pFee) {
    const same = oFee.cents === pFee.cents;
    items.push(item(ctx, 'B.amount', '程序費用', same ? 'match' : 'mismatch', 'medium', same ? '程序費用一致' : '程序費用不同', { a: ev('支付命令', oFee.raw, centsToString(oFee.cents)), b: ev('聲請狀', pFee.raw, centsToString(pFee.cents)) }));
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
  const manual = ctx.service?.[g.key] ?? {};
  const svcText = servicePages.map((p) => p.text).join('\n');
  const autoMethod: ServiceMethod = servicePages.length ? detectServiceMethod(svcText) : 'unknown';
  const autoDate = servicePages.length ? serviceDateFromText(svcText) : null;
  const method = manual.method ?? autoMethod;
  const svcDate = manual.serviceDate ? parseDate(manual.serviceDate) : autoDate;
  const res = computeInterestStart({
    clause: clause.clause,
    method,
    serviceDate: svcDate,
    pickupDate: manual.pickupDate ? parseDate(manual.pickupDate) : null,
    courtConfirmedEffective: manual.courtConfirmedEffective ? parseDate(manual.courtConfirmedEffective) : null,
    multipleDebtorsDiffer: manual.multipleDebtorsDiffer || multi,
  });
  const petStart = petitionInterestStart(pet.fullText);
  const inputs = [
    `執行名義利息條款：${clause.raw || '未辨識'}`,
    `送達方式：${SERVICE_METHOD_LABEL[method]}${manual.method ? '（人工輸入）' : servicePages.length ? '（自送達證書辨識）' : ''}`,
    `送達／寄存日：${svcDate ? fmtBoth(svcDate) : '未取得'}${manual.serviceDate ? '（人工輸入）' : ''}`,
    `書狀填寫起息日：${petStart ? fmtBoth(petStart.date) : '未辨識'}`,
  ];
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
  items.push(
    item(ctx, 'B.interest', '利息起算日', st, 'high', reason, {
      a: res.interestStart ? ev('依規則計算', res.formula, fmtBoth(res.interestStart)) : ev('依規則計算', res.formula, '無法自動計算'),
      b: petStart ? ev('聲請狀', petStart.raw, fmtBoth(petStart.date)) : undefined,
      calc: [res.formula, ...inputs].join('\n'),
      basis: [...res.basis, `規則版本 ${res.ruleVersion}`],
    }),
  );
  const oRate = findRates(oText)[0];
  const pRate = findRates(pet.fullText)[0];
  if (oRate && pRate) {
    items.push(item(ctx, 'B.interest', '利率', oRate.value === pRate.value ? 'match' : 'mismatch', 'high', oRate.value === pRate.value ? `年利率 ${oRate.value}% 一致` : '利率不同', { a: ev('支付命令', oRate.raw, oRate.value + '%'), b: ev('聲請狀', pRate.raw, pRate.value + '%') }));
  } else if (oRate || pRate) items.push(item(ctx, 'B.interest', '利率', 'missing', 'medium', oRate ? '聲請狀未辨識到利率' : '支付命令未辨識到利率'));
  return items;
}

/** 送達證書：優先取「寄存」或「送達」旁的日期 */
export function serviceDateFromText(text: string): YMD | null {
  const t = text.normalize('NFKC');
  const dates = findDates(t).filter((d) => d.valid);
  if (!dates.length) return null;
  const near = dates.find((d) => /(送達|寄存|收受|簽收)[^\n]{0,12}$/.test(t.slice(Math.max(0, d.index - 16), d.index)));
  return (near ?? dates[0]).value;
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

