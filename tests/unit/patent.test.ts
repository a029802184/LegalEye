import { describe, expect, it } from 'vitest';
import { exportPatentCsv, exportPatentXlsx, importPatentFile, parseCsv, toCsv, demoPatents } from '../../src/patent/io';
import { checkIntegrity, DEFAULT_STATUSES, dueBucket, FIELDS } from '../../src/patent/model';

const enc = (s: string) => new TextEncoder().encode(s);

describe('專利主檔：匯入→編輯→匯出→重新匯入', () => {
  it('Excel 往返不遺失任何欄位，狀態設定一併保存', async () => {
    const list = demoPatents();
    list[0].note = '含逗號,與"引號"\n與換行';
    list[1].name = '=HYPERLINK("x")'; // 公式注入字樣
    const statuses = [...DEFAULT_STATUSES, { name: '自訂狀態', group: 'other' as const, active: false }];
    const xlsx = await exportPatentXlsx(list, statuses);
    const back = await importPatentFile('主檔.xlsx', xlsx);
    expect(back.errors).toEqual([]);
    expect(back.version).toBe('2.0');
    expect(back.records).toEqual(list);
    expect(back.statuses?.find((s) => s.name === '自訂狀態')).toEqual({ name: '自訂狀態', group: 'other', active: false });
  });

  it('CSV 往返（含公式注入防護）', async () => {
    const list = demoPatents();
    list[0].name = '=1+1';
    list[1].owner = '@SUM(A1)';
    list[2].note = '-2+3';
    const csv = exportPatentCsv(list);
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'@SUM(A1)");
    const back = await importPatentFile('主檔.csv', enc(csv));
    expect(back.records).toEqual(list);
  });

  it('相容舊版 LegalDesk 8 欄 CSV（欄位順序可變）', async () => {
    const legacy = toCsv([
      ['承辦人', '內部編號', '案件名稱', '專利類型', '申請案號', '內部進度', '下次確認日', '備註'],
      ['法務室', 'IP-001', '模組化節能裝置', '發明', '115100000', '審查中', '2026/12/01', '舊資料'],
      ['承辦甲', 'IP-002', '人機介面', '設計', '', '提案中', '', ''],
    ]);
    const r = await importPatentFile('舊版.csv', enc(legacy));
    expect(r.legacy).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.records[0]).toMatchObject({ id: 'IP-001', name: '模組化節能裝置', owner: '法務室', status: '審查中', nextCheck: '2026-12-01', note: '舊資料' });
    expect(r.records[1].status).toBe('提案中'); // 舊狀態原文保留
    const issues = checkIntegrity(r.records, DEFAULT_STATUSES);
    expect(issues.some((i) => i.message.includes('「提案中」不在狀態清單'))).toBe(true);
  });

  it('重複案件、缺欄位、日期錯誤、不支援格式', async () => {
    const bad = toCsv([
      ['內部案件編號', '專利名稱', '申請日'],
      ['A', '甲', '2025-13-01'],
      ['A', '乙', ''],
      ['', '丙', ''],
    ]);
    const r = await importPatentFile('x.csv', enc(bad));
    expect(r.errors.join()).toMatch(/重複：A/);
    expect(r.errors.join()).toMatch(/缺少內部案件編號/);
    expect(r.warnings.join()).toMatch(/日期格式無法辨識/);
    await expect(importPatentFile('x.xls', new Uint8Array())).rejects.toThrow(/xlsx/);
    const noHead = await importPatentFile('y.csv', enc('a,b\n1,2'));
    expect(noHead.errors[0]).toMatch(/找不到/);
  });

  it('CSV 解析處理引號與換行', () => {
    expect(parseCsv('a,"b,""c""\nd"\r\n1,2')).toEqual([
      ['a', 'b,"c"\nd'],
      ['1', '2'],
    ]);
  });

  it('欄位定義涵蓋需求的 19 個欄位', () => {
    expect(FIELDS).toHaveLength(20); // 19 欄 + 期限種類
  });
});

describe('重要期限提醒', () => {
  const today = { y: 2025, m: 7, d: 1 };
  it.each([
    ['2025-06-30', 'overdue'],
    ['2025-07-01', 'd7'],
    ['2025-07-08', 'd7'],
    ['2025-07-09', 'd30'],
    ['2025-07-31', 'd30'],
    ['2025-08-01', 'later'],
    ['', 'none'],
    ['2025-02-30', 'none'],
  ])('%s → %s', (d, b) => expect(dueBucket(d, today).bucket).toBe(b));
});
