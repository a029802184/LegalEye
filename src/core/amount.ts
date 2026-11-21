// 金額解析：阿拉伯數字、千分位、NT$、中文小寫／大寫數字（含〇、零、兩、貳、元整）。
// 以「分」為單位的 BigInt 表示，避免浮點誤差。

const DIGIT: Record<string, number> = {
  零: 0, 〇: 0, '○': 0, Ｏ: 0,
  一: 1, 壹: 1, 弌: 1,
  二: 2, 貳: 2, 贰: 2, 兩: 2, 两: 2,
  三: 3, 參: 3, 叁: 3, 参: 3,
  四: 4, 肆: 4,
  五: 5, 伍: 5,
  六: 6, 陸: 6, 陆: 6,
  七: 7, 柒: 7,
  八: 8, 捌: 8,
  九: 9, 玖: 9,
};
const SMALL_UNIT: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };
const BIG_UNIT: Record<string, bigint> = { 萬: 10000n, 万: 10000n, 億: 100000000n, 亿: 100000000n };

export const CN_NUM_CHARS = '零〇○一壹弌二貳贰兩两三參叁参四肆五伍六陸陆七柒八捌九玖十拾百佰千仟萬万億亿';

/**
 * 中文數字 → 整數（BigInt）。無法解析回傳 null。
 * 支援：一萬四千二百七十六、壹萬肆仟貳佰柒拾陸、參萬零捌佰零貳、十五、一一四（逐位）。
 */
export function parseChineseInt(input: string): bigint | null {
  const s = input.replace(/[\s,，]/g, '');
  if (!s) return null;
  for (const ch of s) {
    if (!(ch in DIGIT) && !(ch in SMALL_UNIT) && !(ch in BIG_UNIT)) return null;
  }
  // 逐位寫法（如 一一四 = 114，〇七 = 7）：無任何單位
  if (![...s].some((c) => c in SMALL_UNIT || c in BIG_UNIT)) {
    let v = 0n;
    for (const ch of s) v = v * 10n + BigInt(DIGIT[ch]);
    return v;
  }
  let yi = 0n; // 億以上
  let wan = 0n; // 萬～億之間
  let section = 0n; // 萬以下的累計
  let num = -1; // 尚未乘上單位的數字
  for (const ch of s) {
    if (ch in DIGIT) {
      num = DIGIT[ch];
    } else if (ch in SMALL_UNIT) {
      const u = BigInt(SMALL_UNIT[ch]);
      section += (num === -1 ? 1n : BigInt(num)) * u;
      num = -1;
    } else if (ch in BIG_UNIT) {
      section += num === -1 ? 0n : BigInt(num);
      if (BIG_UNIT[ch] === 10000n) {
        wan += section * 10000n;
      } else {
        yi = (yi + wan + section) * 100000000n;
        wan = 0n;
      }
      section = 0n;
      num = -1;
    }
  }
  section += num === -1 ? 0n : BigInt(num);
  return yi + wan + section;
}

export interface Amount {
  /** 以「分」計（1 元 = 100） */
  cents: bigint;
  raw: string;
  index: number;
  form: 'arabic' | 'chinese';
}

export function centsToString(c: bigint): string {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const yuan = abs / 100n;
  const rem = abs % 100n;
  const intStr = yuan.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + intStr + (rem ? '.' + rem.toString().padStart(2, '0') : '');
}

