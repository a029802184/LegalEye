// 流程 A：法院公文（執行命令 PDF）↔ 前端 Word 通知函。
// 通知函每頁通常對應一位債務人，重點變動文字為紅字。
// 配對依案號＋姓名，不依頁序；來源未提供的欄位一律「不適用／來源未提供」，不列為錯誤。

import { caseKey, compareCase, findCaseNumbers, findCourts, fmtCase, type CaseNo } from '../core/court';
import { centsToString, findLabeledAmounts, type LabeledAmount } from '../core/amount';
import { compareNames, uid } from '../core/text';
import { compareIds, isMasked, maskId } from '../core/idno';
import { findBankAccounts, findDebtorNames, findIds, type Hit } from '../core/extract';
import { RULESET_VERSION } from '../core/rules';
import type { BatchIssue, CheckItem, CheckUnit, ExtractedDoc, FlowResult } from '../core/types';
import { ev, item, provAt, type FlowContext, type PageHit } from './common';

interface Facts {
  doc: ExtractedDoc;
  pages: number[];
  courts: PageHit<{ canonical: string; raw: string; index: number }>[];
  cases: PageHit<CaseNo>[];
  names: PageHit<Hit>[];
  ids: PageHit<Hit>[];
  amounts: PageHit<LabeledAmount>[];
  accounts: PageHit<Hit>[];
  hasOrderTitle: boolean;
  redTexts: string[];
}

function collect(doc: ExtractedDoc, pages: number[], ctx: FlowContext): Facts {
  const f: Facts = { doc, pages, courts: [], cases: [], names: [], ids: [], amounts: [], accounts: [], hasOrderTitle: false, redTexts: [] };
  for (const pg of pages) {
    const p = doc.pages.find((x) => x.page === pg);
    if (!p) continue;
    const t = p.text;
    const push = <T extends { index: number; raw: string }>(arr: PageHit<T>[], hits: T[]) => {
      for (const h of hits) arr.push({ hit: h, page: pg, prov: provAt(doc, pg, h.index, h.raw) });
    };
    push(f.courts, findCourts(t, ctx.settings.courtAliases));
    push(
      f.cases,
      findCaseNumbers(t).filter((c) => !c.isDocRef),
    );
    push(f.names, findDebtorNames(t));
    push(f.ids, findIds(t));
    push(f.amounts, findLabeledAmounts(t));
    push(f.accounts, findBankAccounts(t));
    if (/執行命令/.test(t)) f.hasOrderTitle = true;
  }
  f.redTexts = (doc.redSpans ?? []).filter((r) => pages.includes(r.page)).map((r) => r.text.trim());
  return f;
}

/** 法院公文：依案號（＋債務人）切組；沒有案號的頁面視為前一組的續頁 */
function groupCourtPages(doc: ExtractedDoc): number[][] {
  const groups: { key: string; pages: number[] }[] = [];
  for (const p of doc.pages) {
    const cases = findCaseNumbers(p.text).filter((c) => !c.isDocRef);
    const names = findDebtorNames(p.text);
    const key = cases.length ? caseKey(cases[0]) + '|' + (names[0]?.value ?? '') : '';
    const cur = groups[groups.length - 1];
    const startsNew = !!key && (!cur || (cur.key !== key && /執行命令|受文者|發文/.test(p.text.slice(0, 160))));
    if (!cur || startsNew) groups.push({ key, pages: [p.page] });
    else {
      cur.pages.push(p.page);
      if (!cur.key && key) cur.key = key;
    }
  }
  return groups.map((g) => g.pages);
}

