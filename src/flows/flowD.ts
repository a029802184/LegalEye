// 流程 D：民事陳報狀 ↔ 法院民事庭函、債務明細表（Excel）、陳報狀附件。
// 1) Excel 驗算  2) 陳報金額（國字／數字／附表／Excel）  3) 案件資訊  4) 開庭日期（僅庭函記載時）  5) 附件名稱與份數

import { centsToString, findAmountPairs, findLabeledAmounts } from '../core/amount';
import { compareCase, findCaseNumbers, findCourts, fmtCase } from '../core/court';
import { compareNames, uid } from '../core/text';
import { findAttachmentRefs, findDebtorNames, seqToNumber, type AttachmentRef } from '../core/extract';
import { findDates, fmtBoth, sameDay } from '../core/date';
import { cellAt, indexToCol } from '../core/xlsx';
import { RULESET_VERSION, synonymGroup } from '../core/rules';
import type { BatchIssue, CheckItem, CheckUnit, ExtractedDoc, FlowResult, Provenance, Sheet } from '../core/types';
import { ev, item, provAt, type FlowContext } from './common';

type ColKey = 'key' | 'telecom' | 'collect' | 'subsidy' | 'other' | 'paid' | 'balance';

export interface DebtTableResult {
  sheet?: string;
  headerRow?: number;
  cols: Partial<Record<ColKey, number>>;
  rows: { row: number; key: string; computed: bigint; stated: bigint | null; noCache: boolean }[];
  total?: { cents: bigint; ref: string; noCache: boolean };
  sumOfRows: bigint;
  paidNegative: boolean;
  warnings: string[];
}

function toCents(v: unknown): bigint | null {
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.round(v * 100));
  if (typeof v === 'string') {
    const s = v.replace(/[,\s元]/g, '');
    if (/^-?\d+(\.\d+)?$/.test(s)) return BigInt(Math.round(Number(s) * 100));
  }
  return null;
}

export function analyzeDebtTable(sheets: Sheet[], ctx: FlowContext): DebtTableResult {
  const syn = ctx.settings.debtColumns;
  const res: DebtTableResult = { cols: {}, rows: [], sumOfRows: 0n, paidNegative: false, warnings: [] };
  for (const sh of sheets) {
    for (let r = 1; r <= Math.min(20, sh.maxRow); r++) {
      const cols: Partial<Record<ColKey, number>> = {};
      for (let c = 1; c <= sh.maxCol; c++) {
        const t = (cellAt(sh, r, c)?.text ?? '').replace(/\s/g, '');
        if (!t) continue;
        for (const k of Object.keys(syn) as ColKey[]) {
          if (cols[k] === undefined && syn[k].some((s) => t.includes(s))) {
            cols[k] = c;
            break;
          }
        }
      }
      const amountCols = (['telecom', 'collect', 'subsidy', 'other', 'paid', 'balance'] as ColKey[]).filter((k) => cols[k] !== undefined);
      if (amountCols.length >= 3 && cols.balance !== undefined) {
        res.sheet = sh.name;
        res.headerRow = r;
        res.cols = cols;
        const keyCol = cols.key ?? 1;
        for (let rr = r + 1; rr <= sh.maxRow; rr++) {
          const label = (cellAt(sh, rr, keyCol)?.text ?? '') + (cellAt(sh, rr, 1)?.text ?? '');
          const balCell = cellAt(sh, rr, cols.balance);
          if (/合計|總計|小計|總額/.test(label)) {
            const v = toCents(balCell?.value);
            if (balCell && v !== null) res.total = { cents: v, ref: balCell.ref, noCache: !!balCell.formulaNoCache };
            else if (balCell?.formulaNoCache) res.total = { cents: 0n, ref: balCell.ref, noCache: true };
            break;
          }
          if (!balCell && !(['telecom', 'collect'] as ColKey[]).some((k) => cols[k] && cellAt(sh, rr, cols[k]!))) continue;
          const get = (k: ColKey) => (cols[k] ? toCents(cellAt(sh, rr, cols[k]!)?.value) ?? 0n : 0n);
          const paid = get('paid');
          if (paid < 0n) res.paidNegative = true;
          const computed = get('telecom') + get('collect') + get('subsidy') + get('other') - (paid < 0n ? -paid : paid);
          const anyNoCache = Object.values(cols).some((c) => cellAt(sh, rr, c!)?.formulaNoCache);
          res.rows.push({ row: rr, key: cellAt(sh, rr, keyCol)?.text ?? `第${rr}列`, computed, stated: toCents(balCell?.value), noCache: anyNoCache });
        }
        res.sumOfRows = res.rows.reduce((a, x) => a + (x.stated ?? 0n), 0n);
        if (res.paidNegative) res.warnings.push('已繳款欄位以負數記載，驗算時以「減去其絕對值」處理');
        return res;
      }
    }
  }
  res.warnings.push('找不到含「電信資費／代收費用／已繳款／未償債務」等欄位的表頭；可於規則設定調整欄位同義詞');
  return res;
}

