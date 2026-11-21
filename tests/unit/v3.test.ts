import { describe, expect, it } from 'vitest';
import { debtorFields, findLabeledNames } from '../../src/core/extract';
import { compareAddress } from '../../src/core/text';
import { DEFAULT_SETTINGS as settings } from '../../src/core/rules';
import type { DocRole, ExtractedDoc, PageText } from '../../src/core/types';
import { personsFromHousehold, runFlowC } from '../../src/flows/flowC';
import { runFlowB } from '../../src/flows/flowB';
import { provAt } from '../../src/flows/common';
import { buildCsvReport, buildHtmlReport } from '../../src/report/report';
import { fakeId } from '../fixtures/builders';

function document(id: string, role: DocRole, body: string[], scan = false): ExtractedDoc {
  const pages: PageText[] = body.map((text, i) => ({ page: i + 1, text, method: scan ? 'ocr' : 'pdf-text', confidence: scan ? 0.77 : 1 }));
  const name = `${id}.pdf`;
  return { file: { id, path: name, name, kind: 'pdf', data: new Uint8Array(), size: 0, sha256: '' }, status: 'ok', warnings: [], pages, fullText: body.join('\n'), role, roleCandidates: [] };
}
const address = '新北市甲區甲里20鄰甲路98巷3號5樓';
const idA = fakeId('Y', '10000001');
const idB = fakeId('Y', '10000002');
const household = (name: string, id: string, addr = address) => `戶籍謄本\n戶籍地址：${addr}\n姓名：${name}國民身分證統一編號：${id}\n出生日期：民國80年1月1日`;
const petition = (name: string, id: string, addr = address) => `支付命令聲請狀\n債權人：甲測試股份有限公司\n住所：臺北市甲路7號\n債務人：${name}\n身分證字號：${id}\n住所：${addr}\n請求本金新臺幣100元`;

describe('V3 戶籍資料與地址', () => {
  it('0H1、3：姓名不跨欄，不拿戶長、家屬或舊住址填補本人', () => {
    const text = `${household('林測試', idA)}\n戶長姓名：甲戶長\n配偶姓名：甲配偶\n地址變更：戶籍地址：新北市甲區甲路9號`;
    expect(findLabeledNames(text).map((n) => n.value)).toEqual(['林測試']);
    expect(findLabeledNames(household('林甲', idA))[0]?.value).toBe('林甲');
    expect(personsFromHousehold(document('house', 'household-register', [text]))).toMatchObject([{ name: '林測試', id: idA, address }]);
    expect(debtorFields(petition('林測試', idA)).address?.value).toBe(address);
  });

  it('0H4：欄位區域有唯一行時，保留可用於局部裁切的座標', () => {
    const source = document('hh', 'household-register', [household('林測試', idA)], true);
    source.pages[0].scan = { raw: source.fullText, lines: [{ text: `姓名：林測試`, region: { left: 0.3, top: 0.4, width: 0.22, height: 0.06 } }] };
    const p = provAt(source, 1, source.fullText.indexOf('林測試'), '林測試');
    expect(p.region?.width).toBeGreaterThan(0.22);
    expect(p.page).toBe(1);
  });

  it('0H2：有讀到文字與正確身分證，姓名未擷取的欄位可更正', () => {
    const h = document('house', 'household-register', [household('林□試', idA)], true);
    const p = document('pet', 'payment-order-petition', [petition('林測試', idA)]);
    const initial = runFlowC([p, h], { settings });
    const row = initial.units[0].items[0];
    expect(row.status).toBe('unreadable');
    expect(row.reason).toContain('有讀到文字');
    const key = row.a!.correction!.key;
    const rerun = runFlowC([p, h], { settings, corrections: { [key]: { value: '林測試', by: '覆核員', at: '2026-11-22' } } });
    expect(rerun.units[0].items[0]).toMatchObject({ status: 'match', a: { raw: '', normalized: '林測試', prov: { method: 'manual', page: 1 } } });
    expect(h.pages[0].text).toContain('林□試');
  });

  it.each([
    ['0H5 鄰號前置零', address.replace('20鄰', '020鄰')],
    ['0H6 郵遞區號', `241 ${address}`],
    ['0H7 國字與全形', address.replace('20鄰', '二十鄰').replace('98巷', '九十八巷').replace('5樓', '五樓')],
  ])('%s', (_, alternative) => expect(compareAddress(address, alternative).state).toBe('normalizedEquivalent'));

  it('0H8、9：同一差異依來源分流，保留樓層、巷號與房號', () => {
    const wrong = address.replace('98巷', '93巷');
    expect(compareAddress(address, wrong, true)).toMatchObject({ state: 'suspectedOcrError', detail: expect.stringContaining('巷號') });
    expect(compareAddress(address, wrong).state).toBe('confirmedMismatch');
    expect(compareAddress(address, address.replace('5樓', '3樓')).detail).toContain('樓層');
    expect(compareAddress(`${address}020室`, `${address}20室`).equal).toBe(false);
    const docs = [document('p', 'payment-order-petition', [petition('林測試', idA)]), document('h', 'household-register', [household('林測試', idA, wrong)], true)];
    const row = runFlowC(docs, { settings }).units[0].items.find((i) => i.field.startsWith('地址'))!;
    expect(row).toMatchObject({ status: 'needs-review', a: { normalized: wrong, prov: { page: 1 } } });
  });
});

