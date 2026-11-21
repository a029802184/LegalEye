// 流程 C：支付命令聲請狀批次核對（ZIP 內約 10–11 名債務人）。
// 每份聲請狀 = 一列；與「合併戶籍謄本中的個人資料」「數字檔名的欠費資料」以多項特徵配對。
// 不以檔案順序配對；衝突或低信心一律人工配對；缺件、重複、掃描失敗都列入待處理。

import { centsToString, findLabeledAmounts, type LabeledAmount } from '../core/amount';
import { compareAddress, compareNames, uid } from '../core/text';
import { compareIds, maskId, validateTwId } from '../core/idno';
import { debtorFields, findAddresses, findDebtorNames, findIds, findLabeledNames, findPhones, findSerials, labeledNameFields, type Hit } from '../core/extract';
import { findDates, fmtBoth, parseDate, sameDay, type YMD } from '../core/date';
import { detectInterestClause } from '../core/service';
import { RULESET_VERSION } from '../core/rules';
import type { BatchIssue, CheckItem, CheckUnit, Evidence, ExtractedDoc, FieldCorrection, FlowResult, Provenance } from '../core/types';
import { ev, item, petitionSections, provAt, type FlowContext } from './common';

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
}

/** 合併戶籍謄本 → 個人資料（保留頁碼；一頁可能有多位家屬，不會自動認定誰是債務人） */
export function personsFromHousehold(doc: ExtractedDoc): Person[] {
  const out: Person[] = [];
  for (const p of doc.pages) {
    const t = p.text.normalize('NFKC');
    const ids = findIds(t);
    const current = t.split(/(?:地址變更|戶址變更|遷徙記事|全戶動態記事|個人記事)/)[0];
    const addr = findAddresses(current).find((a) => /^(戶籍地址|戶籍地)/.test(a.raw));
    const labels = labeledNameFields(t);
    const groups = labels.map((m, i) => {
      const at = m.index;
      const end = labels[i + 1]?.index ?? t.length;
      const n = m.name;
      const candidates = ids.filter((id) => id.index >= at && id.index < end && id.index - at < 85 && !/(?:父|母|配偶|戶長)(?:親|姓名)?\s*[:：][^\n]*$/.test(t.slice(at, id.index)));
      return { n, id: candidates.length === 1 ? candidates[0] : undefined, at };
    });
    if (!labels.length) {
      const labeledIds = ids.filter((id) => /(?:身分證(?:統一)?(?:編號|字號)?|統一編號)\s*[:：]?\s*$/.test(t.slice(Math.max(0, id.index - 28), id.index))
        && !/(?:父|母|配偶|戶長)[^\n]*$/.test(t.slice(Math.max(0, id.index - 40), id.index)));
      const id = labeledIds.length === 1 ? labeledIds[0] : undefined;
      groups.push({ n: undefined, id, at: id?.index ?? 0 });
    }
    for (const { n, id, at } of groups) {
      out.push({
        key: `${doc.file.id}:${p.page}:${at}`,
        name: n?.value ?? '',
        id: id?.value,
        address: addr?.value,
        doc,
        page: p.page,
        prov: provAt(doc, p.page, n?.index ?? at, n?.raw ?? ''),
        idProv: id ? provAt(doc, p.page, id.index, id.raw) : undefined,
        addrProv: addr ? provAt(doc, p.page, addr.index, addr.raw) : undefined,
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
  key: string;
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

function readPetition(doc: ExtractedDoc, key: string): PetitionFacts {
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
  const party = debtorFields(t);
  return {
    key,
    doc,
    name: wrap(party.name),
    id: wrap(party.id),
    address: wrap(party.address),
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
    if (r === 'full' && validateTwId(p.id.value) && validateTwId(x.id)) {
      score += 0.6;
      why.push('身分證字號一致');
    } else if (r === 'partial') {
      score += 0.3;
      why.push('身分證可見部分一致');
    } else if (r === 'mismatch') return { score: 0, why: [] };
  }
  if (p.name && x.name) {
    const r = compareNames(p.name.value, x.name);
    if (r === 'exact' || r === 'alias') {
      score += 0.3;
      why.push('姓名一致');
    } else return { score: 0, why: [] };
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
  if (s.fileNumber && pt.match(/\d+/g)?.includes(s.fileNumber)) {
    score += 0.5;
    why.push(`聲請狀含檔名編號 ${s.fileNumber}`);
  }
  if (s.serials.some((x) => p.serials.includes(x))) {
    score += 0.5;
    why.push('客戶／申請編號一致');
  }
  if (p.name && s.names.length) {
    if (!s.names.some((n) => ['exact', 'alias'].includes(compareNames(n.value, p.name!.value)))) return { score: 0, why: [] };
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
  corrections?: Record<string, FieldCorrection>;
}

function householdEvidence(person: Person, petition: string, field: 'name' | 'id' | 'address', ctx: FlowCContext): Evidence {
  // Same household member across separate petitions is an independent correction target.
  const original = person[field] ?? '';
  const key = `${petition}:${person.key}:${field}`;
  const applied = ctx.corrections?.[key];
  const source = (field === 'address' ? person.addrProv : field === 'id' ? person.idProv : person.prov) ?? person.prov;
  return {
    ...ev('戶籍謄本', original, applied?.value ?? original, applied ? { ...source, method: 'manual', confidence: 1 } : source),
    correction: { key, field, original, applied },
  };
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
  const pets = petitions.flatMap((doc) => {
    const sections = petitionSections(doc);
    return sections.map((section, i) => readPetition(section, sections.length === 1 ? doc.file.id : `${doc.file.id}:${i}`));
  });

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
    const man = ctx.manualPairs?.[p.key];
    const ps = persons.map((x) => ({ x, ...scorePerson(p, x) })).sort((a, b) => b.score - a.score);
    const ss = statements.map((s) => ({ s, ...scoreStatement(p, s) })).sort((a, b) => b.score - a.score);
    let person = ps[0] && ps[0].score >= 0.39 ? ps[0] : undefined;
    let pAmb = !!person && ps.length > 1 && Math.abs(ps[0].score - ps[1].score) < 0.05;
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
    // 先記錄原本的自動候選。人工調整一份聲請狀不會改寫其他案件的結果。
    if (ps[0]?.score >= 0.39) personClaims.set(ps[0].x.key, [...(personClaims.get(ps[0].x.key) ?? []), p.key]);
    if (ss[0]?.score >= 0.5) stClaims.set(ss[0].s.doc.file.id, [...(stClaims.get(ss[0].s.doc.file.id) ?? []), p.key]);
    choice.set(p.key, { person: person?.x, pScore: person?.score ?? 0, pWhy: person?.why ?? [], pAmb, st: st?.s, sScore: st?.score ?? 0, sWhy: st?.why ?? [], sAmb });
  }

  const units: CheckUnit[] = [];
  for (const p of pets) {
    const c = choice.get(p.key)!;
    const manual = ctx.manualPairs?.[p.key];
    const pConflict = c.person && !manual?.person && (personClaims.get(c.person.key)?.length ?? 0) > 1;
    const sConflict = c.st && !manual?.statement && (stClaims.get(c.st.doc.file.id)?.length ?? 0) > 1;
    const person = c.pAmb || pConflict ? undefined : c.person;
    const statement = c.sAmb || sConflict ? undefined : c.st;
    const items: CheckItem[] = [];
    const evidence = [
      `聲請狀：${p.doc.file.path}${p.name?.prov.page ? ` 第 ${p.name.prov.page} 頁` : ''}`,
      person ? `戶籍：${person.doc.file.path} 第 ${person.page} 頁（${c.pWhy.join('、')}）` : '戶籍：尚未配對，請選擇對應文件',
      statement ? `帳務：${statement.doc.file.path}（${c.sWhy.join('、')}）` : '帳務：尚未配對，請選擇對應文件',
    ];
    if (pConflict) evidence.push('同一筆戶籍資料被多份聲請狀配對，需人工確認');
    if (sConflict) evidence.push('同一份帳務資料被多份聲請狀配對，需人工確認');
    if (c.pAmb) evidence.push('戶籍資料有多個相同分數的候選');
    if (c.sAmb) evidence.push('帳務資料有多個相同分數的候選');
    const needsManual = !person || !statement;
    const household = person ? {
      name: householdEvidence(person, p.key, 'name', ctx),
      id: householdEvidence(person, p.key, 'id', ctx),
      address: householdEvidence(person, p.key, 'address', ctx),
    } : undefined;
    const missingPerson = households.length ? '尚未確定這份戶籍資料對應哪位債務人，請確認配對' : '尚未附上戶籍謄本';
    const identityStatus = households.length ? 'needs-review' : 'missing';

    // 姓名
    if (!household) items.push(item(ctx, 'C.name', '姓名（戶籍）', identityStatus, 'high', missingPerson));
    else if (p.name && household.name.normalized) {
      const r = compareNames(household.name.normalized, p.name.value);
      items.push(
        item(ctx, 'C.name', '姓名（戶籍）', r === 'exact' || r === 'alias' ? 'match' : r === 'variant-suspect' ? 'needs-review' : 'mismatch', 'high', r === 'exact' ? '姓名一致' : r === 'alias' ? '以別名對應' : r === 'variant-suspect' ? '一字不同或疑似異體字（可能為 OCR 誤判），請看原頁' : '姓名不同', {
          a: household.name,
          b: ev('聲請狀', p.name.raw, p.name.value, p.name.prov),
        }),
      );
    } else items.push(item(ctx, 'C.name', '姓名（戶籍）', 'unreadable', 'high', !p.name ? '聲請狀中的債務人姓名尚未讀出' : '戶籍謄本有讀到文字，但姓名尚未抓出，請看原件', { a: household.name }));
    // 身分證
    if (household?.id.normalized && p.id) {
      const r = compareIds(household.id.normalized, p.id.value);
      const checksum = validateTwId(p.id.value);
      items.push(
        item(ctx, 'C.id', '身分證字號（戶籍）', r === 'full' ? (checksum ? 'match' : 'needs-review') : r === 'partial' ? 'partial' : r === 'mismatch' ? 'mismatch' : 'missing', 'high', r === 'full' ? (checksum ? '全碼一致，檢查碼正確（不代表確屬本人）' : '全碼一致但檢查碼不符，請確認原文') : r === 'partial' ? '遮罩，僅部分核對' : r === 'mismatch' ? '身分證字號不同' : '無法比對', {
          a: household.id,
          b: ev('聲請狀', maskId(p.id.value), maskId(p.id.value), p.id.prov),
        }),
      );
    } else items.push(item(ctx, 'C.id', '身分證字號（戶籍）', household ? 'unreadable' : identityStatus, 'high', household ? '身分證字號尚未讀出，請看原件' : missingPerson, { a: household?.id }));
    // 地址
    if (household?.address.normalized && p.address) {
      const r = compareAddress(household.address.normalized, p.address.value, household.address.prov?.method === 'ocr' || p.address.prov.method === 'ocr');
      items.push(
        item(ctx, 'C.address', '地址（戶籍）', r.equal ? 'match' : r.state === 'suspectedOcrError' ? 'needs-review' : 'mismatch', 'medium', r.detail, {
          a: household.address,
          b: ev('聲請狀', p.address.raw, p.address.value, p.address.prov),
        }),
      );
    } else items.push(item(ctx, 'C.address', '地址（戶籍）', household ? 'unreadable' : identityStatus, 'medium', household ? '住址尚未讀出，請看原件' : missingPerson, { a: household?.address }));
    c.st = statement;
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
      id: `petition:${p.key}`,
      pairKey: p.key,
      label: p.name?.value ?? '聲請狀中的債務人尚未辨識',
      subLabel: p.doc.file.path,
      docs: [
        { role: 'payment-order-petition', fileId: p.doc.file.id, pages: p.doc.pages.map((page) => page.page) },
        ...(person ? [{ role: 'household-register' as const, fileId: person.doc.file.id, pages: [person.page] }] : []),
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
