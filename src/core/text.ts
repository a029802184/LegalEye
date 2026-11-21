// 文字正規化工具：全半形、臺／台、空白。不做「模糊視為相同」的處理。

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

/** 地址正規化：全半形、空白、郵遞區號、臺台；保留門牌樓層等差異 */
export function normAddress(s: string): string {
  return stripSpaces(s)
    .replace(/^\d{3,6}/, '')
    .replace(/臺/g, '台')
    .replace(/之(\d)/g, '之$1')
    .replace(/-/g, '之')
    .replace(/[,，、]/g, '');
}

export function compareAddress(a: string, b: string): { equal: boolean; diffAt?: number } {
  const na = normAddress(a);
  const nb = normAddress(b);
  if (na === nb) return { equal: true };
  let i = 0;
  while (i < na.length && i < nb.length && na[i] === nb[i]) i++;
  return { equal: false, diffAt: i };
}

export function uid(prefix = 'id'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}
