// 欄位抽取：姓名、身分證、地址、編號、利率、帳號、門號、附件引用。
// 每個抽取值都保留在原文中的位置，供 provenance 使用。

import { stripSpaces } from './text';

export interface Hit {
  value: string;
  raw: string;
  index: number;
}

const NAME_STOP = /^(應|於|之|所|等|對|自|即|如|已|未|向|給|為|名|姓|住|身|部|間|方|及|與|並|就|均|該|本|共)/;
const NAME_TRAIL = /(住所?|住址|身分證.*|統一編號.*|地址|電話|應給付.*|應|於|等|即$|因|之|聲請.*|欠款.*|即日.*)$/;

// 姓名後方常見的接續字（遇到即視為姓名結束）
// 另含戶籍謄本常見的欄位起首字（統一編號、出生、性別、稱謂、戶籍、電話、地址），處理 OCR 無空白的情況
const AFTER_NAME = new Set('即原更應於住身等因與及並為對向給自已未所之間統出性稱戶電地（(,，、.。；:：0123456789 \n\t'.split(''));

/** 從字串開頭切出一個 2–4 字姓名；優先 3 字（最常見），再 2 字、4 字 */
export function takeName(s: string): string | null {
  for (const len of [3, 2, 4]) {
    if (s.length < len) continue;
    const cand = s.slice(0, len);
    if (!/^[一-鿿]+$/.test(cand)) continue;
    if (s.length === len || AFTER_NAME.has(s[len])) return cand;
  }
  // 找不到明確邊界時，以最常見的 3 字姓名為準（後續比對仍會顯示原文供人工確認）
  return /^[一-鿿]{3}/.test(s) ? s.slice(0, 3) : null;
}

/** 債務人／相對人姓名（含「即」「原名」別名） */
export function findDebtorNames(text: string): Hit[] {
  const out: Hit[] = [];
  const t = text.normalize('NFKC');
  const re = /(?:債務人|相對人)(?:\s*姓名)?\s*[:：]?\s*/g;
  for (const m of t.matchAll(re)) {
    const start = (m.index ?? 0) + m[0].length;
    const rest = t.slice(start, start + 24);
    if (NAME_STOP.test(rest)) continue;
    const name = takeName(rest);
    if (!name) continue;
    let value = name;
    let raw = m[0] + name;
    const alias = /^\s*[（(]?\s*(即|原名|更名前)\s*/.exec(rest.slice(name.length));
    if (alias) {
      const after = rest.slice(name.length + alias[0].length);
      const n2 = takeName(after);
      if (n2) {
        value = `${name}${alias[1]}${n2}`;
        raw += alias[0] + n2;
      }
    }
    out.push({ value: value.replace(NAME_TRAIL, '') || value, raw, index: start });
  }
  return out;
}

export function findCreditorNames(text: string): Hit[] {
  const out: Hit[] = [];
  const re = /(?:債權人|聲請人)\s*[:：]?\s*([一-鿿()（）A-Za-z0-9]{2,30}?(?:股份有限公司|有限公司|公司|銀行|合作社))/g;
  for (const m of text.normalize('NFKC').matchAll(re)) {
    out.push({ value: stripSpaces(m[1]), raw: m[0], index: (m.index ?? 0) + m[0].indexOf(m[1]) });
  }
  return out;
}

/** 戶籍謄本等「姓名：王小明」形式 */
export function findLabeledNames(text: string): Hit[] {
  const out: Hit[] = [];
  const t = text.normalize('NFKC');
  for (const m of t.matchAll(/姓\s*名\s*[:：]?\s*/g)) {
    const start = (m.index ?? 0) + m[0].length;
    const name = takeName(t.slice(start, start + 8)) ?? /^[一-鿿]{2,4}/.exec(t.slice(start, start + 4))?.[0] ?? null;
    if (name) out.push({ value: name, raw: m[0] + name, index: start });
  }
  return out;
}

export function findIds(text: string): Hit[] {
  const out: Hit[] = [];
  const t = text.normalize('NFKC').toUpperCase();
  const re = /(?<![A-Z0-9])([A-Z][1289][\d*＊O○●X]{8})(?![A-Z0-9])/g;
  for (const m of t.matchAll(re)) out.push({ value: m[1], raw: m[0], index: m.index ?? 0 });
  return out;
}

const ADDR_RE = /(?:戶籍地址|戶籍地|住居所|住所|住址|地址|住)\s*[:：]?\s*((?:\d{3,6}\s*)?[一-鿿\d０-９\-－之號樓巷弄段鄰里路街村\s]{6,60}?(?:號(?:之\d+)?(?:\d+樓(?:之\d+)?)?|樓(?:之\d+)?))/g;

export function findAddresses(text: string): Hit[] {
  const out: Hit[] = [];
  for (const m of text.normalize('NFKC').matchAll(ADDR_RE)) {
    const v = m[1].trim();
    if (!/[市縣]/.test(v) || !/號/.test(v)) continue;
    out.push({ value: v, raw: m[0], index: (m.index ?? 0) + m[0].indexOf(m[1]) });
  }
  return out;
}

export function findSerials(text: string): Hit[] {
  const out: Hit[] = [];
  const re = /(?:申請編號|案件編號|流水號|客戶編號|帳戶編號|合約編號|用戶編號|契約編號)\s*[:：]?\s*([A-Z0-9][A-Z0-9-]{3,20})/gi;
  for (const m of text.normalize('NFKC').matchAll(re)) out.push({ value: m[1].toUpperCase(), raw: m[0], index: (m.index ?? 0) + m[0].indexOf(m[1]) });
  return out;
}

export function findPhones(text: string): Hit[] {
  const out: Hit[] = [];
  for (const m of text.normalize('NFKC').matchAll(/(?<!\d)(09\d{2})[-\s]?(\d{3})[-\s]?(\d{3})(?!\d)/g)) {
    out.push({ value: m[1] + m[2] + m[3], raw: m[0], index: m.index ?? 0 });
  }
  return out;
}

export function findBankAccounts(text: string): Hit[] {
  const out: Hit[] = [];
  for (const m of text.normalize('NFKC').matchAll(/(?:帳號|帳戶|匯款帳號)\s*[:：]?\s*(\d[\d-]{7,22}\d)/g)) {
    out.push({ value: m[1].replace(/-/g, ''), raw: m[0], index: (m.index ?? 0) + m[0].indexOf(m[1]) });
  }
  return out;
}

/** 年利率（回傳百分比數值字串，如 "16" 或 "5"） */
export function findRates(text: string): Hit[] {
  const out: Hit[] = [];
  const t = text.normalize('NFKC');
  const re = /(?:週年利率|年利率|年息|週年息|利率)\s*(?:百分之\s*([\d一二三四五六七八九十點.]+)|([\d.]+)\s*%)/g;
  const cn: Record<string, string> = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 點: '.' };
  for (const m of t.matchAll(re)) {
    let v = m[1] ?? m[2] ?? '';
    if (m[1] && /[一二三四五六七八九十]/.test(v)) {
      // 簡易中文百分比：十六 → 16、五 → 5、十 → 10、二十 → 20
      const s = v;
      if (/^十/.test(s)) v = '1' + (cn[s[1]] ?? '0');
      else if (/^.十$/.test(s)) v = cn[s[0]] + '0';
      else if (/^.十.$/.test(s)) v = cn[s[0]] + cn[s[2]];
      else v = s.split('').map((c) => cn[c] ?? c).join('');
    }
    out.push({ value: String(Number(v)), raw: m[0], index: m.index ?? 0 });
  }
  return out;
}

