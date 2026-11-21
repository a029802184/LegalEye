// 專利主檔 Excel／CSV 匯入匯出。Excel 為正式主檔；網頁不會修改原始檔，只會下載新檔。
// - 欄位依名稱對應（欄位順序可變），相容舊版 8 欄 CSV
// - 匯出 Excel 含：專利案件資料表、案件狀態設定、資料校驗規則、欄位說明、資料格式版本
// - CSV 防公式注入（=、+、-、@、Tab、CR 開頭加上單引號）

import { readXlsx, sheetToRows, writeXlsx } from '../core/xlsx';
import { decodeText } from '../core/ingest';
import { parseDate, fmtISO } from '../core/date';
import { emptyPatent, FIELDS, PATENT_FORMAT_VERSION, type Patent, type StatusDef, type StatusGroup, STATUS_GROUP_LABEL } from './model';

export const SHEET_DATA = '專利案件資料表';
export const SHEET_STATUS = '案件狀態設定';
export const SHEET_RULES = '資料校驗規則';
export const SHEET_DICT = '欄位說明';
export const SHEET_VERSION = '資料格式版本';

export function csvCell(v: unknown): string {
  let t = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

export function toCsv(rows: unknown[][]): string {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, '');
  const out: string[][] = [];
  let row: string[] = [];
  let s = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        s += '"';
        i++;
      } else if (c === '"') quoted = false;
      else s += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(s);
      s = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(s);
      if (row.some((v) => v !== '')) out.push(row);
      row = [];
      s = '';
    } else s += c;
  }
  if (quoted) throw new Error('CSV 引號未正確結束，檔案可能損毀');
  row.push(s);
  if (row.some((v) => v !== '')) out.push(row);
  return out;
}

/** 移除匯出時為防公式注入加上的單引號 */
function unescapeCell(v: string): string {
  return /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v;
}