describe('V3 案件隔離與角色', () => {
  it('0H10、12、13：合併多頁書狀依人物分開，錯序、缺件及人工換頁隔離', () => {
    const p = document('pet', 'payment-order-petition', [petition('林測試', idA), petition('陳測試', idB), petition('李測試', fakeId('Y', '10000003'))]);
    const h = document('hh', 'household-register', [household('陳測試', idB), household('林測試', idA)]);
    const before = runFlowC([p, h], { settings });
    expect(before.units.map((u) => u.label)).toEqual(['林測試', '陳測試', '李測試']);
    expect(before.units.map((u) => u.docs.find((d) => d.role === 'household-register')?.pages)).toEqual([[2], [1], undefined]);
    const manualPairs = { [before.units[0].pairKey!]: { person: before.extra.persons[0].key } };
    const after = runFlowC([p, h], { settings, manualPairs });
    expect(after.extra.persons.map((x) => x.key)).toEqual(before.extra.persons.map((x) => x.key));
    expect(after.units.map((u) => u.docs.find((d) => d.role === 'household-register')?.pages)).toEqual([[1], [1], undefined]);
    expect(after.units[1].items.map((i) => i.status)).toEqual(before.units[1].items.map((i) => i.status));
  });

  it('0H11、15、17：同名不同案與缺送達證書分開，第三人不適用', () => {
    const court = '臺灣臺北地方法院';
    const key = (n: number) => `114年度司促字第${n}號`;
    const p = document('merged', 'enforcement-petition', [1, 2].map((n) => `民事強制執行聲請狀\n債務人：林測試\n執行名義：${court}${key(n)}支付命令\n自114年7月2日起至清償日止按年利率5%計算利息`));
    const sources = document('orders', 'merged-source', [
      ...[1, 2].map((n) => `${court}支付命令\n${key(n)}\n債務人：林測試\n自支付命令送達翌日起計算利息`),
      `送達證書\n${key(1)}\n應受送達人：林測試\n本人收受\n送達日期：114年7月1日`,
    ]);
    const { units } = runFlowB([p, sources], { settings });
    expect(new Set(units.map((u) => u.id)).size).toBe(2);
    expect(units.map((u) => u.items.find((i) => i.field === '利息起算日')?.status)).toEqual(['match', 'needs-review']);
    expect(units.every((u) => u.items.find((i) => i.field.includes('第三人'))?.status === 'not-applicable')).toBe(true);
  });

  it('0H14：查稅資料只核對明文存在的第三人欄位', () => {
    const key = '臺灣臺北地方法院114年度司促字第51號';
    const p = document('p', 'enforcement-petition', [`債務人：林測試\n第三人：甲測試股份有限公司\n法定代理人：乙測試\n執行名義：${key}`]);
    const order = document('o', 'payment-order', [`臺灣臺北地方法院支付命令\n114年度司促字第51號\n債務人：林測試`]);
    const tax = document('t', 'tax-record', [`國稅局查稅資料\n${key}\n第三人：甲測試股份有限公司`], true);
    const result = runFlowB([p, order, tax], { settings }).units[0];
    expect(result.items.find((i) => i.field === '第三人')).toMatchObject({ status: 'match', a: { prov: { page: 1 } } });
    expect(result.items.find((i) => i.field === '第三人法定代理人')?.status).toBe('needs-review');
  });

  it('0H17：同一法院案號有兩位債務人時，送達證書只計算收件人', () => {
    const court = '臺灣臺北地方法院';
    const caseNo = '114年度司促字第67號';
    const names = ['林測試', '陳測試'];
    const p = document('joined', 'enforcement-petition', names.map((name) => `民事強制執行聲請狀\n債務人：${name}\n執行名義：${court}${caseNo}支付命令\n自114年7月2日起至清償日止計算利息`));
    const g = document('source', 'merged-source', [
      ...names.map((name) => `${court}支付命令\n${caseNo}\n債務人：${name}\n自支付命令送達翌日起計算利息`),
      `送達證書\n${caseNo}\n應受送達人：林測試\n本人收受\n送達日期：114年7月1日`,
    ]);
    const { units } = runFlowB([p, g], { settings });
    expect(units.map((u) => u.label)).toEqual(names);
    expect(units.map((u) => u.items.find((i) => i.field === '利息起算日')?.status)).toEqual(['match', 'needs-review']);
  });

  it('案號未讀出時可從原頁補正該案，保留空白原值', () => {
    const raw = '民事強制執行聲請狀\n債務人：林測試\n執行名義：〔未讀清楚〕';
    const p = document('p', 'enforcement-petition', [raw]);
    const g = document('g', 'payment-order', ['臺灣臺北地方法院支付命令\n114年度司促字第67號\n債務人：林測試']);
    const before = runFlowB([p, g], { settings }).units[0];
    const key = before.items[0].b!.correction!.key;
    const after = runFlowB([p, g], { settings, corrections: { [key]: { value: '114年度司促字第67號', by: '覆核員', at: '2026-11-22' } } }).units[0];
    expect(after.id).toBe(before.id);
    expect(after.items.find((i) => i.field === '年度／字別／案號')).toMatchObject({ status: 'match', b: { raw: '', normalized: '114年度司促字第67號' } });
    expect(p.pages[0].text).toBe(raw);
  });

  it('0H22：報告遮罩批次名稱、原始值及人工更正內容', () => {
    const p = document('p', 'payment-order-petition', [petition('林測試', idA)]);
    const h = document('h', 'household-register', [household('林測試', idA)]);
    const initial = runFlowC([p, h], { settings });
    const key = initial.units[0].items.find((i) => i.field.startsWith('身分證'))!.a!.correction!.key;
    const result = runFlowC([p, h], { settings, corrections: { [key]: { value: idB, by: '覆核員', at: '2026-11-22' } } });
    for (const report of [buildHtmlReport(result, [p, h], { batchName: idA, mask: true }), buildCsvReport(result, { batchName: idA, mask: true })]) {
      expect(report).not.toContain(idA);
      expect(report).not.toContain(idB);
      expect(report).toContain('覆核員');
    }
  });
});