function xlsxProv(doc: ExtractedDoc, sheet: string, ref: string, raw: string): Provenance {
  return { fileId: doc.file.id, fileName: doc.file.name, path: doc.file.path, kind: 'xlsx', sheet, cell: ref, method: 'xlsx', confidence: 1, raw };
}

export function runFlowD(docs: ExtractedDoc[], ctx: FlowContext): FlowResult {
  const issues: BatchIssue[] = [];
  const notDone: string[] = [];
  const letter = docs.find((d) => d.role === 'court-letter');
  const report = docs.find((d) => d.role === 'civil-report');
  const table = docs.find((d) => d.role === 'debt-table');
  // 附件候選：除庭函、陳報狀外的所有已辨識檔案（債務明細表也可能是書狀引用的附件）
  const attachments = docs.filter((d) => d !== letter && d !== report && d.role !== 'unknown');
  if (!report) issues.push({ id: uid('i'), level: 'error', message: '找不到民事陳報狀（Word）' });
  if (!letter) issues.push({ id: uid('i'), level: 'warning', message: '找不到法院民事庭函，案件資訊無法核對' });
  if (!table) issues.push({ id: uid('i'), level: 'warning', message: '找不到債務明細表（Excel），金額無法驗算' });
  for (const d of docs) {
    if (d.role === 'unknown') issues.push({ id: uid('i'), level: 'warning', message: `無法判斷文件角色：${d.file.path}`, fileId: d.file.id });
    if (d.status === 'needs-ocr' || d.status === 'error') {
      issues.push({ id: uid('i'), level: 'error', message: `${d.file.path}：${d.warnings.join('；')}`, fileId: d.file.id });
      notDone.push(`${d.file.path} 未取得文字`);
    }
  }
  const units: CheckUnit[] = [];

  // 1. Excel 驗算
  let excelTotal: { cents: bigint; prov: Provenance } | undefined;
  if (table?.sheets) {
    const t = analyzeDebtTable(table.sheets, ctx);
    const items: CheckItem[] = [];
    for (const w of t.warnings) items.push(item(ctx, 'D.excel', '表格結構', t.sheet ? 'match' : 'missing', 'info', w));
    for (const r of t.rows) {
      const ref = `${indexToCol(t.cols.balance!)}${r.row}`;
      if (r.noCache || r.stated === null) {
        items.push(item(ctx, 'D.excel', `${r.key} 未償金額`, 'unreadable', 'high', '公式沒有計算結果或儲存格空白，不能視為已核對；請在 Excel 重新計算後存檔', { b: ev('Excel', ref, '—', xlsxProv(table, t.sheet!, ref, '')) }));
        continue;
      }
      const ok = r.computed === r.stated;
      items.push(
        item(ctx, 'D.excel', `${r.key} 分項驗算`, ok ? 'match' : 'mismatch', 'high', ok ? '電信資費＋代收費用＋專案補貼款＋其他應收－已繳款＝未償債務' : `分項加總為 ${centsToString(r.computed)}，表上記載 ${centsToString(r.stated)}`, {
          calc: `電信資費＋代收費用＋專案補貼款＋其他應收－已繳款 = ${centsToString(r.computed)}`,
          b: ev('Excel', centsToString(r.stated), centsToString(r.stated), xlsxProv(table, t.sheet!, ref, centsToString(r.stated))),
        }),
      );
    }
    if (t.total) {
      if (t.total.noCache) items.push(item(ctx, 'D.excel', '總額', 'unreadable', 'high', '總額公式沒有計算結果，不能視為已核對', { b: ev('Excel', t.total.ref, '—', xlsxProv(table, t.sheet!, t.total.ref, '')) }));
      else {
        const ok = t.total.cents === t.sumOfRows;
        excelTotal = { cents: t.total.cents, prov: xlsxProv(table, t.sheet!, t.total.ref, centsToString(t.total.cents)) };
        items.push(item(ctx, 'D.excel', '總額', ok ? 'match' : 'mismatch', 'high', ok ? `各門號未償金額合計 ${centsToString(t.sumOfRows)} 與總額一致` : `各列合計 ${centsToString(t.sumOfRows)}，總額列記載 ${centsToString(t.total.cents)}`, { b: ev('Excel 總額', t.total.ref, centsToString(t.total.cents), excelTotal.prov) }));
      }
    } else if (t.rows.length) {
      excelTotal = { cents: t.sumOfRows, prov: xlsxProv(table, t.sheet!, `${indexToCol(t.cols.balance!)}*`, '各列加總') };
      items.push(item(ctx, 'D.excel', '總額', 'needs-review', 'medium', `表上找不到「合計／總計」列，以各列加總 ${centsToString(t.sumOfRows)} 作為比對基準`));
    }
    units.push({ id: `d:${table.file.id}:table`, label: '債務明細表驗算', subLabel: `${table.file.path}${t.sheet ? `・${t.sheet}` : ''}`, docs: [{ role: 'debt-table', fileId: table.file.id }], items });
  }

  // 2. 陳報金額
  if (report) {
    const items: CheckItem[] = [];
    const amts = findLabeledAmounts(report.fullText).filter((a) => ['balance', 'total', 'principal', 'other'].includes(a.kind));
    const pageOf = (raw: string) => report.pages.find((p) => p.text.normalize('NFKC').includes(raw))?.page ?? 1;
    const provOf = (raw: string) => {
      const pg = pageOf(raw);
      return provAt(report, pg, report.pages.find((p) => p.page === pg)!.text.normalize('NFKC').indexOf(raw), raw);
    };
    for (const pr of findAmountPairs(report.fullText)) {
      const ok = pr.chinese.cents === pr.arabic.cents;
      items.push(item(ctx, 'D.amount', '國字與數字金額', ok ? 'match' : 'mismatch', 'high', ok ? '國字金額與數字等值' : '國字金額與數字不等', { a: ev('國字', pr.chinese.raw, centsToString(pr.chinese.cents), provOf(pr.chinese.raw)), b: ev('數字', pr.arabic.raw, centsToString(pr.arabic.cents), provOf(pr.arabic.raw)) }));
    }
    if (excelTotal) {
      const seen = new Set<string>();
      for (const a of amts) {
        if (seen.has(a.raw)) continue;
        seen.add(a.raw);
        const ok = a.cents === excelTotal.cents;
        // 只有「未償／總額」性質或與總額相同者才比對，避免把分項金額誤報
        if (!ok && !['balance', 'total'].includes(a.kind)) continue;
        items.push(item(ctx, 'D.amount', `陳報金額（${a.form === 'chinese' ? '國字' : '數字'}）`, ok ? 'match' : 'mismatch', 'high', ok ? '與 Excel 未償債務總額一致' : '與 Excel 未償債務總額不同', { a: ev('Excel 總額', centsToString(excelTotal.cents), centsToString(excelTotal.cents), excelTotal.prov), b: ev('陳報狀', a.raw, centsToString(a.cents), provOf(a.raw)) }));
      }
      // Word 附表（表格）合計
      const tableTotals = (report.paragraphs ?? []).filter((p) => p.part === 'table' && /合計|總計/.test(p.text));
      for (const tp of tableTotals) {
        const nextAmts = (report.paragraphs ?? []).filter((p) => p.part === 'table' && p.index > tp.index && p.index <= tp.index + 6).flatMap((p) => {
          const n = Number(p.text.replace(/[,\s元]/g, ''));
          return /^\d[\d,]*$/.test(p.text.replace(/[\s元]/g, '')) && Number.isFinite(n) ? [{ p, cents: BigInt(Math.round(n * 100)) }] : [];
        });
        const last = nextAmts[nextAmts.length - 1];
        if (last) {
          const ok = last.cents === excelTotal.cents;
          items.push(item(ctx, 'D.amount', '陳報狀附表合計', ok ? 'match' : 'mismatch', 'high', ok ? '附表合計與 Excel 總額一致' : '附表合計與 Excel 總額不同', { a: ev('Excel 總額', centsToString(excelTotal.cents), centsToString(excelTotal.cents), excelTotal.prov), b: ev('附表', last.p.text, centsToString(last.cents), provAt(report, last.p.page, 0, last.p.text)) }));
        }
      }
    } else items.push(item(ctx, 'D.amount', '陳報金額', 'missing', 'high', '沒有可用的 Excel 總額（缺檔、公式無快取或表頭無法辨識），金額未核對'));
    units.push({ id: `d:${report.file.id}:amount`, label: '陳報金額', subLabel: report.file.path, docs: [{ role: 'civil-report', fileId: report.file.id }, ...(table ? [{ role: 'debt-table' as const, fileId: table.file.id }] : [])], items });
  }

  // 3–4. 案件資訊與開庭
  if (report && letter) {
    const items: CheckItem[] = [];
    const lt = letter.fullText;
    const rt = report.fullText;
    const lp = (raw: string) => provAt(letter, letter.pages.find((p) => p.text.normalize('NFKC').includes(raw))?.page ?? 1, 0, raw);
    const rp = (raw: string) => provAt(report, report.pages.find((p) => p.text.normalize('NFKC').includes(raw))?.page ?? 1, 0, raw);
    const lCourt = findCourts(lt, ctx.settings.courtAliases)[0];
    const rCourt = findCourts(rt, ctx.settings.courtAliases)[0];
    if (lCourt && rCourt) items.push(item(ctx, 'D.case', '法院全名', lCourt.canonical === rCourt.canonical ? 'match' : 'mismatch', 'high', lCourt.canonical === rCourt.canonical ? '一致' : '法院不同', { a: ev('庭函', lCourt.raw, lCourt.canonical, lp(lCourt.raw)), b: ev('陳報狀', rCourt.raw, rCourt.canonical, rp(rCourt.raw)) }));
    else items.push(item(ctx, 'D.case', '法院全名', 'missing', 'medium', !lCourt ? '庭函未辨識到法院' : '陳報狀未辨識到法院'));
    // 案號：排除庭函的「發文字號」
    const lCase = findCaseNumbers(lt).filter((c) => !c.isDocRef)[0];
    const rCase = findCaseNumbers(rt).filter((c) => !c.isDocRef)[0];
    if (lCase && rCase) {
      const cmp = compareCase(lCase, rCase);
      items.push(item(ctx, 'D.case', '年度／字別／案號', cmp.equal ? 'match' : 'mismatch', 'high', cmp.equal ? '一致（已排除庭函發文字號）' : cmp.diffs.join('；'), { a: ev('庭函', lCase.raw, fmtCase(lCase), lp(lCase.raw)), b: ev('陳報狀', rCase.raw, fmtCase(rCase), rp(rCase.raw)) }));
      if (lCase.division || rCase.division) {
        const ok = lCase.division === rCase.division;
        items.push(item(ctx, 'D.case', '股別', ok ? 'match' : lCase.division && rCase.division ? 'mismatch' : 'missing', 'medium', ok ? `${lCase.division}股一致` : !rCase.division ? '陳報狀未記載股別' : !lCase.division ? '庭函未記載股別' : '股別不同', { a: ev('庭函', lCase.division ?? '—', lCase.division ?? '—'), b: ev('陳報狀', rCase.division ?? '—', rCase.division ?? '—') }));
      }
    } else items.push(item(ctx, 'D.case', '年度／字別／案號', 'missing', 'high', !lCase ? '庭函未辨識到案件案號（發文字號不列入）' : '陳報狀未辨識到案號'));
    const lName = findDebtorNames(lt)[0] ?? findNameAfter(lt, /(?:被告|相對人)/);
    const rName = findDebtorNames(rt)[0] ?? findNameAfter(rt, /(?:被告|相對人)/);
    if (lName && rName) {
      const r = compareNames(lName.value, rName.value);
      items.push(item(ctx, 'D.case', '債務人姓名', r === 'exact' || r === 'alias' ? 'match' : r === 'variant-suspect' ? 'needs-review' : 'mismatch', 'high', r === 'alias' ? '以「即／原名」對應一致' : r === 'exact' ? '一致' : r === 'variant-suspect' ? '一字不同或疑似異體字' : '姓名不同', { a: ev('庭函', lName.raw, lName.value, lp(lName.raw)), b: ev('陳報狀', rName.raw, rName.value, rp(rName.raw)) }));
    }
    // 開庭：只有庭函確實記載時才比對
    const hearing = /(開庭|言詞辯論期日|準備程序期日|到庭)/.exec(lt);
    if (hearing) {
      const ld = findDates(lt.slice(Math.max(0, hearing.index - 40), hearing.index + 60)).find((d) => d.valid);
      const rd = ld ? findDates(rt).find((d) => d.valid && sameDay(d.value, ld.value)) : undefined;
      if (!ld) items.push(item(ctx, 'D.hearing', '開庭日期', 'needs-review', 'medium', '庭函提及開庭，但未辨識到日期'));
      else if (!/(開庭|期日|到庭)/.test(rt)) items.push(item(ctx, 'D.hearing', '開庭日期', 'not-applicable', 'info', `庭函記載期日 ${fmtBoth(ld.value)}；陳報狀未提及期日`));
      else items.push(item(ctx, 'D.hearing', '開庭日期', rd ? 'match' : 'mismatch', 'high', rd ? '期日一致' : '陳報狀所載期日與庭函不同', { a: ev('庭函', ld.raw, fmtBoth(ld.value)) }));
    } else items.push(item(ctx, 'D.hearing', '開庭日期', 'not-applicable', 'info', /陳報/.test(lt) ? '庭函為限期陳報，未記載開庭期日，不需比對' : '庭函未記載開庭期日'));
    units.push({ id: `d:${report.file.id}:case`, label: '案件資訊', subLabel: '庭函 ↔ 陳報狀', docs: [{ role: 'court-letter', fileId: letter.file.id }, { role: 'civil-report', fileId: report.file.id }], items });
  }

  // 5. 附件
  if (report) {
    units.push(checkAttachments(report, attachments, ctx));
  }
  return { flow: 'D', units, batchIssues: issues, notDone, ruleVersion: RULESET_VERSION, createdAt: new Date().toISOString() };
}