export function parseArabicAmount(raw: string): bigint | null {
  const s = raw.normalize('NFKC').replace(/[,，\s]/g, '').replace(/^(NT\$|NTD|\$)/i, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const neg = s.startsWith('-');
  const [i, d = ''] = s.replace('-', '').split('.');
  const v = BigInt(i) * 100n + BigInt((d + '00').slice(0, 2));
  return neg ? -v : v;
}

/** 任意金額字串（阿拉伯或中文）→ 分；不確定回傳 null */
export function parseAmount(raw: string): bigint | null {
  const s = raw
    .normalize('NFKC')
    .replace(/新[臺台]幣|NT\$|NTD|元整|元正|圓整|元|圓|整|正/gi, '')
    .trim();
  if (!s) return null;
  if (/^[\d,，.\s-]+$/.test(s)) return parseArabicAmount(s);
  const v = parseChineseInt(s);
  return v === null ? null : v * 100n;
}

const ARABIC_RE = /(?:新[臺台]幣|NT\$|NTD)?\s*(-?\d{1,3}(?:[,，]\d{3})+(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)\s*元/g;
const CHINESE_RE = new RegExp(`(?:新[臺台]幣)?\\s*([${CN_NUM_CHARS}]{2,})\\s*(?:元整|元|圓整|圓)`, 'g');
const NT_RE = /(?:NT\$|NTD|新[臺台]幣)\s*(-?\d{1,3}(?:[,，]\d{3})+(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)(?!\s*元)/g;

/** 找出文字中所有金額（需帶「元」或 NT$／新臺幣標示，避免把案號、日期當金額） */
export function findAmounts(text: string): Amount[] {
  const t = text.normalize('NFKC');
  const out: Amount[] = [];
  for (const m of t.matchAll(ARABIC_RE)) {
    const v = parseArabicAmount(m[1]);
    if (v !== null) out.push({ cents: v, raw: m[0].trim(), index: m.index ?? 0, form: 'arabic' });
  }
  for (const m of t.matchAll(NT_RE)) {
    const v = parseArabicAmount(m[1]);
    const idx = m.index ?? 0;
    if (v !== null && !out.some((a) => Math.abs(a.index - idx) < 3)) out.push({ cents: v, raw: m[0].trim(), index: idx, form: 'arabic' });
  }
  for (const m of t.matchAll(CHINESE_RE)) {
    const v = parseChineseInt(m[1]);
    if (v !== null) out.push({ cents: v * 100n, raw: m[0].trim(), index: m.index ?? 0, form: 'chinese' });
  }
  return out.sort((a, b) => a.index - b.index);
}

export type AmountKind =
  | 'principal'
  | 'fee'
  | 'exec-fee'
  | 'paid'
  | 'total'
  | 'interest'
  | 'penalty'
  | 'balance'
  | 'current-bill'
  | 'other';

export const AMOUNT_KIND_LABEL: Record<AmountKind, string> = {
  principal: '本金／請求金額',
  fee: '程序費用',
  'exec-fee': '執行費',
  paid: '已繳／已清償',
  total: '總額',
  interest: '利息',
  penalty: '違約金',
  balance: '未償餘額',
  'current-bill': '本期應繳',
  other: '其他',
};

const KIND_KEYWORDS: [AmountKind, RegExp][] = [
  ['current-bill', /本期應繳|本期帳單|本期金額/],
  ['paid', /已繳|已清償|部分清償|已付|扣除|折抵|沖抵|減除/],
  ['exec-fee', /執行費/],
  ['fee', /程序費|督促程序費用|裁判費|手續費/],
  ['interest', /利息/],
  ['penalty', /違約金/],
  ['balance', /未償|尚欠|餘額|總欠費|欠費總額|未清償/],
  ['total', /總計|合計|共計|總額|應繳總額/],
  ['principal', /本金|請求金額|聲請金額|給付|債權金額|欠款|請求|應向債權人清償/],
];

/** 依金額前方文字判斷金額性質；只看同一句（遇句號、分號停止） */
export function classifyAmount(text: string, a: Amount): AmountKind {
  const before = text.normalize('NFKC').slice(Math.max(0, a.index - 22), a.index);
  const clause = before.split(/[。；;\n]/).pop() ?? '';
  let best: AmountKind = 'other';
  let bestPos = -1;
  for (const [kind, re] of KIND_KEYWORDS) {
    const g = new RegExp(re.source, 'g');
    for (const m of clause.matchAll(g)) {
      const pos = (m.index ?? 0) + m[0].length;
      if (pos > bestPos) {
        bestPos = pos;
        best = kind;
      }
    }
  }
  return best;
}

export interface LabeledAmount extends Amount {
  kind: AmountKind;
}

export function findLabeledAmounts(text: string): LabeledAmount[] {
  return findAmounts(text).map((a) => ({ ...a, kind: classifyAmount(text, a) }));
}

/** 中文金額旁緊接（括號內）阿拉伯數字的配對，例如「壹萬肆仟元（14,000元）」 */
export function findAmountPairs(text: string): { chinese: Amount; arabic: Amount }[] {
  const t = text.normalize('NFKC');
  const all = findAmounts(text);
  const pairs: { chinese: Amount; arabic: Amount }[] = [];
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i];
    const b = all[i + 1];
    // 兩者之間只能有空白或左括號，例如「壹萬元（10,000元）」
    const gap = t.slice(a.index + a.raw.length, b.index);
    if (a.form !== b.form && /^[\s(（]*$/.test(gap)) {
      pairs.push(a.form === 'chinese' ? { chinese: a, arabic: b } : { chinese: b, arabic: a });
      i++;
    }
  }
  return pairs;
}

/** 驗算「A - B = C」「A + B = C」形式的算式 */
export function findArithmetic(text: string): { expr: string; ok: boolean; expected: bigint; stated: bigint; index: number }[] {
  const t = text.normalize('NFKC');
  const num = '(\\d{1,3}(?:,\\d{3})+|\\d+)';
  const re = new RegExp(`${num}(?:\\s*元)?((?:\\s*[-−－+＋]\\s*${num}(?:\\s*元)?)+)\\s*[=＝]\\s*${num}`, 'g');
  const out: { expr: string; ok: boolean; expected: bigint; stated: bigint; index: number }[] = [];
  for (const m of t.matchAll(re)) {
    let acc = parseArabicAmount(m[1]) ?? 0n;
    for (const op of m[2].matchAll(new RegExp(`([-−－+＋])\\s*${num}`, 'g'))) {
      const v = parseArabicAmount(op[2]) ?? 0n;
      acc = /[+＋]/.test(op[1]) ? acc + v : acc - v;
    }
    const stated = parseArabicAmount(m[m.length - 1]) ?? 0n;
    out.push({ expr: m[0], ok: acc === stated, expected: acc, stated, index: m.index ?? 0 });
  }
  return out;
}
