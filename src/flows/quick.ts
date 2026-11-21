// 快速文字校對（保留自 LegalDesk 概念驗證版的「強執狀校對」功能並強化）：
// 貼上文字或匯入 TXT／DOCX，對照人工輸入的案件基準資料，並檢查範本占位符、姓名前後不一致、
// 國字／數字金額、驗算式、無效日期。沒有基準資料的欄位不判定對錯。

import { centsToString, findAmountPairs, findArithmetic, findLabeledAmounts, parseAmount } from '../core/amount';
import { caseKey, findCaseNumbers, fmtCase } from '../core/court';
import { findDates } from '../core/date';
import { findCreditorNames, findDebtorNames } from '../core/extract';
import { RULESET_VERSION } from '../core/rules';
import { compareNames, normLoose, uid } from '../core/text';
import type { CheckItem, ExtractedDoc, FlowResult } from '../core/types';
import { ev, item, provAt, type FlowContext } from './common';

export interface QuickBaseline {
  creditor: string;
  debtor: string;
  caseNo: string;
  principal: string;
}

export const PLACEHOLDER_RE = /[○〇]{2,}|_{3,}|＿{2,}|[ＸX]{3,}|[（(]\s*[）)]|【[^】]{0,20}(?:填寫|請填|案號|姓名|金額)[^】]{0,20}】|請(?:填寫|輸入)[一-鿿]{0,6}/g;

