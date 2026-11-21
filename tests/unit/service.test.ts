import { describe, expect, it } from 'vitest';
import { computeInterestStart, detectInterestClause, detectServiceMethod } from '../../src/core/service';
import { fmtISO, parseDate } from '../../src/core/date';

const d = (s: string) => parseDate(s)!;

describe('送達與利息起算規則', () => {
  it('一般送達：S + 1', () => {
    const r = computeInterestStart({ clause: { type: 'after-service' }, method: 'personal', serviceDate: d('2025-07-01') });
    expect(r.status).toBe('computed');
    expect(fmtISO(r.interestStart!)).toBe('2025-07-02');
  });

  it('寄存送達 7/1 → 7/11 生效 → 7/12 起息（D + 11）', () => {
    const r = computeInterestStart({ clause: { type: 'after-service' }, method: 'deposit', serviceDate: d('2025-07-01') });
    expect(fmtISO(r.effectiveDate!)).toBe('2025-07-11');
    expect(fmtISO(r.interestStart!)).toBe('2025-07-12');
    expect(r.formula).toContain('D＋11');
  });

  it('寄存後 10 日內提前領取 → 需人工判斷，不自動套 +11', () => {
    const r = computeInterestStart({ clause: { type: 'after-service' }, method: 'deposit', serviceDate: d('2025-07-01'), pickupDate: d('2025-07-03') });
    expect(r.status).toBe('manual');
    expect(r.interestStart).toBeUndefined();
  });

  it('金門法院但非寄存送達：不套 +11（與法院地點無關）', () => {
    const r = computeInterestStart({ clause: { type: 'after-service' }, method: 'personal', serviceDate: d('2025-07-01'), court: '福建金門地方法院' });
    expect(fmtISO(r.interestStart!)).toBe('2025-07-02');
  });

  it('送達方式不明、公示送達、境外送達：需人工判斷', () => {
    for (const method of ['unknown', 'public', 'foreign'] as const) {
      const r = computeInterestStart({ clause: { type: 'after-service' }, method, serviceDate: d('2025-07-01'), court: '福建金門地方法院' });
      expect(r.status).toBe('manual');
    }
  });

  it('沒有送達日（只有確定證明書）不能計算', () => {
    const r = computeInterestStart({ clause: { type: 'after-service' }, method: 'personal', serviceDate: null });
    expect(r.status).toBe('manual');
  });

  it('多名債務人送達日不同：需人工判斷', () => {
    const r = computeInterestStart({ clause: { type: 'after-service' }, method: 'personal', serviceDate: d('2025-07-01'), multipleDebtorsDiffer: true });
    expect(r.status).toBe('manual');
  });

  it('執行名義記載固定起息日：直接使用，不與送達日混用', () => {
    const r = computeInterestStart({ clause: { type: 'fixed-date', date: d('2025-03-01') }, method: 'deposit', serviceDate: d('2025-07-01') });
    expect(r.status).toBe('fixed');
    expect(fmtISO(r.interestStart!)).toBe('2025-03-01');
  });

  it('不把 20 日異議期間加進起息日', () => {
    const r = computeInterestStart({ clause: { type: 'after-service' }, method: 'personal', serviceDate: d('2025-07-01') });
    expect(fmtISO(r.interestStart!)).not.toBe('2025-07-22');
  });

  it('跨年寄存送達', () => {
    const r = computeInterestStart({ clause: { type: 'after-service' }, method: 'deposit', serviceDate: d('2025-12-25') });
    expect(fmtISO(r.interestStart!)).toBe('2026-01-05');
  });

  it('條款與送達方式辨識', () => {
    expect(detectInterestClause('及自本支付命令送達翌日起至清償日止', parseDate).clause.type).toBe('after-service');
    const f = detectInterestClause('自民國114年3月1日起至清償日止', parseDate);
    expect(f.clause.type).toBe('fixed-date');
    expect(detectServiceMethod('已將文書寄存於板橋派出所')).toBe('deposit');
    expect(detectServiceMethod('由本人親自簽收')).toBe('personal');
    expect(detectServiceMethod('公示送達')).toBe('public');
    expect(detectServiceMethod('其他')).toBe('unknown');
  });
});