function findNameAfter(text: string, label: RegExp): { value: string; raw: string } | undefined {
  const m = new RegExp(label.source + '\\s*[:：]?\\s*([\\u4e00-\\u9fff]{2,4})').exec(text.normalize('NFKC'));
  return m ? { value: m[1], raw: m[0] } : undefined;
}

function cleanName(s: string): string {
  return s
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/^\d+[_\-.\s]*/, '')
    .replace(/(影本|正本|乙份|一份)$/, '')
    .replace(/[\s_\-]/g, '');
}

function namesMatch(ref: string, cand: string, ctx: FlowContext): 'exact' | 'synonym' | 'none' {
  const a = cleanName(ref);
  const b = cleanName(cand);
  if (!a || !b) return 'none';
  if (a === b || b.includes(a) || a.includes(b)) return 'exact';
  const ga = synonymGroup(ctx.settings, a);
  const gb = synonymGroup(ctx.settings, b);
  if (ga && ga === gb) return 'synonym';
  return 'none';
}

interface AttachCandidate {
  name: string;
  label?: string;
  source: 'pdf-title' | 'zip-file';
  prov?: Provenance;
  fileId: string;
}

function checkAttachments(report: ExtractedDoc, attachments: ExtractedDoc[], ctx: FlowContext): CheckUnit {
  const items: CheckItem[] = [];
  const refs: AttachmentRef[] = findAttachmentRefs(report.fullText);
  // 正式附件 PDF（檔名含「附件」且為合併檔）：每頁首行為章節標題
  const mergedAtt = attachments.filter((d) => /附件/.test(d.file.name) && (d.file.kind === 'pdf' || d.file.kind === 'txt'));
  const pdfTitles: AttachCandidate[] = [];
  for (const d of mergedAtt) {
    for (const p of d.pages) {
      const line = p.text.split('\n').map((x) => x.trim()).find((x) => x) ?? '';
      const m = /^(附件|附表|證物)\s*([一二三四五六七八九十\d]{1,3})\s*[:：、.]?\s*(.*)$/.exec(line.normalize('NFKC'));
      if (m) pdfTitles.push({ name: m[3] || line, label: m[1] + m[2], source: 'pdf-title', fileId: d.file.id, prov: provAt(d, p.page, 0, line) });
    }
  }
  const zipFiles: AttachCandidate[] = attachments
    .filter((d) => !mergedAtt.includes(d))
    .map((d) => ({ name: d.file.name, source: 'zip-file' as const, fileId: d.file.id, prov: { fileId: d.file.id, fileName: d.file.name, path: d.file.path, kind: d.file.kind, method: 'manual' as const, confidence: 1, raw: d.file.path } }));
  const usedPdf = new Set<AttachCandidate>();
  const usedZip = new Set<AttachCandidate>();

  if (!refs.length) items.push(item(ctx, 'D.attach', '附件引用', 'needs-review', 'medium', '陳報狀未辨識到「附件／附表／證物」引用，請人工確認'));
  for (const r of refs) {
    const seqN = seqToNumber(r.seq);
    // 依標號找正式附件 PDF 章節
    const labelParts = (l: string) => /^(附件|附表|證物|原證|附證)(.+)$/.exec(l);
    const byLabel = pdfTitles.filter((t) => {
      const m = t.label ? labelParts(t.label) : null;
      return !!m && m[1] === r.label.slice(0, 2) && seqToNumber(m[2]) === seqN;
    });
    const byName = pdfTitles.filter((t) => namesMatch(r.name, t.name, ctx) !== 'none');
    const inZip = zipFiles.filter((z) => namesMatch(r.name, z.name, ctx) !== 'none' || namesMatch(r.name, z.prov?.path ?? '', ctx) !== 'none');
    inZip.forEach((z) => usedZip.add(z));
    const refEv = ev('陳報狀', r.raw, `${r.label} ${r.name}${r.count ? `（${r.count}份）` : ''}`, provAt(report, report.pages.find((p) => p.text.normalize('NFKC').includes(r.raw))?.page ?? 1, 0, r.raw));
    if (byLabel.length) {
      byLabel.forEach((t) => usedPdf.add(t));
      const m = namesMatch(r.name, byLabel[0].name, ctx);
      const countOk = r.count === undefined || r.count === byLabel.length;
      if (m === 'none') items.push(item(ctx, 'D.attach', `${r.label} 名稱`, 'mismatch', 'high', '名稱不一致：附件 PDF 同標號章節名稱不同', { a: ev('附件 PDF', byLabel[0].name, byLabel[0].name, byLabel[0].prov), b: refEv }));
      else items.push(item(ctx, 'D.attach', `${r.label} 名稱`, 'match', 'high', m === 'synonym' ? `以同義詞對應（${synonymGroup(ctx.settings, cleanName(r.name))?.join('／')}），已收入正式附件 PDF` : '已收入正式附件 PDF', { a: ev('附件 PDF', byLabel[0].name, byLabel[0].name, byLabel[0].prov), b: refEv }));
      if (!countOk) items.push(item(ctx, 'D.attach', `${r.label} 份數`, 'mismatch', 'medium', `書狀記載 ${r.count} 份，附件 PDF 中找到 ${byLabel.length} 份`, { b: refEv }));
    } else if (byName.length) {
      byName.forEach((t) => usedPdf.add(t));
      items.push(item(ctx, 'D.attach', `${r.label} 標號`, 'mismatch', 'medium', `附件 PDF 中有同名文件但標號為 ${byName[0].label}`, { a: ev('附件 PDF', byName[0].label + ' ' + byName[0].name, byName[0].name, byName[0].prov), b: refEv }));
    } else if (inZip.length) {
      inZip.forEach((z) => usedZip.add(z));
      const countOk = r.count === undefined || r.count === inZip.length;
      items.push(
        item(ctx, 'D.attach', `${r.label} 收錄`, 'needs-review', 'high', `ZIP 中有相符檔案（${inZip.map((z) => z.prov?.path).join('、')}），但未見於正式附件 PDF；請確認實際送件版本。檔名相符不代表內容確實一致${countOk ? '' : `；份數 ${r.count}≠${inZip.length}`}`, { a: ev('ZIP 檔案', inZip[0].name, inZip[0].name, inZip[0].prov), b: refEv }),
      );
    } else {
      items.push(item(ctx, 'D.attach', `${r.label} 存在`, mergedAtt.length || zipFiles.length ? 'mismatch' : 'missing', 'high', '書狀提及但找不到此附件', { b: refEv }));
    }
  }
  for (const t of pdfTitles) if (!usedPdf.has(t)) items.push(item(ctx, 'D.attach', `${t.label ?? ''} 未被引用`, 'needs-review', 'medium', `附件 PDF 含「${t.label} ${t.name}」，但陳報狀未提及`, { a: ev('附件 PDF', t.name, t.name, t.prov) }));
  for (const z of zipFiles) if (!usedZip.has(z)) items.push(item(ctx, 'D.attach', '實際附上但未提及', 'needs-review', 'low', `ZIP 中的 ${z.prov?.path} 未被陳報狀引用`, { a: ev('ZIP 檔案', z.name, z.name, z.prov) }));
  return { id: `d:${report.file.id}:attachments`, label: '附件核對', subLabel: `書狀引用 ${refs.length} 項・附件 PDF 章節 ${pdfTitles.length}・其他檔案 ${zipFiles.length}`, docs: [{ role: 'civil-report', fileId: report.file.id }, ...attachments.map((a) => ({ role: 'attachment' as const, fileId: a.file.id }))], items };
}
