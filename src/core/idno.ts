// 中華民國身分證字號（含新式居留證）格式與檢查碼。
// 檢查碼通過只代表「格式合理」，不代表確屬本人。

const LETTER_CODE: Record<string, number> = {
  A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, G: 16, H: 17, I: 34, J: 18, K: 19, L: 20, M: 21,
  N: 22, O: 35, P: 23, Q: 24, R: 25, S: 26, T: 27, U: 28, V: 29, W: 32, X: 30, Y: 31, Z: 33,
};

export const ID_RE = /[A-Z][1289]\d{8}/g;
/** 遮罩寫法，例如 A12345****、A1****6789、A123***789 */
export const MASKED_ID_RE = /[A-Z][1289O*＊Ｏ○●Xx]?[\d*＊OＯ○●Xx]{7,8}/g;

export function validateTwId(id: string): boolean {
  const s = id.normalize('NFKC').toUpperCase().trim();
  if (!/^[A-Z][1289]\d{8}$/.test(s)) return false;
  const code = LETTER_CODE[s[0]];
  const digits = [Math.floor(code / 10), code % 10, ...s.slice(1).split('').map(Number)];
  const weights = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i], 0);
  return sum % 10 === 0;
}

export function isMasked(id: string): boolean {
  return /[*＊OＯ○●Xx]/.test(id.slice(1));
}

export function maskId(id: string): string {
  const s = id.normalize('NFKC').trim();
  if (s.length < 6) return s.replace(/./g, '*');
  return s.slice(0, 2) + '*'.repeat(s.length - 5) + s.slice(-3);
}

/**
 * 比對身分證字號：遮罩時只比可見位數。
 * 回傳 full＝全碼一致、partial＝可見部分一致、mismatch、unknown（無法比較）
 */
export function compareIds(a: string, b: string): 'full' | 'partial' | 'mismatch' | 'unknown' {
  const x = a.normalize('NFKC').toUpperCase().replace(/\s/g, '');
  const y = b.normalize('NFKC').toUpperCase().replace(/\s/g, '');
  if (!x || !y || x.length !== y.length) return x && y && !isMasked(x) && !isMasked(y) ? 'mismatch' : 'unknown';
  const masked = isMasked(x) || isMasked(y);
  let visible = 0;
  for (let i = 0; i < x.length; i++) {
    const mx = /[*＊OＯ○●X]/.test(x[i]) && i > 0;
    const my = /[*＊OＯ○●X]/.test(y[i]) && i > 0;
    if (mx || my) continue;
    if (x[i] !== y[i]) return 'mismatch';
    visible++;
  }
  if (!masked) return 'full';
  return visible >= 4 ? 'partial' : 'unknown';
}

export function maskAccount(acc: string): string {
  const s = acc.replace(/\s/g, '');
  if (s.length <= 4) return '****';
  return '*'.repeat(s.length - 4) + s.slice(-4);
}