export function runFlowA(docs: ExtractedDoc[], ctx: FlowContext): FlowResult {
  const issues: BatchIssue[] = [];
  const notDone: string[] = [];
  const courtDocs = docs.filter((d) => d.role === 'court-notice' || d.role === 'merged-source');
  const letters = docs.filter((d) => d.role === 'notice-letter');
  if (!courtDocs.length) issues.push({ id: uid('i'), level: 'error', message: '找不到法院公文／執行命令。請確認檔案角色或手動指定。' });
  if (!letters.length) issues.push({ id: uid('i'), level: 'error', message: '找不到 Word 通知函。請確認檔案角色或手動指定。' });
  for (const d of [...courtDocs, ...letters]) {
    if (d.status === 'needs-ocr' || d.status === 'error') {
      issues.push({ id: uid('i'), level: 'error', message: `${d.file.path}：${d.warnings.join('；') || '無法讀取'}`, fileId: d.file.id });
      notDone.push(`${d.file.path} 無法讀取文字，相關比對未完成`);
    }
  }

  const courtGroups: Facts[] = [];
  for (const d of courtDocs) for (const pages of groupCourtPages(d)) courtGroups.push(collect(d, pages, ctx));

  const units: CheckUnit[] = [];
  const used = new Set<Facts>();
  for (const letter of letters) {
    for (const p of letter.pages) {
      if (!p.text.trim()) continue;
      const lf = collect(letter, [p.page], ctx);
      if (!lf.cases.length && !lf.names.length) continue; // 封面或空白頁
      const lCase = lf.cases[0]?.hit;
      const lName = lf.names[0]?.hit.value ?? '';
      // 配對：案號完全相同 → 再以姓名區分；找不到再以姓名找（案號可能誤植）
      let cands = lCase ? courtGroups.filter((g) => g.cases.some((c) => caseKey(c.hit) === caseKey(lCase))) : [];
      if (cands.length > 1 && lName) {
        const byName = cands.filter((g) => g.names.some((n) => compareNames(n.hit.value, lName) !== 'different'));
        if (byName.length) cands = byName;
      }
      let pairedBy = '案號';
      if (!cands.length && lName) {
        cands = courtGroups.filter((g) => g.names.some((n) => ['exact', 'alias'].includes(compareNames(n.hit.value, lName))));
        pairedBy = '債務人姓名（案號未對上）';
      }
      const g = cands.length === 1 ? cands[0] : undefined;
      const unit: CheckUnit = {
        id: uid('u'),
        label: lName || `通知函第 ${p.page} 頁`,
        subLabel: lCase ? fmtCase(lCase) : '通知函未辨識到案號',
        docs: [{ role: 'notice-letter', fileId: letter.file.id, pages: [p.page] }],
        items: [],
        match: g
          ? { score: pairedBy === '案號' ? 0.95 : 0.6, evidence: [`依${pairedBy}配對法院公文 ${g.doc.file.path} 第 ${g.pages.join('、')} 頁`], needsManual: pairedBy !== '案號' }
          : { score: 0, evidence: [cands.length > 1 ? `有 ${cands.length} 份法院公文符合，需人工指定` : '找不到對應的法院公文'], needsManual: true },
      };
      if (g) {
        used.add(g);
        unit.docs.push({ role: 'court-notice', fileId: g.doc.file.id, pages: g.pages });
        unit.items = compareA(lf, g, ctx);
      } else {
        unit.items = [item(ctx, 'A.case', '配對', 'missing', 'high', unit.match!.evidence[0], lCase ? { b: ev('通知函案號', lf.cases[0].hit.raw, fmtCase(lCase), lf.cases[0].prov) } : {})];
      }
      unit.items.push(...internalA(lf, ctx));
      units.push(unit);
    }
  }
  for (const g of courtGroups) {
    if (!used.has(g)) {
      const c = g.cases[0]?.hit;
      issues.push({
        id: uid('i'),
        level: 'warning',
        message: `法院公文 ${g.doc.file.path} 第 ${g.pages.join('、')} 頁（${c ? fmtCase(c) : '未辨識案號'}${g.names[0] ? '，' + g.names[0].hit.value : ''}）沒有對應的通知函`,
        fileId: g.doc.file.id,
      });
    }
  }
  return { flow: 'A', units, batchIssues: issues, notDone, ruleVersion: RULESET_VERSION, createdAt: new Date().toISOString() };
}

