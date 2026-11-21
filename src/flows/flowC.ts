// 流程 C：支付命令聲請狀批次核對（ZIP 內約 10–11 名債務人）。
// 每份聲請狀 = 一列；與「合併戶籍謄本中的個人資料」「數字檔名的欠費資料」以多項特徵配對。
// 不以檔案順序配對；衝突或低信心一律人工配對；缺件、重複、掃描失敗都列入待處理。

import { centsToString, findLabeledAmounts, type LabeledAmount } from '../core/amount';
import { compareAddress, compareNames, uid } from '../core/text';
import { compareIds, maskId, validateTwId } from '../core/idno';
import { findAddresses, findDebtorNames, findIds, findLabeledNames, findPhones, findSerials, type Hit } from '../core/extract';
import { findDates, fmtBoth, parseDate, sameDay, type YMD } from '../core/date';
import { detectInterestClause } from '../core/service';
import { RULESET_VERSION } from '../core/rules';
import type { BatchIssue, CheckItem, CheckUnit, ExtractedDoc, FlowResult, Provenance } from '../core/types';
import { ev, item, provAt, type FlowContext } from './common';

export interface Person {
  key: string;
  name: string;
  id?: string;
  address?: string;
  doc: ExtractedDoc;
  page: number;
  prov: Provenance;
  idProv?: Provenance;
  addrProv?: Provenance;
  lowConfidence: boolean;
}

/** 合併戶籍謄本 → 個人資料（保留頁碼；一頁可能有多位家屬，不會自動認定誰是債務人） */
export function personsFromHousehold(doc: ExtractedDoc): Person[] {
  const out: Person[] = [];
  for (const p of doc.pages) {
    const t = p.text.normalize('NFKC');
    const ids = findIds(t);
    const names = findLabeledNames(t);
    const addr = findAddresses(t)[0];
    const low = p.method === 'ocr' && p.confidence < 0.6;
    if (!ids.length && names.length) {
      for (const n of names) out.push({ key: uid('p'), name: n.value, doc, page: p.page, prov: provAt(doc, p.page, n.index, n.raw), address: addr?.value, addrProv: addr ? provAt(doc, p.page, addr.index, addr.raw) : undefined, lowConfidence: low });
      continue;
    }
    for (const id of ids) {
      // 身分證字號前方最近的「姓名」
      const n = [...names].reverse().find((x) => x.index < id.index && id.index - x.index < 80) ?? names.find((x) => x.index > id.index && x.index - id.index < 40);
      out.push({
        key: uid('p'),
        name: n?.value ?? '',
        id: id.value,
        address: addr?.value,
        doc,
        page: p.page,
        prov: provAt(doc, p.page, n?.index ?? id.index, n?.raw ?? id.raw),
        idProv: provAt(doc, p.page, id.index, id.raw),
        addrProv: addr ? provAt(doc, p.page, addr.index, addr.raw) : undefined,
        lowConfidence: low,
      });
    }
  }
  return out;
}

export interface Statement {
  doc: ExtractedDoc;
  fileNumber?: string;
  names: Hit[];
  phones: string[];
  serials: string[];
  balance?: LabeledAmount & { prov: Provenance };
  currentBill?: LabeledAmount;
  paid: LabeledAmount[];
  baseDate?: { value: YMD; raw: string; prov: Provenance };
}

export function readStatement(doc: ExtractedDoc): Statement {
  const t = doc.fullText.normalize('NFKC');
  const am = findLabeledAmounts(t);
  // 明確標示的「總欠費／未償債務額」優先；不以「本期應繳」當作全部未償本金
  const balRe = /總欠費|未償債務|欠費總額|未清償總額|應繳總額|累計欠費/;
  const bal = am.find((a) => balRe.test(t.slice(Math.max(0, a.index - 14), a.index)));
  const bd = findDates(t).find((d) => d.valid && /(計算至|截至|基準日|結算日|統計至)[^\n]{0,6}$/.test(t.slice(Math.max(0, d.index - 10), d.index)));
  const page = doc.pages.find((p) => bal && p.text.normalize('NFKC').includes(bal.raw))?.page ?? 1;
  return {
    doc,
    fileNumber: /^(\d{4,})/.exec(doc.file.name)?.[1],
    names: [...findDebtorNames(t), ...findLabeledNames(t), ...[...t.matchAll(/(?:用戶|客戶)(?:名稱|姓名)\s*[:：]?\s*([一-鿿]{2,4})/g)].map((m) => ({ value: m[1], raw: m[0], index: m.index ?? 0 }))],
    phones: findPhones(t).map((p) => p.value),
    serials: findSerials(t).map((s) => s.value),
    balance: bal ? { ...bal, prov: provAt(doc, page, doc.pages.find((p) => p.page === page)?.text.normalize('NFKC').indexOf(bal.raw) ?? 0, bal.raw) } : undefined,
    currentBill: am.find((a) => a.kind === 'current-bill'),
    paid: am.filter((a) => a.kind === 'paid'),
    baseDate: bd ? { value: bd.value, raw: bd.raw, prov: provAt(doc, 1, bd.index, bd.raw) } : undefined,
  };
}

