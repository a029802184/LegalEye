import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { parseDocx, isRedColor } from '../../src/core/docx';
import { readXlsx, writeXlsx } from '../../src/core/xlsx';
import { safeUnzip, sanitizeZipPath, ZipError } from '../../src/core/zip';
import { sha256Hex } from '../../src/core/hash';
import { buildDocx, para } from '../fixtures/builders';

describe('DOCX 紅字辨識', () => {
  it('多頁、run 分割、樣式繼承的紅字都能辨識；黑字不誤判', async () => {
    const data = await buildDocx([
      [para('主旨：檢送【114年度】【司執字第】【123號】執行命令'), para('債務人：【王小明】')],
      [{ runs: [{ text: '債務人：' }, { text: '陳', styleRed: true }, { text: '美玲', styleRed: true }, { text: '（黑字）' }] }],
      [{ runs: [{ text: '深紅', color: 'C00000' }, { text: '橘色', color: 'ED7D31' }, { text: '黑色', color: '000000' }] }],
    ]);
    const r = await parseDocx(data);
    expect(r.pageCount).toBe(3);
    const p1 = r.redSpans.filter((s) => s.page === 1).map((s) => s.text);
    // 相鄰紅字 run 合併成一段
    expect(p1).toContain('114年度司執字第123號');
    expect(p1).toContain('王小明');
    expect(r.redSpans.filter((s) => s.page === 2).map((s) => s.text)).toEqual(['陳美玲']);
    expect(r.redSpans.filter((s) => s.page === 3).map((s) => s.text)).toEqual(['深紅']);
    expect(r.paragraphs.some((p) => p.text.includes('（黑字）'))).toBe(true);
  });
  it('色碼判斷', () => {
    expect(isRedColor('FF0000')).toBe(true);
    expect(isRedColor('C00000')).toBe(true);
    expect(isRedColor('ED7D31')).toBe(false);
    expect(isRedColor('auto')).toBe(false);
  });
  it('毀損檔案清楚報錯', async () => {
    await expect(parseDocx(new Uint8Array([1, 2, 3]))).rejects.toThrow(/無法開啟/);
  });
});

describe('XLSX 讀寫', () => {
  it('公式、快取值、無快取值', async () => {
    const data = await writeXlsx([
      {
        name: '明細',
        header: true,
        rows: [
          ['項目', '金額'],
          ['A', 100],
          ['B', 200.5],
          ['合計', { f: 'SUM(B2:B3)', v: 300.5 }],
          ['未算', { f: 'B2*2' }],
        ],
      },
    ]);
    const r = await readXlsx(data);
    const s = r.sheets[0];
    expect(s.name).toBe('明細');
    expect(s.cells.get('B4')?.value).toBe(300.5);
    expect(s.cells.get('B4')?.formula).toBe('SUM(B2:B3)');
    expect(s.cells.get('B5')?.formulaNoCache).toBe(true);
    expect(r.warnings.join()).toMatch(/沒有計算結果/);
  });
});

describe('ZIP 安全', () => {
  it('拒絕路徑穿越與絕對路徑', () => {
    expect(sanitizeZipPath('../evil.txt')).toBeNull();
    expect(sanitizeZipPath('a/../../evil.txt')).toBeNull();
    expect(sanitizeZipPath('/etc/passwd')).toBeNull();
    expect(sanitizeZipPath('C:\\Windows\\x.txt')).toBeNull();
    expect(sanitizeZipPath('資料夾\\子資料夾\\檔案.pdf')).toBe('資料夾/子資料夾/檔案.pdf');
  });

  it('惡意路徑、重複、巢狀 ZIP、不支援類型列入略過清單', async () => {
    const z = new JSZip();
    z.file('ok/文件.txt', '內容');
    z.file('../evil.txt', 'x');
    z.file('nested.zip', 'PK');
    z.file('run.exe', 'MZ');
    z.file('__MACOSX/._x', 'junk');
    const r = await safeUnzip(await z.generateAsync({ type: 'uint8array' }));
    expect(r.files.map((f) => f.path)).toEqual(['ok/文件.txt']);
    const reasons = r.skipped.map((s) => s.reason).join('|');
    expect(reasons).toMatch(/不安全的路徑/);
    expect(reasons).toMatch(/巢狀 ZIP/);
    expect(reasons).toMatch(/不支援的檔案類型/);
  });

  it('解壓縮大小上限與壓縮比（ZIP Bomb）', async () => {
    const z = new JSZip();
    z.file('big.txt', 'A'.repeat(3 * 1024 * 1024));
    const data = await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const r = await safeUnzip(data, { limits: { maxRatio: 50 } });
    expect(r.files).toHaveLength(0);
    expect(r.skipped[0].reason).toMatch(/壓縮比異常/);
    await expect(safeUnzip(data, { limits: { maxTotalBytes: 1024, maxRatio: 100000 } })).rejects.toBeInstanceOf(ZipError);
  });

  it('檔案數上限、損毀檔', async () => {
    const z = new JSZip();
    for (let i = 0; i < 6; i++) z.file(`${i}.txt`, 'x');
    await expect(safeUnzip(await z.generateAsync({ type: 'uint8array' }), { limits: { maxEntries: 5 } })).rejects.toThrow(/上限/);
    await expect(safeUnzip(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/不是有效的 ZIP/);
  });

  it('加密 ZIP 清楚報錯', async () => {
    const z = new JSZip();
    z.file('a.txt', 'x');
    const data = await z.generateAsync({ type: 'uint8array' });
    // 手動設定中央目錄的加密旗標（bit 0）
    const dv = new DataView(data.buffer);
    for (let i = 0; i < data.length - 4; i++) if (dv.getUint32(i, true) === 0x02014b50) dv.setUint16(i + 8, dv.getUint16(i + 8, true) | 1, true);
    await expect(safeUnzip(data)).rejects.toThrow(/密碼保護/);
  });
});

describe('SHA-256', () => {
  it('與標準值一致', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
