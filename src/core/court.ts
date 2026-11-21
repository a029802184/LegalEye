// 法院名稱與案號解析。年度、字別、案號數字必須精準比對；
// 「司執」與「司執助」、「司促」、「消債更」等為不同字別。

import { parseChineseInt, CN_NUM_CHARS } from './amount';
import { nfkc, stripSpaces } from './text';

export interface CaseNo {
  year: number;
  word: string;
  number: number;
  division?: string; // 股別
  raw: string;
  index: number;
  /** 是否為「發文字號」而非案件案號 */
  isDocRef: boolean;
}

const N = `[\\d${CN_NUM_CHARS}]`;
const CASE_RE = new RegExp(
  `(${N}{2,4})\\s*年度?\\s*([\\u4e00-\\u9fff]{1,6}?)\\s*字\\s*第\\s*(${N}{1,8})\\s*號(?:\\s*[（(]?\\s*([\\u4e00-\\u9fff]{1,2})股\\s*[)）]?)?`,
  'g',
);

function toInt(s: string): number | null {
  const t = nfkc(s);
  if (/^\d+$/.test(t)) return Number(t);
  const v = parseChineseInt(t);
  return v === null ? null : Number(v);
}

export function findCaseNumbers(text: string): CaseNo[] {
  const t = nfkc(text);
  const out: CaseNo[] = [];
  for (const m of t.matchAll(CASE_RE)) {
    const year = toInt(m[1]);
    const number = toInt(m[3]);
    if (year === null || number === null) continue;
    let word = m[2];
    // 去掉發文字號的機關簡稱前綴，如「北院英114司執助」中年度前的文字不在 m 內，
    // 但「年度」後可能殘留「度」；字別只保留常見字別字元
    word = word.replace(/^度/, '');
    const idx = m.index ?? 0;
    const before = t.slice(Math.max(0, idx - 14), idx);
    const isDocRef = /發文字號|字號[:：]?\s*\S{0,6}$/.test(before) && !/案號/.test(before);
    out.push({ year: year > 1000 ? year - 1911 : year, word, number, division: m[4], raw: m[0], index: idx, isDocRef });
  }
  return out;
}

export function caseKey(c: Pick<CaseNo, 'year' | 'word' | 'number'>): string {
  return `${c.year}-${c.word}-${c.number}`;
}

export function fmtCase(c: Pick<CaseNo, 'year' | 'word' | 'number' | 'division'>): string {
  return `${c.year}年度${c.word}字第${c.number}號${c.division ? `（${c.division}股）` : ''}`;
}

export function compareCase(a: CaseNo, b: CaseNo): { equal: boolean; diffs: string[] } {
  const diffs: string[] = [];
  if (a.year !== b.year) diffs.push(`年度 ${a.year}≠${b.year}`);
  if (a.word !== b.word) diffs.push(`字別「${a.word}」≠「${b.word}」`);
  if (a.number !== b.number) diffs.push(`案號 ${a.number}≠${b.number}`);
  return { equal: diffs.length === 0, diffs };
}

const COURT_RE = /(?:(?:臺灣|台灣|福建)\s*)?(?:[一-鿿]{2,3}\s*)(?:地方法院|高等法院(?:[一-鿿]{2}分院)?|少年及家事法院)|最高法院|智慧財產及商業法院/g;

export interface CourtName {
  raw: string;
  canonical: string;
  index: number;
}

// 常見簡稱 → 正式全名（可於規則設定擴充）
export const DEFAULT_COURT_ALIASES: Record<string, string> = {
  北院: '臺灣臺北地方法院',
  士院: '臺灣士林地方法院',
  新北院: '臺灣新北地方法院',
  桃院: '臺灣桃園地方法院',
  中院: '臺灣臺中地方法院',
  南院: '臺灣臺南地方法院',
  雄院: '臺灣高雄地方法院',
  金院: '福建金門地方法院',
};

export function canonicalCourt(raw: string, aliases: Record<string, string> = DEFAULT_COURT_ALIASES): string {
  let s = stripSpaces(raw).replace(/台/g, '臺');
  if (aliases[s]) s = aliases[s];
  // 補上「臺灣」前綴（福建金門／連江除外）
  if (/地方法院$/.test(s) && !/^(臺灣|福建)/.test(s)) {
    s = (/^(金門|連江)/.test(s) ? '福建' : '臺灣') + s;
  }
  return s;
}

export function findCourts(text: string, aliases?: Record<string, string>): CourtName[] {
  const t = nfkc(text);
  const out: CourtName[] = [];
  for (const m of t.matchAll(COURT_RE)) {
    out.push({ raw: m[0], canonical: canonicalCourt(m[0], aliases), index: m.index ?? 0 });
  }
  return out;
}