/** 書狀中引用的附件／附表／證物 */
export interface AttachmentRef {
  label: string; // 附件一、證物2
  seq: string;
  name: string;
  count?: number;
  raw: string;
  index: number;
}

const CN_SEQ: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

export function seqToNumber(seq: string): number | null {
  const s = seq.normalize('NFKC');
  if (/^\d+$/.test(s)) return Number(s);
  if (s in CN_SEQ) return CN_SEQ[s];
  if (/^十[一二三四五六七八九]$/.test(s)) return 10 + CN_SEQ[s[1]];
  return null;
}

export function findAttachmentRefs(text: string): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  const t = text.normalize('NFKC');
  const re = /(附件|附表|證物|原證|附證)\s*([一二三四五六七八九十\d]{1,3})\s*[:：、.]?\s*([^\n，。；;:：、]{2,40})/g;
  for (const m of t.matchAll(re)) {
    let name = m[3].trim();
    let count: number | undefined;
    const cm = /[（(]?\s*(?:共|各)?\s*([\d一二三四五六七八九十]+)\s*(?:份|件|張|頁)\s*[)）]?$/.exec(name);
    if (cm) {
      count = seqToNumber(cm[1]) ?? undefined;
      name = name.slice(0, cm.index).trim();
    }
    name = name.replace(/^[「『]|[」』]$/g, '').replace(/(影本|正本|乙份|一份)$/, '').trim();
    if (!name) continue;
    out.push({ label: m[1] + m[2], seq: m[2], name, count, raw: m[0], index: m.index ?? 0 });
  }
  // 同一附件在文中多次出現時只保留第一次（並保留有份數者）
  const map = new Map<string, AttachmentRef>();
  for (const a of out) {
    const k = a.label;
    const prev = map.get(k);
    if (!prev || (prev.count === undefined && a.count !== undefined)) map.set(k, a);
  }
  return [...map.values()];
}