function compareA(l: Facts, c: Facts, ctx: FlowContext): CheckItem[] {
  const items: CheckItem[] = [];
  // 法院
  const lc = l.courts[0];
  const cc = c.courts[0];
  if (!cc) items.push(item(ctx, 'A.court', '法院名稱', 'missing', 'medium', '法院公文未辨識到法院名稱（可能為掃描或格式特殊）'));
  else if (!lc) items.push(item(ctx, 'A.court', '法院名稱', 'missing', 'medium', '通知函未記載法院名稱', { a: ev('法院公文', cc.hit.raw, cc.hit.canonical, cc.prov) }));
  else
    items.push(
      item(ctx, 'A.court', '法院名稱', lc.hit.canonical === cc.hit.canonical ? 'match' : 'mismatch', 'high', lc.hit.canonical === cc.hit.canonical ? '法院名稱一致（已正規化臺／台與簡稱）' : '法院名稱不同', {
        a: ev('法院公文', cc.hit.raw, cc.hit.canonical, cc.prov),
        b: ev('通知函', lc.hit.raw, lc.hit.canonical, lc.prov),
      }),
    );
  // 案號
  const lk = l.cases[0];
  const ck = c.cases[0];
  if (lk && ck) {
    const cmp = compareCase(ck.hit, lk.hit);
    items.push(
      item(ctx, 'A.case', '年度／字別／案號', cmp.equal ? 'match' : 'mismatch', 'high', cmp.equal ? '年度、字別、案號完全一致' : cmp.diffs.join('；'), {
        a: ev('法院公文', ck.hit.raw, fmtCase(ck.hit), ck.prov),
        b: ev('通知函', lk.hit.raw, fmtCase(lk.hit), lk.prov),
      }),
    );
  } else items.push(item(ctx, 'A.case', '年度／字別／案號', 'missing', 'high', !ck ? '法院公文未辨識到案號' : '通知函未辨識到案號'));
  // 姓名
  const ln = l.names[0];
  const cn = c.names[0];
  if (ln && cn) {
    const r = compareNames(cn.hit.value, ln.hit.value);
    const map = {
      exact: ['match', '姓名一致'],
      alias: ['match', '以「即／原名」別名對應一致，請確認別名記載'],
      'variant-suspect': ['needs-review', '姓名有一字不同或疑似異體字，不自動視為一致'],
      different: ['mismatch', '債務人姓名不同'],
    } as const;
    items.push(
      item(ctx, 'A.name', '債務人姓名', map[r][0], 'high', map[r][1], {
        a: ev('法院公文', cn.hit.raw, cn.hit.value, cn.prov),
        b: ev('通知函', ln.hit.raw, ln.hit.value, ln.prov),
      }),
    );
  } else items.push(item(ctx, 'A.name', '債務人姓名', 'missing', 'high', !cn ? '法院公文未辨識到債務人姓名' : '通知函未辨識到債務人姓名'));
  // 身分證
  const li = l.ids[0];
  const ci = c.ids[0];
  if (!ci) items.push(item(ctx, 'A.id', '身分證字號', 'not-applicable', 'info', '法院公文未提供身分證字號（來源未提供），不判定錯誤', li ? { b: ev('通知函', maskId(li.hit.value), maskId(li.hit.value), li.prov) } : {}));
  else if (!li) items.push(item(ctx, 'A.id', '身分證字號', 'not-applicable', 'info', '通知函未記載身分證字號', { a: ev('法院公文', maskId(ci.hit.value), maskId(ci.hit.value), ci.prov) }));
  else {
    const r = compareIds(ci.hit.value, li.hit.value);
    const st = r === 'full' ? 'match' : r === 'partial' ? 'partial' : r === 'mismatch' ? 'mismatch' : 'missing';
    const reason =
      r === 'full' ? '全碼一致（檢查碼通過不代表確屬本人）' : r === 'partial' ? `來源${isMasked(ci.hit.value) ? '為遮罩版本' : '不完整'}，僅可見部分一致（部分核對）` : r === 'mismatch' ? '可見位數不一致' : '可見位數不足，無法比對';
    items.push(item(ctx, 'A.id', '身分證字號', st, 'high', reason, { a: ev('法院公文', maskId(ci.hit.value), maskId(ci.hit.value), ci.prov), b: ev('通知函', maskId(li.hit.value), maskId(li.hit.value), li.prov) }));
  }
  // 金額
  const key = (a: LabeledAmount) => ['principal', 'balance', 'total', 'other'].includes(a.kind);
  const cAmts = c.amounts.filter((a) => key(a.hit));
  const lAmts = l.amounts.filter((a) => key(a.hit));
  if (!cAmts.length) items.push(item(ctx, 'A.amount', '債權金額', 'not-applicable', 'info', '法院公文未記載債權金額（來源未提供），不判定錯誤'));
  else if (!lAmts.length) items.push(item(ctx, 'A.amount', '債權金額', 'missing', 'medium', '通知函未辨識到金額', { a: ev('法院公文', cAmts[0].hit.raw, centsToString(cAmts[0].hit.cents), cAmts[0].prov) }));
  else {
    const la = lAmts[0];
    const same = cAmts.find((x) => x.hit.cents === la.hit.cents);
    const sameKind = cAmts.find((x) => x.hit.kind === la.hit.kind);
    if (same) items.push(item(ctx, 'A.amount', '債權金額', 'match', 'high', '金額相同（以數值比較，國字與數字等值）', { a: ev('法院公文', same.hit.raw, centsToString(same.hit.cents), same.prov), b: ev('通知函', la.hit.raw, centsToString(la.hit.cents), la.prov) }));
    else
      items.push(
        item(ctx, 'A.amount', '債權金額', sameKind ? 'mismatch' : 'needs-review', sameKind ? 'high' : 'medium', sameKind ? '同性質金額不同' : '金額不同，且兩者性質（本金／費用／總額）可能不同，請人工確認', {
          a: ev('法院公文', (sameKind ?? cAmts[0]).hit.raw, centsToString((sameKind ?? cAmts[0]).hit.cents), (sameKind ?? cAmts[0]).prov),
          b: ev('通知函', la.hit.raw, centsToString(la.hit.cents), la.prov),
        }),
      );
  }
  // 帳號
  const la = l.accounts[0];
  if (la) {
    const master = ctx.settings.bankMaster;
    if (master.length) {
      const ok = master.find((m) => m.account === la.hit.value);
      items.push(item(ctx, 'A.account', '公司銀行帳號', ok ? 'match' : 'mismatch', 'high', ok ? `與公司帳號主檔「${ok.label}」一致（依公司主檔核對）` : '不在公司帳號主檔中（依公司主檔核對）', { b: ev('通知函', la.hit.raw, la.hit.value, la.prov) }));
    } else if (c.accounts.length) {
      const ok = c.accounts.some((x) => x.hit.value === la.hit.value);
      items.push(item(ctx, 'A.account', '公司銀行帳號', ok ? 'match' : 'mismatch', 'high', ok ? '與法院公文所載帳號一致' : '與法院公文所載帳號不同', { a: ev('法院公文', c.accounts[0].hit.raw, c.accounts[0].hit.value, c.accounts[0].prov), b: ev('通知函', la.hit.raw, la.hit.value, la.prov) }));
    } else
      items.push(item(ctx, 'A.account', '公司銀行帳號', 'not-applicable', 'info', '法院公文未記載帳號，且未設定公司帳號主檔，不判定對錯（可於規則設定新增主檔）', { b: ev('通知函', la.hit.raw, la.hit.value, la.prov) }));
  }
  // 附件：執行命令
  const lText = l.pages.map((pg) => l.doc.pages.find((x) => x.page === pg)?.text ?? '').join('\n');
  if (/執行命令/.test(lText)) {
    items.push(item(ctx, 'A.attach', '附件執行命令名稱', c.hasOrderTitle ? 'match' : 'needs-review', 'medium', c.hasOrderTitle ? '通知函提及執行命令，配對之法院公文含「執行命令」' : '通知函提及執行命令，但配對之法院公文未出現「執行命令」字樣'));
  }
  return items;
}