interface PetitionFacts {
  doc: ExtractedDoc;
  name?: Hit & { prov: Provenance };
  id?: Hit & { prov: Provenance };
  address?: Hit & { prov: Provenance };
  serials: string[];
  phones: string[];
  amounts: LabeledAmount[];
  principal?: LabeledAmount;
  baseDate?: { value: YMD; raw: string };
  clauseRaw: string;
  clauseType: string;
}

function readPetition(doc: ExtractedDoc): PetitionFacts {
  const t = doc.fullText.normalize('NFKC');
  const wrap = <T extends { index: number; raw: string }>(h: T | undefined) => {
    if (!h) return undefined;
    const page = doc.pages.find((p) => p.text.normalize('NFKC').includes(h.raw))?.page ?? 1;
    const idx = doc.pages.find((p) => p.page === page)?.text.normalize('NFKC').indexOf(h.raw) ?? h.index;
    return { ...h, prov: provAt(doc, page, idx, h.raw) };
  };
  const am = findLabeledAmounts(t);
  const bd = findDates(t).find((d) => d.valid && /(計算至|截至|基準日|結算日)[^\n]{0,6}$/.test(t.slice(Math.max(0, d.index - 10), d.index)));
  const clause = detectInterestClause(t, parseDate);
  return {
    doc,
    name: wrap(findDebtorNames(t)[0]),
    id: wrap(findIds(t)[0]),
    address: wrap(findAddresses(t)[0]),
    serials: findSerials(t).map((s) => s.value),
    phones: findPhones(t).map((p) => p.value),
    amounts: am,
    principal: am.find((a) => a.kind === 'principal') ?? am.find((a) => a.kind === 'balance'),
    baseDate: bd ? { value: bd.value, raw: bd.raw } : undefined,
    clauseRaw: clause.raw,
    clauseType: clause.clause.type,
  };
}

function scorePerson(p: PetitionFacts, x: Person): { score: number; why: string[] } {
  let score = 0;
  const why: string[] = [];
  if (p.id && x.id) {
    const r = compareIds(p.id.value, x.id);
    if (r === 'full') {
      score += 0.6;
      why.push('身分證字號一致');
    } else if (r === 'partial') {
      score += 0.3;
      why.push('身分證可見部分一致');
    } else if (r === 'mismatch') score -= 0.3;
  }
  if (p.name && x.name) {
    const r = compareNames(p.name.value, x.name);
    if (r === 'exact' || r === 'alias') {
      score += 0.3;
      why.push('姓名一致');
    } else if (r === 'variant-suspect') {
      score += 0.1;
      why.push('姓名近似');
    }
  }
  if (p.address && x.address && compareAddress(p.address.value, x.address).equal) {
    score += 0.1;
    why.push('地址一致');
  }
  return { score, why };
}

function scoreStatement(p: PetitionFacts, s: Statement): { score: number; why: string[] } {
  let score = 0;
  const why: string[] = [];
  const pt = p.doc.fullText.normalize('NFKC');
  if (s.fileNumber && pt.includes(s.fileNumber)) {
    score += 0.5;
    why.push(`聲請狀含檔名編號 ${s.fileNumber}`);
  }
  if (s.serials.some((x) => p.serials.includes(x))) {
    score += 0.5;
    why.push('客戶／申請編號一致');
  }
  if (p.name && s.names.some((n) => compareNames(n.value, p.name!.value) === 'exact')) {
    score += 0.3;
    why.push('姓名一致');
  }
  if (s.phones.some((x) => p.phones.includes(x))) {
    score += 0.2;
    why.push('門號一致');
  }
  return { score, why };
}

export interface FlowCContext extends FlowContext {
  /** 人工配對：聲請狀 fileId → { personKey?, statementFileId? } */
  manualPairs?: Record<string, { person?: string; statement?: string }>;
}

export interface FlowCExtra {
  persons: Person[];
  statements: Statement[];
}

