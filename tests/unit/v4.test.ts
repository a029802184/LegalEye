import { describe, expect, it } from 'vitest';
import { debtorFields, findAddresses, findLabeledNames } from '../../src/core/extract';
import { DEFAULT_SETTINGS as settings } from '../../src/core/rules';
import type { ChromePageText, DocRole, ExtractedDoc, ExtractMethod } from '../../src/core/types';
import { runFlow } from '../../src/flows';
import { validChromeText } from '../../src/flows/chromeText';
import { personsFromHousehold } from '../../src/flows/flowC';
import { gainsHouseholdFields } from '../../src/core/scanFields';
import { buildHtmlReport } from '../../src/report/report';
import { fakeId } from '../fixtures/builders';

function doc(id: string, role: DocRole, text: string[], method: ExtractMethod = 'pdf-text'): ExtractedDoc {
  const name = `${id}.pdf`;
  return { file: { id, name, path: name, kind: 'pdf', size: 0, sha256: '', data: new Uint8Array() }, role, roleCandidates: [], warnings: [],
    status: text.some(Boolean) ? 'ok' : 'needs-ocr', fullText: text.join('\n'), pages: text.map((value, index) => ({
      page: index + 1, text: value, method, confidence: method === 'ocr' ? 0.8 : 1, needsOcr: !value,
    })) };
}

const address = (lane: number, door = 3) => `新北市甲區甲里20鄰甲路${lane}巷${door}號`;
const household = (name: string, id: string, addr: string) => `戶籍謄本\n姓名：${name}國民身分證統一編號：${id}\n戶籍地址：${addr}`;
const debtor = (name: string, id: string, addr: string) => `債務人：${name}\n國民身分證統一編號：${id}\n住所：${addr}`;
const id = fakeId('Y', '10000001');

describe('V4 欄界與人員區塊', () => {
  it('跨行、空格、國民與身分證異體字不污染人名，分隔的證號只接受完整格式', () => {
    const spaced = id.split('').join(' ');
    const terms = `姓名：\n 林 甲 國 民\n身 份 証 統 一 編 號：${spaced}`;
    expect(findLabeledNames(terms).map((entry) => entry.value)).toEqual(['林甲']);
    expect(findLabeledNames('姓名：林甲國 民\n戶籍地址：新北市甲區甲路3號')[0]?.value).toBe('林甲');
    expect(personsFromHousehold(doc('house', 'household-register', [terms]))[0]).toMatchObject({ name: '林甲', id });
    expect(debtorFields(`債務人：林甲國民身分證統一編號：${id}`).name?.value).toBe('林甲');
    expect(debtorFields(`債務人：林甲（原名陳乙）\n國民身分證統一編號：${id}`).name?.value).toBe('林甲原名陳乙');
  });

  it('保留換行地址、附號與樓層，後續人物及舊址保持隔離', () => {
    const wrapped = '241 新北市甲區甲里二十鄰甲路\n 九十八巷3之1號五樓2室';
    const second = address(89, 27);
    const both = `${household('林甲', id, wrapped)}\n父親姓名：黃測試\n${household('陳乙', fakeId('Y', '10000002'), second)}\n地址變更：戶籍地址：${address(85)}`;
    expect(findAddresses(both)[0].value).toBe(wrapped);
    expect(personsFromHousehold(doc('house', 'household-register', [both])).map((person) => [person.name, person.address])).toEqual([
      ['林甲', wrapped], ['陳乙', second],
    ]);
    expect(debtorFields(`債務人：林甲\n法定代理人：陳測試\n身分證字號：${id}\n住址：${second}`).address).toBeUndefined();
    const header = (name: string, code: string, place: string) => `戶籍謄本\n戶籍地址：${place}\n姓名：${name}國民身分證統一編號：${code}`;
    const twoHeaded = `${header('林甲', id, wrapped)}\n${header('陳乙', fakeId('Y', '10000002'), second)}`;
    expect(personsFromHousehold(doc('two', 'household-register', [twoHeaded])).map((p) => p.address)).toEqual([wrapped, second]);
  });

  it('加強讀取只在同人且已讀出的欄位均一致時採用補充結果', () => {
    const raw = household('林甲', id, '').trim();
    expect(gainsHouseholdFields(raw, household('林甲', id, address(98)))).toBe(true);
    expect(gainsHouseholdFields(raw, household('陳乙', id, address(98)))).toBe(false);
    expect(gainsHouseholdFields(household('林甲', id, address(93)), household('林甲', id, address(98)))).toBe(false);
  });
});

