// 欄位抽取：姓名、身分證、地址、編號、利率、帳號、門號、附件引用。
// 每個抽取值都保留在原文中的位置，供 provenance 使用。

import { stripSpaces } from './text';

export interface Hit {
  value: string;
  raw: string;
  index: number;
}

const NAME_STOP = /^(收取|清償|支付|履行|財產|國民身分證|應|於|之|所|等|對|自|即|如|已|未|向|給|為|名|姓|住|身|部|間|方|及|與|並|就|均|該|本|共)/;
const NAME_TRAIL = /(住所?|住址|身[分份]證.*|統一編號.*|地址|電話|應給付.*|聲請.*|欠款.*|即日.*)$/;
const ID_LABEL = String.raw`(?:國\s*民\s*)?身\s*[分份]\s*[證証](?:\s*統\s*一)?(?:\s*[編字]\s*號)?|統\s*一\s*[編字]\s*號`;
const HOUSEHOLD_FIELD = new RegExp(`${ID_LABEL}|國\\s*民(?=\\s*(?:$|[:：]|\\n))|出\\s*生(?:\\s*日\\s*期)?|性\\s*別|稱\\s*謂|戶\\s*籍|戶\\s*長|(?:父|母)(?:親|姓名)\\s*[:：]|配\\s*偶|電\\s*話|住\\s*址|地\\s*址|姓\\s*名`);
const NAME_VALUE = /^[\p{Script=Han}]{2,6}(?:[·・][\p{Script=Han}]{1,6})?$/u;

// 姓名後方常見的接續字（遇到即視為姓名結束）
// 另含戶籍謄本常見的欄位起首字（統一編號、出生、性別、稱謂、戶籍、電話、地址），處理 OCR 無空白的情況
const AFTER_NAME = new Set('即原更應於住身等因與及並為對向給自已未所之間統出性稱戶電地（(】」,，、.。；:：0123456789 \n\t'.split(''));

/** 從字串開頭切出一個 2–4 字姓名；優先 3 字（最常見），再 2 字、4 字 */
export function takeName(s: string): string | null {
  const bounded = stripSpaces(s.split(HOUSEHOLD_FIELD, 1)[0].split(/(?:[\n\r:：,，;；|\d()（）】」]|原名|更名前|間(?=\s*\d{2,4}年)|即(?=\s*[\p{Script=Han}]))/u, 1)[0]);
  if (bounded.length <= 4 && NAME_VALUE.test(bounded)) return bounded;
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
  const re = /(?:債務人|相對人)(?:\s*姓名)?\s*[:：]?\s*[【「]?\s*/g;
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

/** 戶籍謄本等有標籤的姓名，只接受姓名欄的字元，不猜取下一欄。 */
export function labeledNameFields(text: string): { index: number; name?: Hit }[] {
  const out: { index: number; name?: Hit }[] = [];
  const t = text.normalize('NFKC');
  for (const m of t.matchAll(/姓[ \t]*名[ \t]*[:：]?[ \t]*(?:\r?\n[ \t]*)?/g)) {
    const start = (m.index ?? 0) + m[0].length;
    const previous = t.slice(Math.max(0, (m.index ?? 0) - 10), m.index ?? 0);
    if ((/(?:戶\s*長|父(?:\s*親)?|母(?:\s*親)?|配\s*偶|家\s*長)[ \t]*$/.test(previous) && !/稱\s*謂/.test(previous))
      || /(?:原|曾用|更名前)[ \t]*$/.test(previous)) continue;
    const line = t.slice(start).split(/[\n\r]/, 1)[0];
    const raw = line.split(HOUSEHOLD_FIELD, 1)[0].split(/(?:[;；,，|:：]|[ \t]{2,}(?=\S))/, 1)[0].trim();
    const name = stripSpaces(raw);
    const valid = NAME_VALUE.test(name);
    out.push({ index: start, name: valid ? { value: name, raw, index: start } : undefined });
  }
  return out;
}

export function findLabeledNames(text: string): Hit[] {
  return labeledNameFields(text).flatMap(({ name }) => name ? [name] : []);
}

export function findIds(text: string): Hit[] {
  const out: Hit[] = [];
  const t = text.normalize('NFKC').toUpperCase();
  const re = /(?<![A-Z0-9])([A-Z][ \t]*[1289](?:[ \t]*[\d*O○●X]){8})(?![A-Z0-9])/g;
  for (const m of t.matchAll(re)) out.push({ value: stripSpaces(m[1]), raw: m[0], index: m.index ?? 0 });
  return out;
}

export function isLabeledId(text: string, index: number): boolean {
  return new RegExp(`(?:${ID_LABEL})[ \\t]*[:：]?[ \\t]*(?:\\r?\\n[ \\t]*)?$`).test(text.slice(Math.max(0, index - 48), index));
}

const ADDRESS_NO = '[0-9〇○零一二兩三四五六七八九十百千]+';
const ADDRESS_LABEL = /(?:戶[ \t]*籍[ \t]*(?:地[ \t]*址|地)|住[ \t]*居[ \t]*所|住[ \t]*所(?:[ \t]*地[ \t]*址)?|住[ \t]*址|地[ \t]*址|住(?=[ \t]*[:：]))[ \t]*[:：]?[ \t]*/g;
const ADDR_RE = new RegExp(`^((?:\\d{6}|\\d{5}|\\d{3})?(?:[臺台]灣省|福建省)?[\\p{Script=Han}]{1,3}[市縣][\\p{Script=Han}\\d之\\-]{2,65}?${ADDRESS_NO}(?:[之-]${ADDRESS_NO})?號(?:[之-]${ADDRESS_NO})?(?:(?:地下)?${ADDRESS_NO}樓(?:[之-]${ADDRESS_NO})?)?(?:${ADDRESS_NO}室)?)`, 'u');

const PARTY_LINE = /^[ \t]*(?:[一二三四五六七八九十\d]+[、.)][ \t]*)?(相[ \t]*對[ \t]*人(?:即債務人)?|債[ \t]*務[ \t]*人(?:姓名)?|聲[ \t]*請[ \t]*人(?:即債權人)?|債[ \t]*權[ \t]*人|第[ \t]*三[ \t]*人(?:法定代理人)?|法[ \t]*定[ \t]*代[ \t]*理[ \t]*人|送[ \t]*達[ \t]*代[ \t]*收[ \t]*人|代[ \t]*理[ \t]*人)[ \t]*(?:[:：][ \t]*|(?=[一-鿿]))/gm;