/** 通知函同一頁內的案號／姓名一致性（主旨、支票備註、附件欄重複出現時） */
function internalA(l: Facts, ctx: FlowContext): CheckItem[] {
  const items: CheckItem[] = [];
  const keys = [...new Set(l.cases.map((c) => caseKey(c.hit)))];
  if (l.cases.length >= 2) {
    const first = l.cases[0];
    const bad = l.cases.find((c) => caseKey(c.hit) !== caseKey(first.hit));
    items.push(
      item(ctx, 'A.internal', '通知函內案號一致性', keys.length === 1 ? 'match' : 'mismatch', 'high', keys.length === 1 ? `同頁 ${l.cases.length} 處案號一致` : `同頁出現 ${keys.length} 種案號：${l.cases.map((c) => fmtCase(c.hit)).join('、')}`, bad ? { a: ev('首次記載', first.hit.raw, fmtCase(first.hit), first.prov), b: ev('其他位置', bad.hit.raw, fmtCase(bad.hit), bad.prov) } : {}),
    );
  }
  const names = [...new Set(l.names.map((n) => n.hit.value))];
  if (l.names.length >= 2) {
    const base = l.names[0];
    const bad = l.names.find((n) => compareNames(n.hit.value, base.hit.value) === 'different' || compareNames(n.hit.value, base.hit.value) === 'variant-suspect');
    items.push(
      item(ctx, 'A.internal', '通知函內姓名一致性', bad ? 'mismatch' : 'match', 'high', bad ? `同頁出現不同姓名：${names.join('、')}` : `同頁 ${l.names.length} 處姓名一致`, bad ? { a: ev('首次記載', base.hit.raw, base.hit.value, base.prov), b: ev('其他位置', bad.hit.raw, bad.hit.value, bad.prov) } : {}),
    );
  }
  return items;
}