function normDate(v: string): { value: string; bad: boolean } {
  const t = v.trim();
  if (!t) return { value: '', bad: false };
  const d = parseDate(t.replace(/\//g, '-'));
  return d ? { value: fmtISO(d), bad: false } : { value: t, bad: true };
}

export interface ImportReport {
  records: Patent[];
  statuses?: StatusDef[];
  version: string;
  legacy: boolean;
  warnings: string[];
  errors: string[];
}

export function rowsToPatents(rows: string[][], sourceLabel: string): ImportReport {
  const warnings: string[] = [];
  const errors: string[] = [];
  if (!rows.length) return { records: [], version: '?', legacy: false, warnings, errors: ['檔案沒有資料'] };
  // 找表頭列（前 5 列內含「內部案件編號」或舊版「內部編號」）
  let hi = rows.findIndex((r, i) => i < 5 && r.some((c) => /內部(案件)?編號/.test(c)));
  if (hi < 0) hi = 0;
  const head = rows[hi].map((h) => h.trim().replace(/\s*\*$/, ''));
  const colOf = new Map<string, number>();
  let legacy = false;
  for (const f of FIELDS) {
    let idx = head.indexOf(f.label);
    if (idx < 0 && f.legacy) {
      for (const l of f.legacy) {
        idx = head.indexOf(l);
        if (idx >= 0) {
          legacy = true;
          break;
        }
      }
    }
    if (idx >= 0) colOf.set(f.key, idx);
  }
  if (!colOf.has('id') || !colOf.has('name')) {
    errors.push(`${sourceLabel}：找不到「內部案件編號」與「專利名稱」欄位，請使用本系統的 Excel 範本`);
    return { records: [], version: '?', legacy, warnings, errors };
  }
  const known = new Set([...FIELDS.map((f) => f.label), ...FIELDS.flatMap((f) => f.legacy ?? [])]);
  const extra = head.filter((h) => h && !known.has(h));
  if (extra.length) warnings.push(`以下欄位不在範本中，匯入時略過：${extra.join('、')}`);
  const missing = FIELDS.filter((f) => !colOf.has(f.key) && f.key !== 'updatedAt').map((f) => f.label);
  if (missing.length && !legacy) warnings.push(`檔案缺少欄位（將保留空白）：${missing.join('、')}`);
  if (legacy) warnings.push('偵測到舊版 LegalDesk 格式，已依欄位名稱轉換；舊版狀態值保留原文，可在完整性檢查中調整。');

  const records: Patent[] = [];
  rows.slice(hi + 1).forEach((r, i) => {
    const p = emptyPatent();
    for (const f of FIELDS) {
      const idx = colOf.get(f.key);
      (p as unknown as Record<string, string>)[f.key] = idx === undefined ? '' : unescapeCell(String(r[idx] ?? '').trim());
    }
    if (!colOf.has('type')) p.type = '';
    if (!colOf.has('country')) p.country = '';
    if (!p.id && !p.name) return;
    const line = hi + i + 2;
    if (!p.id || !p.name) errors.push(`第 ${line} 列缺少內部案件編號或專利名稱`);
    for (const f of FIELDS.filter((x) => x.kind === 'date')) {
      const d = normDate(p[f.key]);
      (p as unknown as Record<string, string>)[f.key] = d.value;
      if (d.bad) warnings.push(`第 ${line} 列「${f.label}」日期格式無法辨識：「${d.value}」（已保留原文）`);
    }
    records.push(p);
  });
  const ids = records.map((r) => r.id).filter(Boolean);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dup.length) errors.push(`內部案件編號重複：${[...new Set(dup)].join('、')}`);
  return { records, version: legacy ? '1.0（LegalDesk 概念驗證版）' : '?', legacy, warnings, errors };
}

export async function importPatentFile(name: string, data: Uint8Array): Promise<ImportReport> {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'txt') {
    const r = rowsToPatents(parseCsv(decodeText(data)), name);
    if (r.version === '?') r.version = 'CSV（無版本資訊）';
    return r;
  }
  if (ext !== 'xlsx') throw new Error('只支援 .xlsx 或 .csv（舊版 .xls 請先另存為 .xlsx）');
  const x = await readXlsx(data);
  const sheet = x.sheets.find((s) => s.name === SHEET_DATA) ?? x.sheets[0];
  if (!sheet) throw new Error('Excel 沒有任何工作表');
  const r = rowsToPatents(sheetToRows(sheet), `${name}／${sheet.name}`);
  r.warnings.push(...x.warnings);
  const ver = x.sheets.find((s) => s.name === SHEET_VERSION);
  if (ver) {
    const rows = sheetToRows(ver);
    const v = rows.find((row) => row[0] === '資料格式版本')?.[1];
    if (v) r.version = v;
    if (v && v.split('.')[0] !== PATENT_FORMAT_VERSION.split('.')[0]) r.warnings.push(`檔案格式版本 ${v} 與系統 ${PATENT_FORMAT_VERSION} 不同，已依欄位名稱轉換`);
  } else if (r.version === '?') r.version = '未標示（依欄位名稱匯入）';
  const st = x.sheets.find((s) => s.name === SHEET_STATUS);
  if (st) {
    const groups = Object.entries(STATUS_GROUP_LABEL);
    const rows = sheetToRows(st).slice(1).filter((row) => row[0]);
    if (rows.length) {
      r.statuses = rows.map((row) => ({
        name: row[0].trim(),
        group: (groups.find(([, l]) => l === row[1])?.[0] ?? 'other') as StatusGroup,
        active: row[2] !== '停用',
      }));
    }
  }
  return r;
}

