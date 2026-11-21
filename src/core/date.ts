// 日期工具：民國年／西元年／中文數字年份。只用「年月日」整數運算，
// 以 UTC 計算日差，避免瀏覽器時區造成一天偏移。

import { parseChineseInt, CN_NUM_CHARS } from './amount';

export interface YMD {
  y: number; // 西元年
  m: number;
  d: number;
}

export function isValidYMD(v: YMD): boolean {
  if (!Number.isInteger(v.y) || !Number.isInteger(v.m) || !Number.isInteger(v.d)) return false;
  if (v.m < 1 || v.m > 12 || v.d < 1) return false;
  const dt = new Date(Date.UTC(v.y, v.m - 1, v.d));
  return dt.getUTCFullYear() === v.y && dt.getUTCMonth() === v.m - 1 && dt.getUTCDate() === v.d;
}

export function addDays(v: YMD, n: number): YMD {
  const dt = new Date(Date.UTC(v.y, v.m - 1, v.d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function diffDays(a: YMD, b: YMD): number {
  return Math.round((Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d)) / 86400000);
}

export function sameDay(a: YMD | null | undefined, b: YMD | null | undefined): boolean {
  return !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d;
}

export function fmtROC(v: YMD): string {
  return `${v.y - 1911}年${v.m}月${v.d}日`;
}

export function fmtISO(v: YMD): string {
  return `${v.y}-${String(v.m).padStart(2, '0')}-${String(v.d).padStart(2, '0')}`;
}

export function fmtBoth(v: YMD): string {
  return `${fmtROC(v)}（${fmtISO(v)}）`;
}

export function parseISO(s: string): YMD | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim());
  if (!m) return null;
  const v = { y: +m[1], m: +m[2], d: +m[3] };
  return isValidYMD(v) ? v : null;
}

/** 依臺灣時區（UTC+8）取得「今天」 */
export function todayTW(now: Date = new Date()): YMD {
  const t = new Date(now.getTime() + 8 * 3600 * 1000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function toNum(s: string): number | null {
  const t = s.normalize('NFKC').trim();
  if (/^\d+$/.test(t)) return Number(t);
  const v = parseChineseInt(t);
  return v === null ? null : Number(v);
}

export interface FoundDate {
  value: YMD;
  raw: string;
  index: number;
  valid: boolean;
}

const N = `[\\d${CN_NUM_CHARS}]`;
const DATE_RE = new RegExp(
  `(?:(民國|中華民國|西元)\\s*)?(${N}{2,4})\\s*年\\s*(${N}{1,3})\\s*月\\s*(${N}{1,3})\\s*日` +
    `|(\\d{4})[/.-](\\d{1,2})[/.-](\\d{1,2})` +
    `|(\\d{2,3})[/.](\\d{1,2})[/.](\\d{1,2})`,
  'g',
);

/** 找出文字中的日期。2–3 位數年份視為民國年，4 位數視為西元年。 */
export function findDates(text: string): FoundDate[] {
  const t = text.normalize('NFKC');
  const out: FoundDate[] = [];
  for (const m of t.matchAll(DATE_RE)) {
    let y: number | null;
    let mo: number | null;
    let d: number | null;
    let roc: boolean;
    if (m[2]) {
      y = toNum(m[2]);
      mo = toNum(m[3]);
      d = toNum(m[4]);
      roc = m[1] === '西元' ? false : y !== null && y < 1000;
    } else if (m[5]) {
      y = +m[5];
      mo = +m[6];
      d = +m[7];
      roc = false;
    } else {
      y = +m[8];
      mo = +m[9];
      d = +m[10];
      roc = true;
    }
    if (y === null || mo === null || d === null) continue;
    const value = { y: roc ? y + 1911 : y, m: mo, d };
    out.push({ value, raw: m[0], index: m.index ?? 0, valid: isValidYMD(value) });
  }
  return out;
}

export function parseDate(s: string): YMD | null {
  const iso = parseISO(s);
  if (iso) return iso;
  const f = findDates(s);
  return f.length && f[0].valid ? f[0].value : null;
}
