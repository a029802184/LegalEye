// 以虛構示範資料跑完整管線（ZIP → 解析 → 分類 → 核對），驗證各流程的必要案例。
import { describe, expect, it } from 'vitest';
import { ingest } from '../../src/core/ingest';
import { DEFAULT_SETTINGS } from '../../src/core/rules';
import { unitStatus, type CheckItem, type FlowId, type FlowResult } from '../../src/core/types';
import { FLOWS, runFlow } from '../../src/flows';
import { demoA, demoB, demoC, demoD } from '../fixtures/datasets';
import { readTestPdf } from '../fixtures/builders';

const settings = structuredClone(DEFAULT_SETTINGS);
const pdfExtractor = async (d: Uint8Array) =>
  readTestPdf(d).map((p) => ({ page: p.page, text: p.text, method: 'pdf-text' as const, confidence: p.needsOcr ? 0 : 1, needsOcr: p.needsOcr }));

async function run(flow: FlowId, files: { name: string; data: Uint8Array }[], extra = {}): Promise<FlowResult> {
  const roles = FLOWS.find((f) => f.id === flow)!.roles;
  const r = await ingest(files, { allowedRoles: roles, pdfExtractor });
  return runFlow(flow, r.docs, { settings, ...extra });
}

const find = (res: FlowResult, unit: string, field: string): CheckItem | undefined =>
  res.units.find((u) => u.label.includes(unit))?.items.find((i) => i.field.includes(field));

describe('流程 A：法院公文／通知函', () => {
  it('依案號配對（非頁序），找出字別錯誤與內部案號不一致；缺來源欄位不報錯', async () => {
    const res = await run('A', await demoA());
    expect(res.units.map((u) => u.label).sort()).toEqual(['林志豪', '王小明', '陳美玲']);
    // 王小明：全部一致；身分證遮罩僅部分核對；帳號未設主檔 → 不適用
    expect(find(res, '王小明', '案號')!.status).toBe('match');
    expect(find(res, '王小明', '身分證')!.status).toBe('partial');
    expect(find(res, '王小明', '債權金額')!.status).toBe('match');
    expect(find(res, '王小明', '帳號')!.status).toBe('not-applicable');
    // 陳美玲：司執 vs 司執助
    const c = find(res, '陳美玲', '年度／字別／案號')!;
    expect(c.status).toBe('mismatch');
    expect(c.reason).toMatch(/字別「司執助」≠「司執」/);
    // 林志豪：法院公文未記載金額 → 不適用；支票備註案號誤植 → 內部不一致
    expect(find(res, '林志豪', '債權金額')!.status).toBe('not-applicable');
    expect(find(res, '林志豪', '內案號一致性')!.status).toBe('mismatch');
    // 紅字經樣式繼承也能定位
    const u = res.units.find((x) => x.label === '王小明')!;
    expect(u.docs.find((d) => d.role === 'court-notice')!.pages).toEqual([2, 3]);
  });

  it('設定公司帳號主檔後，依主檔核對帳號', async () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.bankMaster = [{ label: '收款帳戶', account: '0123456789012' }];
    const roles = FLOWS[0].roles;
    const r = await ingest(await demoA(), { allowedRoles: roles, pdfExtractor });
    const res = runFlow('A', r.docs, { settings: s });
    expect(find(res, '王小明', '帳號')!.status).toBe('match');
  });
});

describe('流程 B：強制執行聲請狀', () => {
  it('寄存送達 7/1 → 7/12、驗算 15,520 − 1,244 = 14,276、國字＝數字、地址差異列人工確認', async () => {
    const res = await run('B', await demoB());
    expect(res.units).toHaveLength(1);
    const it_ = (f: string) => res.units[0].items.find((i) => i.field === f)!;
    expect(it_('利息起算日').status).toBe('match');
    expect(it_('利息起算日').calc).toMatch(/寄存日 114年7月1日.*114年7月12日/s);
    expect(it_('驗算式').status).toBe('match');
    expect(it_('扣除已清償後餘額').status).toBe('match');
    expect(it_('國字與數字金額').status).toBe('match');
    expect(it_('本金').status).toBe('match');
    expect(it_('程序費用').status).toBe('match');
    expect(it_('利率').status).toBe('match');
    expect(it_('債務人住址').status).toBe('needs-review');
    expect(it_('附件：確定證明書').status).toBe('match');
  });

  it('人工改為一般送達時重新計算；不以確定證明書日期當送達日', async () => {
    const files = await demoB();
    const r = await ingest(files, { allowedRoles: FLOWS[1].roles, pdfExtractor });
    const key = '114-司促-8888';
    const res = runFlow('B', r.docs, { settings, service: { [key]: { method: 'personal', serviceDate: '2025-07-01' } } });
    const i = res.units[0].items.find((x) => x.field === '利息起算日')!;
    expect(i.status).toBe('mismatch'); // 書狀寫 7/12，一般送達應為 7/2
    const res2 = runFlow('B', r.docs, { settings, service: { [key]: { method: 'unknown' } } });
    expect(res2.units[0].items.find((x) => x.field === '利息起算日')!.status).toBe('needs-review');
  });
});