export async function exportPatentXlsx(list: Patent[], statuses: StatusDef[]): Promise<Uint8Array> {
  const n = Math.max(list.length + 200, 500);
  const col = (key: string) => String.fromCharCode(65 + FIELDS.findIndex((f) => f.key === key));
  const now = new Date();
  return writeXlsx([
    {
      name: SHEET_DATA,
      header: true,
      freezeHeader: true,
      rows: [FIELDS.map((f) => f.label + (f.required ? ' *' : '')), ...list.map((p) => FIELDS.map((f) => p[f.key] || null))],
      colWidths: FIELDS.map((f) => (f.kind === 'long' ? 40 : f.kind === 'date' ? 13 : f.key === 'name' ? 28 : 16)),
      validations: [
        { sqref: `${col('status')}2:${col('status')}${n}`, formula: `'${SHEET_STATUS}'!$A$2:$A$100`, prompt: '請從狀態清單選擇' },
        { sqref: `${col('type')}2:${col('type')}${n}`, formula: '"發明,新型,設計,其他"' },
        { sqref: `${col('deadlineType')}2:${col('deadlineType')}${n}`, formula: '"法定期限,事務所通知期限,公司內部追蹤日期"' },
      ],
    },
    {
      name: SHEET_STATUS,
      header: true,
      rows: [['狀態名稱', '統計分組', '啟用'], ...statuses.map((s) => [s.name, STATUS_GROUP_LABEL[s.group], s.active ? '啟用' : '停用'])],
      colWidths: [24, 14, 8],
    },
    {
      name: SHEET_RULES,
      header: true,
      rows: [
        ['規則', '說明'],
        ['必填', '內部案件編號、專利名稱'],
        ['唯一', '內部案件編號不可重複'],
        ['日期', '申請日、核准日、公告日、下次確認日、重要期限：YYYY-MM-DD'],
        ['狀態', `目前案件狀態須為「${SHEET_STATUS}」中的名稱`],
        ['期限', '重要期限需人工確認；系統不自行推算法定期限'],
        ['區分', '申請案號 ≠ 專利證書號；提出申請不代表已取得專利權'],
        ['公式', '本檔不使用公式；請勿在資料欄輸入以 = 開頭的內容'],
      ],
      colWidths: [10, 70],
    },
    {
      name: SHEET_DICT,
      header: true,
      rows: [['欄位', '必填', '格式', '說明'], ...FIELDS.map((f) => [f.label, f.required ? '是' : '', f.kind === 'date' ? 'YYYY-MM-DD' : f.options ? f.options.join('／') : '文字', f.desc])],
      colWidths: [18, 6, 22, 60],
    },
    {
      name: SHEET_VERSION,
      header: true,
      rows: [
        ['項目', '內容'],
        ['資料格式版本', PATENT_FORMAT_VERSION],
        ['匯出系統', '法眼 LegalEye'],
        ['匯出時間', now.toLocaleString('zh-TW', { hour12: false })],
        ['案件筆數', String(list.length)],
        ['說明', '請以此檔作為主檔，更新後重新匯入。網頁不會修改原始 Excel。'],
      ],
      colWidths: [16, 60],
    },
  ]);
}

export function exportPatentCsv(list: Patent[]): string {
  return toCsv([FIELDS.map((f) => f.label), ...list.map((p) => FIELDS.map((f) => p[f.key]))]);
}

export function demoPatents(): Patent[] {
  const t = new Date();
  const f = (d: number) => {
    const x = new Date(t.getFullYear(), t.getMonth(), t.getDate() + d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };
  const base = emptyPatent();
  const stamp = new Date().toISOString();
  return [
    { ...base, id: 'DEMO-001', name: '模組化節能裝置（示範）', type: '發明', applicant: '示範股份有限公司', inventors: '示範甲、示範乙', appNo: '115100000', appDate: f(-200), status: '審查中', owner: '法務室', firm: '示範專利事務所', nextCheck: f(5), deadline: f(25), deadlineType: '事務所通知期限', note: '此為虛構示範資料', updatedAt: stamp },
    { ...base, id: 'DEMO-002', name: '人機介面圖像設計（示範）', type: '設計', appNo: '115300000', appDate: f(-90), status: '收到補正或審查意見', owner: '承辦甲', firm: '示範專利事務所', nextCheck: f(-3), deadline: f(6), deadlineType: '法定期限', note: '期限須依官方通知人工確認', updatedAt: stamp },
    { ...base, id: 'DEMO-003', name: '線材固定結構（示範）', type: '新型', status: '內部資料準備中', owner: '承辦乙', nextCheck: f(40), deadlineType: '', updatedAt: stamp },
    { ...base, id: 'DEMO-004', name: '散熱模組（示範）', type: '發明', appNo: '114100001', certNo: 'I800000', appDate: f(-700), grantDate: f(-60), pubDate: f(-30), status: '已公告', owner: '法務室', updatedAt: stamp },
  ];
}
