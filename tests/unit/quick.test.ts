// 快速文字校對（保留自舊版 LegalDesk）：舊版示範案例的預期結果必須仍然成立。
import { describe, expect, it } from 'vitest';
import { runQuickCheck } from '../../src/flows/quick';
import { DEFAULT_SETTINGS } from '../../src/core/rules';
import type { ExtractedDoc } from '../../src/core/types';

const ctx = { settings: structuredClone(DEFAULT_SETTINGS) };
function doc(text: string): ExtractedDoc {
  const data = new TextEncoder().encode(text);
  return {
    file: { id: 'f1', name: 't.txt', path: 't.txt', kind: 'txt', size: data.length, sha256: '', data },
    status: 'ok',
    warnings: [],
    pages: [{ page: 1, text, method: 'txt', confidence: 1 }],
    fullText: text,
    role: 'enforcement-petition',
    roleCandidates: [],
  };
}
const LEGACY_DEMO =
  '民事聲請強制執行狀\n債權人：甲股份有限公司\n債務人：王小明\n為聲請強制執行事：\n依臺灣○○地方法院115年度訴字第132號判決，請求債務人王小名給付本金新臺幣100,000元。\n證物：判決正本。';

describe('快速文字校對（舊版功能保留）', () => {
  const res = runQuickCheck(doc(LEGACY_DEMO), { creditor: '甲股份有限公司', debtor: '王小明', caseNo: '115年度訴字第123號', principal: '120000' }, ctx);
  const f = (name: string) => res.units[0].items.find((i) => i.field === name)!;

  it('案號 132 與基準 123 不同', () => expect(f('執行名義案號（基準資料）').status).toBe('mismatch'));
  it('本金 100,000 與基準 120,000 不同', () => expect(f('本金（基準資料）').status).toBe('mismatch'));
  it('找到占位符 ○○', () => {
    expect(f('範本未完成欄位').status).toBe('needs-review');
    expect(f('範本未完成欄位').reason).toContain('○○');
  });
  it('王小明／王小名 前後不一致需確認', () => {
    expect(f('債務人（基準資料）').status).toBe('needs-review');
    expect(f('債務人姓名前後一致').reason).toMatch(/王小明.*王小名/);
  });
  it('債權人一致', () => expect(f('債權人（基準資料）').status).toBe('match'));

  it('不同用途金額不誤報；沒有基準資料不判錯', () => {
    const r = runQuickCheck(doc('債權人：甲股份有限公司\n債務人：王小明\n請求本金新臺幣100,000元，及執行費新臺幣800元，利息新臺幣1,234元。'), { creditor: '', debtor: '', caseNo: '', principal: '' }, ctx);
    expect(r.units[0].items.filter((i) => i.status === 'mismatch')).toHaveLength(0);
  });

  it('同為本金卻記載不同金額 → 不一致', () => {
    const r = runQuickCheck(doc('聲請事項：本金新臺幣100,000元。\n聲請理由：本金新臺幣10,000元。'), { creditor: '', debtor: '', caseNo: '', principal: '' }, ctx);
    expect(r.units[0].items.find((i) => i.field === '本金前後一致')!.status).toBe('mismatch');
  });

  it('多名不同債務人合法並存：只提示，不判錯', () => {
    const r = runQuickCheck(doc('債務人：王小明\n債務人：李大華'), { creditor: '', debtor: '', caseNo: '', principal: '' }, ctx);
    const i = r.units[0].items.find((x) => x.field === '債務人姓名前後一致')!;
    expect(i.status).toBe('needs-review');
    expect(i.severity).toBe('info');
  });

  it('無效日期', () => {
    const r = runQuickCheck(doc('中華民國114年2月30日'), { creditor: '', debtor: '', caseNo: '', principal: '' }, ctx);
    expect(r.units[0].items.find((x) => x.field === '無效日期')!.status).toBe('mismatch');
  });
});