describe('V4 來源與案件隔離', () => {
  const people = Array.from('甲乙丙丁戊己庚辛壬癸子', (n, i) => ({ name: `林測${n}`, id: fakeId('Y', `1${String(i + 1).padStart(7, '0')}`), door: i + 1 }));
  const petitions = people.map((p, i) => doc(`pet${i}`, 'payment-order-petition', [`支付命令聲請狀\n案件編號：700100${i + 10}\n${debtor(p.name, p.id, address(98, p.door))}\n請求本金新臺幣${14876 + i}元` ]));
  const statements = people.map((p, i) => doc(`700100${i + 10}`, 'debt-statement', [`欠費明細\n客戶編號：700100${i + 10}\n用戶姓名：${p.name}\n總欠費新臺幣${14876 + i}元` ]));
  const hh = doc('戶籍', 'household-register', people.map((p, i) => household(p.name, p.id, address(i === 5 ? 93 : 98, p.door))), 'ocr');

  it('只重算第六人的選定頁，保留 93／98 兩種證據與人工更正', () => {
    const docs = [...petitions, ...statements, hh];
    const before = runFlow('C', docs, { settings });
    const sixth = before.units[5];
    const pasted = `戶籍地址：241 ${address(98, 6).replace('20鄰', '020鄰')}`;
    const entry: ChromePageText = { unitId: sixth.id, fileId: hh.file.id, page: 6, role: 'household-register', text: pasted };
    const after = runFlow('C', docs, { settings, chromePages: [entry] });
    expect(after.units.map((unit) => unit.label)).toEqual(people.map((person) => person.name));
    const snapshot = (units: typeof before.units) => units.filter((_, i) => i !== 5).map((u) => [u.id, u.docs, u.items.map(({ id: _, ...row }) => row)]);
    expect(snapshot(after.units)).toEqual(snapshot(before.units));
    const a = after.units[5].items.find((item) => item.field === '地址（戶籍）')!;
    expect(a.status).toBe('needs-review');
    expect(a.a?.normalized).toBe(address(93, 6));
    expect(a.a?.candidates).toMatchObject([
      { value: address(93, 6), prov: { fileId: '戶籍', method: 'ocr', page: 6 } },
      { value: expect.stringContaining('98巷'), prov: { fileId: '戶籍', method: 'chrome-pasted', page: 6 } },
    ]);
    expect(after.units[5].items.find((item) => item.field === '聲請本金與欠費')?.status).toBe('match');
    const key = a.a!.correction!.key;
    const confirmed = runFlow('C', docs, { settings, chromePages: [entry], corrections: { [key]: { value: address(98, 6), by: '覆核員', at: '2026-11-22' } } });
    expect(confirmed.units[5].items.find((item) => item.field === a.field)).toMatchObject({ status: 'match', a: { normalized: address(98, 6), prov: { method: 'manual' } } });
    expect(hh.pages[5].text).toContain('93巷');
  });

  it('空白掃描可補入正確頁面，缺少頁碼或單獨片段不當成正本確認', () => {
    const source = doc('blank', 'household-register', ['', '']);
    const docs = [petitions[0], source];
    const baseline = runFlow('C', docs, { settings });
    const entry: ChromePageText = { unitId: baseline.units[0].id, fileId: 'blank', page: 2, role: 'household-register',
      text: household(people[0].name, people[0].id, address(98, 1)) };
    const result = runFlow('C', docs, { settings, chromePages: [entry] });
    expect(result.units[0].items.find((i) => i.field === '姓名（戶籍）')).toMatchObject({ status: 'needs-review', a: { normalized: people[0].name, prov: { page: 2, method: 'chrome-pasted' } } });
    expect(result.units[0].match?.needsManual).toBe(true);
    expect(result.units[0].chromeSources).toMatchObject([{ page: 2, used: true }]);
    const identity = result.units[0].items.find((i) => i.field === '身分證字號（戶籍）')!;
    const confirmed = runFlow('C', docs, { settings, chromePages: [entry], corrections: {
      [identity.a!.correction!.key]: { value: people[0].id, by: '覆核員', at: '2026-11-22' },
    } });
    expect(confirmed.units[0].items.find((i) => i.field === identity.field)?.status).toBe('match');
    const report = buildHtmlReport(result, docs, { mask: true, batchName: '合成測試' });
    expect(report).toContain('由使用者從 Chrome PDF 貼入');
    expect(report).not.toContain(people[0].id);
    const invalid = [{ ...entry, page: 0 }, { ...entry, page: 3 }, { ...entry, unitId: 'other' }];
    expect(runFlow('C', docs, { settings, chromePages: invalid }).units[0].items.some((i) => i.a?.candidates)).toBe(false);
    expect(validChromeText('第1頁\f第2頁')).toBe(false);
  });

  it('多人同頁的無名片段或不符本案頁碼的文字不應與任何人共用', () => {
    const page = people.slice(0, 2).map((p) => household(p.name, p.id, address(98, p.door))).join('\n');
    const source = doc('two', 'household-register', [page, '']);
    const docs = [petitions[0], petitions[1], source];
    const baseline = runFlow('C', docs, { settings });
    const entry: ChromePageText = { unitId: baseline.units[0].id, fileId: 'two', page: 1, role: 'household-register', text: `戶籍地址：${address(93)}` };
    const result = runFlow('C', docs, { settings, chromePages: [entry, { ...entry, page: 2 }] });
    expect(result.units[0].chromeSources).toMatchObject([{ used: false }, { used: false }]);
    expect(result.units[1].chromeSources).toBeUndefined();
    expect(result.units[0].items.find((item) => item.field === '地址（戶籍）')).toMatchObject({ status: 'match', a: { normalized: address(98, 1) } });
  });

  it('藍底查稅文字維持第三人角色；未看原件時保留待確認', () => {
    const key = '臺灣臺北地方法院114年度司促字第47號';
    const petition = doc('b-pet', 'enforcement-petition', [`民事強制執行聲請狀\n${debtor('林甲', id, address(98))}\n第 三 人：甲測試有限公司\n法定代理人：陳測乙\n執行名義：${key}`]);
    const order = doc('b-order', 'payment-order', [`${key}\n支付命令\n${debtor('林甲', id, address(98))}`]);
    const tax = doc('b-tax', 'tax-record', ['']);
    const docs = [petition, order, tax];
    const before = runFlow('B', docs, { settings });
    const entry: ChromePageText = { unitId: before.units[0].id, fileId: tax.file.id, page: 1, role: 'tax-record', text: `國稅局查稅資料\n${key}\n第三人：甲測試有限公司\n第三人法定代理人：陳測乙` };
    const result = runFlow('B', docs, { settings, chromePages: [entry] });
    expect(result.units[0].label).toBe('林甲');
    expect(result.units[0].items.find((i) => i.field === '第三人法定代理人')).toMatchObject({ status: 'needs-review', a: { normalized: '陳測乙', prov: { method: 'chrome-pasted', fileId: tax.file.id } } });
  });

  it('通知函與陳報狀沿用原規則逐頁核對，未讀到的來源姓名可貼入', () => {
    const court = '臺灣臺北地方法院';
    const aText = `${court}執行命令\n114年度司執字第52號\n債務人：林甲`;
    const letter = doc('a-letter', 'notice-letter', [aText]);
    const order = doc('a-order', 'court-notice', ['']);
    const aDocs = [letter, order];
    const a = runFlow('A', aDocs, { settings }).units[0];
    const aPaste: ChromePageText = { unitId: a.id, fileId: order.file.id, page: 1, role: 'court-notice', text: aText };
    const aResult = runFlow('A', aDocs, { settings, chromePages: [aPaste] }).units[0];
    expect(aResult.items.find((i) => i.field === '債務人姓名')).toMatchObject({ status: 'needs-review', a: { normalized: '林甲', prov: { page: 1 } } });

    const dText = `${court}民事庭函\n114年度北簡字第87號\n債務人：林甲`;
    const report = doc('d-report', 'civil-report', [dText]);
    const courtLetter = doc('d-letter', 'court-letter', ['']);
    const dDocs = [report, courtLetter];
    const d = runFlow('D', dDocs, { settings }).units.find((u) => u.label === '案件資訊')!;
    const dPaste: ChromePageText = { unitId: d.id, fileId: courtLetter.file.id, page: 1, role: 'court-letter', text: dText };
    const dResult = runFlow('D', dDocs, { settings, chromePages: [dPaste] }).units.find((u) => u.id === d.id)!;
    expect(dResult.items.find((i) => i.field === '債務人姓名')).toMatchObject({ status: 'needs-review', a: { normalized: '林甲', prov: { page: 1 } } });
  });
});
