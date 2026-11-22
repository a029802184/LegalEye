// 文字正規化工具：全半形、臺／台、空白。
import { CN_NUM_CHARS, parseChineseInt } from './amount';

export function nfkc(s: string): string {
  return String(s ?? '').normalize('NFKC');
}

/** 去除所有空白（含全形空白）與零寬字元 */
export function stripSpaces(s: string): string {
  return nfkc(s).replace(/[\s​-‍﻿　]+/g, '');
}

/** 一般比對用：NFKC、去空白、臺→台、統一常見標點 */
export function normLoose(s: string): string {
  return stripSpaces(s)
    .replace(/臺/g, '台')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[：]/g, ':')
    .toLowerCase();
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** 擷取字串前後文，供證據顯示 */
export function snippet(text: string, index: number, len: number, pad = 18): string {
  const s = Math.max(0, index - pad);
  const e = Math.min(text.length, index + len + pad);
  return (s > 0 ? '…' : '') + text.slice(s, e).replace(/\s+/g, ' ') + (e < text.length ? '…' : '');
}

/** 姓名比對結果 */
export type NameCompare = 'exact' | 'alias' | 'variant-suspect' | 'different';

// 常見異體字／易混字（僅作為「疑慮」提示，不自動視為一致）
const VARIANT_PAIRS: [string, string][] = [
  ['台', '臺'],
  ['峰', '峯'],
  ['群', '羣'],
  ['麵', '麪'],
  ['裡', '裏'],
  ['著', '着'],
  ['綫', '線'],
  ['陳', '陣'],
  ['明', '名'],
  ['淑', '叔'],
  ['惠', '慧'],
  ['玲', '鈴'],
  ['偉', '瑋'],
  ['銘', '明'],
  ['姍', '珊'],
];

export function isVariantChar(a: string, b: string): boolean {
  return VARIANT_PAIRS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

/**
 * 解析「王小明即王大明」「王小明（原名王大明）」等寫法，回傳所有名稱。
 */
export function nameAliases(raw: string): string[] {
  const s = stripSpaces(raw).replace(/[()（）]/g, ' ');
  const parts = s.split(/即|原名|更名前|更名為|又名|\s+/).map((x) => x.trim()).filter(Boolean);
  return [...new Set(parts)];
}

export function compareNames(a: string, b: string): NameCompare {
  const na = stripSpaces(a);
  const nb = stripSpaces(b);
  if (!na || !nb) return 'different';
  if (na === nb) return 'exact';
  const aa = nameAliases(a);
  const bb = nameAliases(b);
  if (aa.some((x) => bb.includes(x))) return 'alias';
  if (na.length === nb.length) {
    let diff = 0;
    let variantOnly = true;
    for (let i = 0; i < na.length; i++) {
      if (na[i] !== nb[i]) {
        diff++;
        if (!isVariantChar(na[i], nb[i])) variantOnly = false;
      }
    }
    if (diff === 1 || (diff > 0 && variantOnly)) return 'variant-suspect';
  }
  return 'different';
}

const ADDRESS_NUM = new RegExp(`(?<![\\d${CN_NUM_CHARS}])(\\d+|[${CN_NUM_CHARS}]+)(鄰|段|巷|弄|號|樓|室)`, 'g');
const ADDRESS_PARTS: Record<string, string> = { 鄰: '鄰號', 段: '路段', 巷: '巷號', 弄: '弄號', 號: '門牌', 樓: '樓層', 室: '房號' };

/** 只處理行政地址位置有明確語義的數字。保留房號、附號與連字號的原有寫法。 */
export function normAddress(s: string): string {
  return stripSpaces(s)
    .replace(/^(?:\d{6}|\d{5}|\d{3})(?=(?:[臺台]灣省|福建省)?[\p{Script=Han}]{1,3}[市縣])/u, '')
    .replace(/臺/g, '台')
    .replace(/[,，、]/g, '')
    .replace(ADDRESS_NUM, (raw, value: string, suffix: string) => {
      if (suffix === '室') return raw;
      if (/^\d+$/.test(value)) return `${suffix === '鄰' ? value.replace(/^0+(?=\d)/, '') : value}${suffix}`;
      const parsed = parseChineseInt(value);
      return parsed === null ? raw : `${parsed}${suffix}`;
    });
}

export function compareAddress(a: string, b: string, scan = false): {
  equal: boolean;
  state: 'exactMatch' | 'normalizedEquivalent' | 'suspectedOcrError' | 'confirmedMismatch' | 'insufficientEvidence';
  diffAt?: number;
  detail: string;
} {
  const na = normAddress(a);
  const nb = normAddress(b);
  if (!na || !nb) return { equal: false, state: 'insufficientEvidence', detail: '尚未取得可比對的地址' };
  if (na === nb) return a === b ? { equal: true, state: 'exactMatch', detail: '地址一致' }
    : { equal: true, state: 'normalizedEquivalent', detail: '寫法不同，但地址相同（已統一郵遞區號、鄰號、國字數字或空白等格式）' };
  let i = 0;
  while (i < na.length && i < nb.length && na[i] === nb[i]) i++;
  const parts = (value: string) => new Map([...value.matchAll(/(\d+(?:[之-]\d+)?)(鄰|段|巷|弄|號|樓|室)/g)].map((m) => [m[2], m[1] + m[2]]));
  const pa = parts(na);
  const pb = parts(nb);
  const differences = Object.entries(ADDRESS_PARTS).filter(([unit]) => pa.get(unit) !== pb.get(unit))
    .map(([unit, label]) => `${label}（${pa.get(unit) ?? '未讀到'}／${pb.get(unit) ?? '未讀到'}）`);
  const location = differences.length ? differences.join('、') : `行政區、路名或附號（自第 ${i + 1} 字有差異）`;
  return scan ? { equal: false, state: 'suspectedOcrError', diffAt: i, detail: `請看原件確認${location}，掃描辨識可能有誤` }
    : { equal: false, state: 'confirmedMismatch', diffAt: i, detail: `兩份文件的${location}不同` };
}

export function uid(prefix = 'id'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}