export function runFlowC(docs: ExtractedDoc[], ctx: FlowCContext): FlowResult & { extra: FlowCExtra } {
  const issues: BatchIssue[] = [];
  const notDone: string[] = [];
  const petitions = docs.filter((d) => d.role === 'payment-order-petition');
  const households = docs.filter((d) => d.role === 'household-register');
  const stDocs = docs.filter((d) => d.role === 'debt-statement');
  const unknown = docs.filter((d) => d.role === 'unknown');

  for (const d of docs) {
    if (d.status === 'needs-ocr' || d.status === 'error') {
      issues.push({ id: uid('i'), level: 'error', message: `${d.file.path}：${d.warnings.join('；') || '無法讀取'}（掃描或解析失敗）`, fileId: d.file.id });
      notDone.push(`${d.file.path} 未取得文字`);
    } else if (d.pages.some((p) => p.ocrFailed)) {
      issues.push({ id: uid('i'), level: 'warning', message: `${d.file.path}：第 ${d.pages.filter((p) => p.ocrFailed).map((p) => p.page).join('、')} 頁 OCR 辨識失敗或信心過低`, fileId: d.file.id });
    }
  }
  for (const d of unknown) issues.push({ id: uid('i'), level: 'warning', message: `無法判斷文件角色：${d.file.path}，請在檔案清單手動指定`, fileId: d.file.id });
  if (!petitions.length) issues.push({ id: uid('i'), level: 'error', message: '找不到支付命令聲請狀' });
  if (!households.length) issues.push({ id: uid('i'), level: 'error', message: '找不到戶籍謄本，姓名／身分證／地址無法核對' });
  if (!stDocs.length) issues.push({ id: uid('i'), level: 'error', message: '找不到欠費明細／帳單，金額無法核對' });

  const persons = households.flatMap(personsFromHousehold);
  const statements = stDocs.map(readStatement);
  const pets = petitions.map(readPetition);

  const hhPages = households.reduce((n, d) => n + d.pages.length, 0);
  if (households.length && hhPages !== petitions.length) {
    issues.push({ id: uid('i'), level: 'warning', message: `戶籍謄本共 ${hhPages} 頁，聲請狀 ${petitions.length} 份，頁數與人數不同（可能有漏件、多頁或家屬頁），請人工確認` });
  }
  // 重複人名
  const nameCount = new Map<string, number>();
  for (const p of pets) if (p.name) nameCount.set(p.name.value, (nameCount.get(p.name.value) ?? 0) + 1);
  for (const [n, c] of nameCount) if (c > 1) issues.push({ id: uid('i'), level: 'warning', message: `有 ${c} 份聲請狀的債務人同名「${n}」，配對須以身分證字號／編號確認` });

  // 配對
  const personClaims = new Map<string, string[]>();
  const stClaims = new Map<string, string[]>();
  const choice = new Map<string, { person?: Person; pScore: number; pWhy: string[]; pAmb: boolean; st?: Statement; sScore: number; sWhy: string[]; sAmb: boolean }>();
  for (const p of pets) {
    const man = ctx.manualPairs?.[p.doc.file.id];
    const ps = persons.map((x) => ({ x, ...scorePerson(p, x) })).sort((a, b) => b.score - a.score);
    const ss = statements.map((s) => ({ s, ...scoreStatement(p, s) })).sort((a, b) => b.score - a.score);
    let person = ps[0] && ps[0].score >= 0.3 ? ps[0] : undefined;
    let pAmb = !!person && ps.length > 1 && Math.abs(ps[0].score - ps[1].score) < 0.05 && ps[1].score >= 0.3;
    if (man?.person) {
      const mp = persons.find((x) => x.key === man.person);
      person = mp ? { x: mp, score: 1, why: ['人工配對'] } : undefined;
      pAmb = false;
    }
    let st = ss[0] && ss[0].score >= 0.5 ? ss[0] : undefined;
    let sAmb = !!st && ss.length > 1 && Math.abs(ss[0].score - ss[1].score) < 0.05 && ss[1].score >= 0.5;
    if (man?.statement) {
      const ms = statements.find((s) => s.doc.file.id === man.statement);
      st = ms ? { s: ms, score: 1, why: ['人工配對'] } : undefined;
      sAmb = false;
    }
    if (person) personClaims.set(person.x.key, [...(personClaims.get(person.x.key) ?? []), p.doc.file.id]);
    if (st) stClaims.set(st.s.doc.file.id, [...(stClaims.get(st.s.doc.file.id) ?? []), p.doc.file.id]);
    choice.set(p.doc.file.id, { person: person?.x, pScore: person?.score ?? 0, pWhy: person?.why ?? [], pAmb, st: st?.s, sScore: st?.score ?? 0, sWhy: st?.why ?? [], sAmb });
  }

  const units: CheckUnit[] = [];
  for (const p of pets) {
    const c = choice.get(p.doc.file.id)!;
    const pConflict = c.person ? (personClaims.get(c.person.key)?.length ?? 0) > 1 : false;
    const sConflict = c.st ? (stClaims.get(c.st.doc.file.id)?.length ?? 0) > 1 : false;
    const items: CheckItem[] = [];
    const evidence = [
      c.person ? `戶籍：${c.person.doc.file.path} 第 ${c.person.page} 頁（${c.pWhy.join('、')}；分數 ${c.pScore.toFixed(2)}）` : '戶籍：未配對',
      c.st ? `帳務：${c.st.doc.file.path}（${c.sWhy.join('、')}；分數 ${c.sScore.toFixed(2)}）` : '帳務：未配對',
    ];
    if (pConflict) evidence.push('同一筆戶籍資料被多份聲請狀配對，需人工確認');
    if (sConflict) evidence.push('同一份帳務資料被多份聲請狀配對，需人工確認');
    if (c.pAmb) evidence.push('戶籍資料有多個相同分數的候選');
    if (c.sAmb) evidence.push('帳務資料有多個相同分數的候選');
    const needsManual = !c.person || !c.st || pConflict || sConflict || c.pAmb || c.sAmb || c.pScore < 0.6 || c.sScore < 0.5;

    // 姓名
    if (!c.person) items.push(item(ctx, 'C.name', '姓名（戶籍）', 'missing', 'high', '戶籍謄本中找不到對應的人（缺件或需人工配對）'));
    else if (p.name) {
      const r = compareNames(c.person.name, p.name.value);
      items.push(
        item(ctx, 'C.name', '姓名（戶籍）', r === 'exact' || r === 'alias' ? 'match' : r === 'variant-suspect' ? 'needs-review' : 'mismatch', 'high', r === 'exact' ? '姓名一致' : r === 'alias' ? '以別名對應' : r === 'variant-suspect' ? '一字不同或疑似異體字（可能為 OCR 誤判），請看原頁' : '姓名不同', {
          a: ev('戶籍謄本', c.person.name, c.person.name, c.person.prov),
          b: ev('聲請狀', p.name.raw, p.name.value, p.name.prov),
        }),
      );
    } else items.push(item(ctx, 'C.name', '姓名（戶籍）', 'missing', 'high', '聲請狀未辨識到債務人姓名'));
    // 身分證
    if (c.person?.id && p.id) {
      const r = compareIds(c.person.id, p.id.value);
      const checksum = validateTwId(p.id.value);
      items.push(
        item(ctx, 'C.id', '身分證字號（戶籍）', r === 'full' ? (checksum ? 'match' : 'needs-review') : r === 'partial' ? 'partial' : r === 'mismatch' ? 'mismatch' : 'missing', 'high', r === 'full' ? (checksum ? '全碼一致，檢查碼正確（不代表確屬本人）' : '全碼一致但檢查碼不符，請確認原文') : r === 'partial' ? '遮罩，僅部分核對' : r === 'mismatch' ? '身分證字號不同' : '無法比對', {
          a: ev('戶籍謄本', maskId(c.person.id), maskId(c.person.id), c.person.idProv),
          b: ev('聲請狀', maskId(p.id.value), maskId(p.id.value), p.id.prov),
        }),
      );
    } else items.push(item(ctx, 'C.id', '身分證字號（戶籍）', 'missing', 'high', !p.id ? '聲請狀未辨識到身分證字號' : '戶籍資料未取得身分證字號'));
    // 地址
    if (c.person?.address && p.address) {
      const r = compareAddress(c.person.address, p.address.value);
      items.push(
        item(ctx, 'C.address', '地址（戶籍）', r.equal ? 'match' : 'mismatch', 'medium', r.equal ? '地址一致（已正規化全半形、空白、郵遞區號、臺台）' : `地址自第 ${(r.diffAt ?? 0) + 1} 字起不同；門牌、樓層、里鄰不同不視為相同`, {
          a: ev('戶籍謄本', c.person.address, c.person.address, c.person.addrProv),
          b: ev('聲請狀', p.address.raw, p.address.value, p.address.prov),
        }),
      );
    } else items.push(item(ctx, 'C.address', '地址（戶籍）', 'missing', 'medium', !p.address ? '聲請狀未辨識到地址' : '戶籍資料未取得地址'));
    // 金額：聲請本金 vs 總欠費
    if (!c.st) items.push(item(ctx, 'C.amount', '聲請本金與欠費', 'missing', 'high', '沒有配對到帳務資料'));
    else if (!c.st.balance) {
      items.push(item(ctx, 'C.amount', '聲請本金與欠費', 'missing', 'high', c.st.currentBill ? '帳務資料只有「本期應繳」，未明確標示總欠費／未償債務額；不以本期應繳當作未償本金' : '帳務資料未辨識到總欠費／未償債務額'));
    } else if (!p.principal) items.push(item(ctx, 'C.amount', '聲請本金與欠費', 'missing', 'high', '聲請狀未辨識到請求金額'));
    else {
      const same = p.principal.cents === c.st.balance.cents;
      const dateDiff = p.baseDate && c.st.baseDate && !sameDay(p.baseDate.value, c.st.baseDate.value);
      const unclear = c.st.paid.length > 0 || dateDiff || !c.st.baseDate || !p.baseDate;
      items.push(
        item(ctx, 'C.amount', '聲請本金與欠費', same ? 'match' : unclear ? 'needs-review' : 'mismatch', 'high', same ? '聲請本金與總欠費一致' : unclear ? `金額待釐清：可能有已繳款、沖抵或計算截止日不同${c.st.paid.length ? `（帳務記載已繳 ${c.st.paid.map((x) => centsToString(x.cents)).join('、')}）` : ''}` : '聲請本金與總欠費不同（截止日相同、無已繳紀錄）', {
          a: ev('帳務資料', c.st.balance.raw, centsToString(c.st.balance.cents), c.st.balance.prov),
          b: ev('聲請狀', p.principal.raw, centsToString(p.principal.cents)),
        }),
      );
    }
    // 內文金額一致性
    const keyAmts = p.amounts.filter((a) => a.kind === 'principal' || a.kind === 'balance');
    if (keyAmts.length >= 2) {
      const vals = [...new Set(keyAmts.map((a) => a.cents.toString()))];
      items.push(item(ctx, 'C.internal', '聲請狀內文金額', vals.length === 1 ? 'match' : 'mismatch', 'high', vals.length === 1 ? `聲請狀 ${keyAmts.length} 處本金記載一致` : `聲請狀本金記載不一致：${keyAmts.map((a) => a.raw).join('、')}`));
    }
    // 基準日
    if (p.baseDate && c.st?.baseDate) {
      const same = sameDay(p.baseDate.value, c.st.baseDate.value);
      items.push(item(ctx, 'C.basedate', '資料基準日', same ? 'match' : 'needs-review', 'medium', same ? '計算基準日一致' : '基準日不同，金額差異可能來自計算期間不同', { a: ev('帳務資料', c.st.baseDate.raw, fmtBoth(c.st.baseDate.value), c.st.baseDate.prov), b: ev('聲請狀', p.baseDate.raw, fmtBoth(p.baseDate.value)) }));
    } else items.push(item(ctx, 'C.basedate', '資料基準日', 'missing', 'low', '聲請狀或帳務資料未載明計算基準日'));
    // 利息：聲請階段為條件式請求
    if (p.clauseType === 'after-service') {
      items.push(item(ctx, 'C.basedate', '利息起算', 'not-applicable', 'info', `聲請狀記載「${p.clauseRaw}」，支付命令尚未送達，屬條件式請求，不計算日曆日期也不判錯`));
    }
    units.push({
      id: uid('u'),
      label: p.name?.value ?? p.doc.file.name,
      subLabel: p.doc.file.path,
      docs: [
        { role: 'payment-order-petition', fileId: p.doc.file.id },
        ...(c.person ? [{ role: 'household-register' as const, fileId: c.person.doc.file.id, pages: [c.person.page] }] : []),
        ...(c.st ? [{ role: 'debt-statement' as const, fileId: c.st.doc.file.id }] : []),
      ],
      items,
      match: { score: Math.min(c.pScore, c.sScore), evidence, needsManual },
    });
  }
  // 未被使用的帳務資料
  for (const s of statements) {
    if (!stClaims.has(s.doc.file.id)) issues.push({ id: uid('i'), level: 'warning', message: `帳務資料 ${s.doc.file.path}${s.fileNumber ? `（編號 ${s.fileNumber}）` : ''} 無法配對到任何聲請狀`, fileId: s.doc.file.id });
  }
  const unmatchedPersons = persons.filter((x) => !personClaims.has(x.key));
  if (unmatchedPersons.length && persons.length) {
    issues.push({ id: uid('i'), level: 'info', message: `戶籍謄本中有 ${unmatchedPersons.length} 筆個人資料未配對到聲請狀（可能為同戶家屬，系統不會將其視為債務人）` });
  }
  return { flow: 'C', units, batchIssues: issues, notDone, ruleVersion: RULESET_VERSION, createdAt: new Date().toISOString(), extra: { persons, statements } };
}