describe('流程 C：支付命令批次', () => {
  it('11 人、10 頁戶謄、缺件、同名、本期應繳、金額待釐清、掃描失敗', async () => {
    const res = await run('C', await demoC());
    expect(res.units).toHaveLength(11);
    const msgs = res.batchIssues.map((i) => i.message).join('\n');
    expect(msgs).toMatch(/戶籍謄本共 10 頁，聲請狀 11 份/);
    expect(msgs).toMatch(/同名「王小明」/);
    expect(msgs).toMatch(/70010007\.pdf.*(掃描|無法|未取得)/);
    // 兩位王小明各自以身分證配對到正確的人
    const wangs = res.units.filter((u) => u.label === '王小明');
    expect(wangs).toHaveLength(2);
    for (const w of wangs) expect(w.items.find((i) => i.field.startsWith('身分證'))!.status).toBe('match');
    // 劉建宏缺戶籍
    expect(find(res, '劉建宏', '姓名')!.status).toBe('missing');
    // 黃怡君只有本期應繳 → 不比對
    expect(find(res, '黃怡君', '聲請本金')!.reason).toMatch(/本期應繳/);
    // 吳宗翰有已繳款 → 金額待釐清
    const wu = find(res, '吳宗翰', '聲請本金')!;
    expect(wu.status).toBe('needs-review');
    expect(wu.reason).toMatch(/金額待釐清/);
    // 張家豪地址樓層不同
    expect(find(res, '張家豪', '地址')!.status).toBe('mismatch');
    // 利息為條件式請求 → 不適用
    expect(find(res, '李佩珊', '利息起算')!.status).toBe('not-applicable');
    // 沒有任何一位「掃描失敗」的人被當成一致
    const tsai = res.units.find((u) => u.label === '蔡依婷')!;
    expect(unitStatus(tsai)).not.toBe('consistent');
    // 整批不可能全部通過
    expect(res.units.every((u) => unitStatus(u) === 'consistent')).toBe(false);
  });
});

describe('流程 D：民事陳報狀', () => {
  it('Excel 30,802＝參萬零捌佰零貳＝30,802；附件份數與收錄問題；限期陳報不比對開庭', async () => {
    const res = await run('D', await demoD());
    const unit = (l: string) => res.units.find((u) => u.label === l)!;
    const excel = unit('債務明細表驗算');
    expect(excel.items.filter((i) => i.status === 'match').length).toBeGreaterThanOrEqual(3);
    const amt = unit('陳報金額');
    expect(amt.items.every((i) => i.status === 'match')).toBe(true);
    expect(amt.items.some((i) => i.field === '陳報狀附表合計')).toBe(true);
    const cs = unit('案件資訊');
    expect(cs.items.find((i) => i.field === '年度／字別／案號')!.status).toBe('match');
    expect(cs.items.find((i) => i.field === '股別')!.status).toBe('match');
    expect(cs.items.find((i) => i.field === '債務人姓名')!.status).toBe('match');
    expect(cs.items.find((i) => i.field === '開庭日期')!.status).toBe('not-applicable');
    const att = unit('附件核對');
    const f = (x: string) => att.items.find((i) => i.field === x);
    expect(f('附件一 名稱')!.status).toBe('match'); // 同義詞：行動寬頻申請書／申裝書
    expect(f('附件二 份數')!.status).toBe('mismatch'); // 書狀 2 份，附件 PDF 1 份
    expect(f('附件三 收錄')!.status).toBe('needs-review'); // 只在 ZIP、不在正式附件 PDF
  });
});