export function partyBlocks(text: string) {
  const t = text.normalize('NFKC');
  const labels = [...t.matchAll(PARTY_LINE)].filter((m) => !/^(?:應|須|得|與|向|於|對|等|之|未|均|已)/.test(t.slice(m.index! + m[0].length)) || /:/.test(m[0]));
  return labels.map((label, i) => {
    const from = label.index!;
    const valueAt = from + label[0].length;
    const to = labels[i + 1]?.index ?? t.length;
    return { role: stripSpaces(label[1]), from, valueAt, text: t.slice(valueAt, to) };
  });
}

export function debtorFields(text: string): { name?: Hit; id?: Hit; address?: Hit } {
  const t = text.normalize('NFKC');
  const blocks = partyBlocks(t).filter((b) => /^(?:相對人|債務人)/.test(b.role));
  if (blocks.length !== 1) return {};
  const block = blocks[0];
  const name = findDebtorNames(`債務人:${block.text}`)[0];
  const ids = findIds(block.text);
  const labeled = ids.filter((hit) => isLabeledId(block.text, hit.index));
  const positions = labeled.length ? labeled : ids;
  const id = new Set(positions.map((hit) => hit.value)).size === 1 ? positions[0] : undefined;
  const addresses = findAddresses(block.text);
  const address = new Set(addresses.map((hit) => stripSpaces(hit.value))).size === 1 ? addresses[0] : undefined;
  return {
    name: name ? { ...name, index: block.valueAt + name.index - '債務人:'.length, raw: name.raw.replace(/^債務人[:：][ \t]*[【「]?[ \t]*/, '') } : undefined,
    id: id ? { ...id, index: block.valueAt + id.index } : undefined,
    address: address ? { ...address, index: block.valueAt + address.index } : undefined,
  };
}

export function findAddresses(text: string): Hit[] {
  const out: Hit[] = [];
  const t = text.normalize('NFKC');
  for (const label of t.matchAll(ADDRESS_LABEL)) {
    const start = label.index + label[0].length;
    const lines = t.slice(start, start + 140).split(/\r?\n/, 3);
    const first = lines[0].trim() ? 0 : 1;
    const line = lines[first] ?? '';
    const continuation = lines[first + 1] ?? '';
    const wrapped = /(?:[區鄉鎮市里村鄰段巷弄路街]$|^\s*\d{3,6}\s*$)/.test(line.trim())
      && /^(?!\s*(?:姓名|債務人|戶長|父親|母親|配偶|國民|身分證|記事))[^:：\n]{1,66}號/.test(continuation);
    const source = wrapped ? `${line}\n${continuation}` : line;
    const tidy = stripSpaces(source.split(HOUSEHOLD_FIELD, 1)[0]);
    const match = ADDR_RE.exec(tidy);
    if (!match) continue;
    let count = 0;
    let end = 0;
    while (end < source.length && count < stripSpaces(match[1]).length) {
      if (!/\s/.test(source[end])) count++;
      end++;
    }
    const value = source.slice(0, end).trim();
    const index = start + (first ? lines[0].length + (t[start + lines[0].length] === '\r' ? 2 : 1) : 0) + source.search(/\S/);
    out.push({ value, raw: t.slice(label.index, index + value.length), index });
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