export function runQuickCheck(doc: ExtractedDoc, base: QuickBaseline, ctx: FlowContext): FlowResult {
  const t = doc.fullText.normalize('NFKC');
  const items: CheckItem[] = [];
  const pv = (raw: string) => {
    const p = doc.pages.find((x) => x.text.normalize('NFKC').includes(raw)) ?? doc.pages[0];
    return provAt(doc, p?.page ?? 1, p ? p.text.normalize('NFKC').indexOf(raw) : 0, raw);
  };

  // 1. 基準資料：債權人
  const creds = findCreditorNames(t);
  if (base.creditor.trim()) {
    const ok = normLoose(t).includes(normLoose(base.creditor));
    const other = creds.find((c) => normLoose(c.value) !== normLoose(base.creditor));
    items.push(
      item(ctx, 'B.party', '債權人（基準資料）', ok && !other ? 'match' : 'mismatch', 'high', ok ? (other ? `書狀另出現不同債權人「${other.value}」` : '書狀記載與基準資料相同') : '書狀中找不到與基準資料相同的債權人名稱', {
        a: ev('基準資料', base.creditor, base.creditor),
        b: creds[0] ? ev('書狀', creds[0].raw, creds[0].value, pv(creds[0].raw)) : undefined,
      }),
    );
  } else items.push(item(ctx, 'B.party', '債權人（基準資料）', 'missing', 'info', '未提供基準資料，不判定對錯'));

  // 2. 基準資料：債務人＋前後一致
  const debs = findDebtorNames(t);
  if (base.debtor.trim()) {
    const res = debs.map((d) => ({ d, r: compareNames(base.debtor, d.value) }));
    const bad = res.find((x) => x.r === 'different' || x.r === 'variant-suspect');
    const found = res.some((x) => x.r === 'exact' || x.r === 'alias');
    items.push(
      item(ctx, 'B.party', '債務人（基準資料）', bad ? (bad.r === 'variant-suspect' ? 'needs-review' : 'mismatch') : found ? 'match' : 'missing', 'high', bad ? `疑似債務人姓名不一致：基準資料「${base.debtor}」，書狀「${bad.d.value}」。系統只提示疑點，不自動更正。` : found ? '書狀中的債務人與基準資料相同' : '書狀中未辨識到「債務人」後的姓名', {
        a: ev('基準資料', base.debtor, base.debtor),
        b: (bad ?? res[0]) ? ev('書狀', (bad ?? res[0])!.d.raw, (bad ?? res[0])!.d.value, pv((bad ?? res[0])!.d.raw)) : undefined,
      }),
    );
  }
  const names = [...new Set(debs.map((d) => d.value))];
  if (names.length > 1) {
    const pairs = names.slice(1).map((n) => ({ n, r: compareNames(names[0], n) }));
    const v = pairs.find((p) => p.r === 'variant-suspect');
    if (v) items.push(item(ctx, 'B.party', '債務人姓名前後一致', 'needs-review', 'high', `疑似債務人姓名前後不一致，請確認「${names[0]}」與「${v.n}」是否為同一人`));
    else items.push(item(ctx, 'B.party', '債務人姓名前後一致', 'needs-review', 'info', `書狀出現多位債務人：${names.join('、')}（多名債務人可能合法並存，請人工確認）`));
  }

  // 3. 案號
  const cases = findCaseNumbers(t).filter((c) => !c.isDocRef);
  if (base.caseNo.trim()) {
    const b = findCaseNumbers(base.caseNo)[0];
    if (!b) items.push(item(ctx, 'B.case', '執行名義案號（基準資料）', 'needs-review', 'medium', `無法解析基準案號「${base.caseNo}」，請以「114年度司促字第123號」格式輸入`));
    else {
      const same = cases.find((c) => caseKey(c) === caseKey(b));
      items.push(
        item(ctx, 'B.case', '執行名義案號（基準資料）', same ? 'match' : cases.length ? 'mismatch' : 'missing', 'high', same ? '書狀記載與基準案號相同' : cases.length ? `書狀案號為 ${cases.map(fmtCase).join('、')}，與基準資料不同（不同程序的案號可能合法並存，請確認）` : '書狀中未辨識到案號', {
          a: ev('基準資料', base.caseNo, fmtCase(b)),
          b: (same ?? cases[0]) ? ev('書狀', (same ?? cases[0])!.raw, fmtCase((same ?? cases[0])!), pv((same ?? cases[0])!.raw)) : undefined,
        }),
      );
    }
  }

  // 4. 本金
  const am = findLabeledAmounts(t);
  if (base.principal.trim()) {
    const v = parseAmount(base.principal);
    if (v === null) items.push(item(ctx, 'B.amount', '本金（基準資料）', 'needs-review', 'medium', '基準金額格式無法辨識，請輸入數字（例如 120000）'));
    else {
      const same = am.find((a) => a.cents === v);
      const principal = am.find((a) => a.kind === 'principal');
      items.push(
        item(ctx, 'B.amount', '本金（基準資料）', same ? 'match' : principal ? 'mismatch' : 'needs-review', 'high', same ? `書狀出現相同金額（性質判斷：${same.kind === 'principal' ? '本金／請求金額' : '其他，請確認'}）` : principal ? '書狀所載本金與基準資料不同' : '未找到相同金額；書狀中的其他金額可能代表利息、費用或部分清償，不直接判定錯誤', {
          a: ev('基準資料', base.principal, centsToString(v)),
          b: (same ?? principal) ? ev('書狀', (same ?? principal)!.raw, centsToString((same ?? principal)!.cents), pv((same ?? principal)!.raw)) : undefined,
        }),
      );
    }
  }
  // 同一性質金額前後矛盾（只比較本金）
  const principals = am.filter((a) => a.kind === 'principal');
  const pv2 = [...new Set(principals.map((a) => a.cents.toString()))];
  if (pv2.length > 1) {
    items.push(item(ctx, 'B.amount', '本金前後一致', 'mismatch', 'high', `書狀中標示為本金／請求的金額不一致：${principals.map((a) => a.raw).join('、')}`, { a: ev('第一次', principals[0].raw, centsToString(principals[0].cents), pv(principals[0].raw)), b: ev('其他', principals.find((x) => x.cents !== principals[0].cents)!.raw, centsToString(principals.find((x) => x.cents !== principals[0].cents)!.cents)) }));
  }
  for (const pr of findAmountPairs(t)) {
    const ok = pr.chinese.cents === pr.arabic.cents;
    items.push(item(ctx, 'B.amount', '國字與數字金額', ok ? 'match' : 'mismatch', 'high', ok ? '國字與數字等值' : '國字與數字不等', { a: ev('國字', pr.chinese.raw, centsToString(pr.chinese.cents)), b: ev('數字', pr.arabic.raw, centsToString(pr.arabic.cents)) }));
  }
  for (const a of findArithmetic(t)) {
    items.push(item(ctx, 'B.amount', '驗算式', a.ok ? 'match' : 'mismatch', 'high', a.ok ? `${a.expr} 正確` : `${a.expr} 應為 ${centsToString(a.expected)}`, { calc: a.expr }));
  }

  // 5. 日期
  for (const d of findDates(t).filter((x) => !x.valid)) {
    items.push(item(ctx, 'B.case', '無效日期', 'mismatch', 'medium', `「${d.raw}」不是有效日期`, { b: ev('書狀', d.raw, d.raw, pv(d.raw)) }));
  }

  // 6. 範本占位符
  const ph = [...new Set([...t.matchAll(PLACEHOLDER_RE)].map((m) => m[0]))];
  items.push(
    item(ctx, 'B.title', '範本未完成欄位', ph.length ? 'needs-review' : 'match', ph.length ? 'medium' : 'low', ph.length ? `發現可能尚未填妥的占位符：${ph.slice(0, 10).join('、')}（出現不代表一定錯誤，請確認）` : '未找到目前規則可辨識的占位符', ph[0] ? { b: ev('書狀', ph[0], ph[0], pv(ph[0])) } : {}),
  );

  // 7. 基本記載
  for (const [k, re, label] of [
    ['債權人', /債權人/, '債權人欄位'],
    ['債務人', /債務人/, '債務人欄位'],
    ['強制執行', /強制執行/, '書狀主旨'],
    ['附件', /附件|附證|證物|證據/, '附件用語'],
  ] as const) {
    items.push(item(ctx, 'B.title', label, re.test(t) ? 'match' : 'needs-review', 'low', re.test(t) ? `已偵測到「${k}」字樣（不代表內容正確）` : `未偵測到「${k}」字樣，請人工確認`));
  }

  return {
    flow: 'B',
    units: [{ id: uid('u'), label: '快速文字校對', subLabel: doc.file.name, docs: [{ role: 'enforcement-petition', fileId: doc.file.id }], items }],
    batchIssues: [],
    notDone: ['快速文字校對只比對使用者輸入的基準資料與書狀文字，未對照執行名義原本；執行名義效力、管轄、利息與附件齊備仍須人工審查'],
    ruleVersion: RULESET_VERSION,
    createdAt: new Date().toISOString(),
  };
}
