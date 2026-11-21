// 依「內容與結構」分類文件角色，檔名只作為輔助線索。
// 分類不確定時回傳候選清單，由使用者在畫面上更正。

import type { DocRole, ExtractedDoc, RoleCandidate } from './types';

interface Rule {
  role: DocRole;
  kinds: string[];
  title: RegExp;
  body?: RegExp;
  neg?: RegExp;
  fileHint?: RegExp;
}

const RULES: Rule[] = [
  { role: 'enforcement-petition', kinds: ['docx', 'pdf', 'txt'], title: /民事.{0,4}強制執行.{0,2}聲請狀|聲請強制執行狀/, body: /強制執行/, fileHint: /強執|強制執行/ },
  { role: 'payment-order-petition', kinds: ['pdf', 'docx', 'txt'], title: /支付命令聲請狀|聲請.{0,4}支付命令/, body: /督促程序|支付命令/, fileHint: /支付命令|聲請狀/ },
  { role: 'civil-report', kinds: ['docx', 'pdf', 'txt'], title: /民事.{0,2}陳報狀/, body: /陳報/, fileHint: /陳報狀/ },
  { role: 'notice-letter', kinds: ['docx', 'txt'], title: /通知函|通\s*知\s*書/, body: /執行命令|法院/, neg: /聲請狀/, fileHint: /通知函/ },
  { role: 'finality-cert', kinds: ['pdf', 'txt'], title: /確定證明書/, fileHint: /確定證明/ },
  { role: 'service-proof', kinds: ['pdf', 'txt'], title: /送達證書/, fileHint: /送達/ },
  { role: 'tax-record', kinds: ['pdf', 'txt', 'docx'], title: /國稅局.{0,14}(?:查稅|財產|所得)|(?:財產|所得)資料清單|查稅資料/, body: /財產|所得|統一編號/, fileHint: /查稅|財產所得/ },
  { role: 'payment-order', kinds: ['pdf', 'txt'], title: /^.{0,40}支付命令/, body: /債務人應向債權人|於本命令送達後二十日/, neg: /聲請狀/, fileHint: /支付命令/ },
  { role: 'court-letter', kinds: ['pdf', 'txt'], title: /民事庭|法院.{0,6}函/, body: /陳報|受文者|開庭|到庭/, neg: /執行命令|陳報狀/, fileHint: /庭函/ },
  { role: 'court-notice', kinds: ['pdf', 'txt'], title: /執行命令|法院.{0,10}(函|命令)/, body: /受文者|發文字號|執行/, neg: /陳報狀|聲請狀/, fileHint: /執行命令|公文/ },
  { role: 'household-register', kinds: ['pdf', 'txt'], title: /戶籍謄本|戶籍資料|個人戶籍/, body: /戶長|出生|統一編號/, fileHint: /戶籍|戶謄/ },
  { role: 'debt-statement', kinds: ['pdf', 'txt', 'xlsx'], title: /欠費|帳單|繳費通知|費用明細|債權明細/, body: /總欠費|未償|應繳|門號|已繳/, neg: /聲請狀|陳報狀/, fileHint: /^\d{4,}\.(pdf|txt)$/ },
  { role: 'debt-table', kinds: ['xlsx'], title: /債務明細|欠費明細|未償債務|明細表/, body: /未償|已繳|合計|總計/, fileHint: /明細/ },
  { role: 'attachment', kinds: ['pdf', 'txt', 'docx', 'xlsx'], title: /附件|附表|證物|申請書|申裝書|帳單/, fileHint: /附件|附表|證物|申裝書|帳單/ },
];

export function classifyDoc(doc: ExtractedDoc, allowed?: DocRole[]): RoleCandidate[] {
  const head = doc.fullText.slice(0, 260).normalize('NFKC');
  const body = doc.fullText.slice(0, 20000).normalize('NFKC');
  const name = doc.file.name;
  const path = doc.file.path;
  const cands: RoleCandidate[] = [];
  for (const r of RULES) {
    if (allowed && !allowed.includes(r.role)) continue;
    if (!r.kinds.includes(doc.file.kind)) continue;
    let score = 0;
    const why: string[] = [];
    if (r.title.test(head)) {
      score += 3;
      why.push('開頭標題符合');
    } else if (r.title.test(body)) {
      score += 1.5;
      why.push('內文出現標題用語');
    }
    if (r.body?.test(body)) {
      score += 1;
      why.push('內文關鍵詞');
    }
    if (r.neg?.test(head)) {
      score -= 3;
      why.push('開頭含排除用語');
    }
    if (r.fileHint?.test(name) || r.fileHint?.test(path)) {
      score += 1;
      why.push('檔名／資料夾線索');
    }
    if (score > 0) cands.push({ role: r.role, score, reason: why.join('、') });
  }
  cands.sort((a, b) => b.score - a.score);
  // 合併來源：同一 PDF 內同時出現多種法院文件
  if (doc.file.kind === 'pdf' || doc.file.kind === 'txt') {
    const kinds = doc.pages.map((p) => pageRole(p.text)).filter((x) => x !== 'unknown');
    const set = new Set(kinds);
    if (set.size >= 2 && (!allowed || allowed.includes('merged-source'))) {
      cands.unshift({ role: 'merged-source', score: 4 + set.size, reason: `各頁含 ${[...set].length} 種文件（${[...set].join('、')}）` });
    }
  }
  return cands;
}

export function pickRole(c: RoleCandidate[]): DocRole {
  if (!c.length || c[0].score < 2) return 'unknown';
  return c[0].role;
}

/** 單頁角色（用於合併 PDF 拆組） */
export function pageRole(text: string): DocRole {
  const head = text.slice(0, 200).normalize('NFKC').replace(/\s+/g, '');
  if (/確定證明書/.test(head)) return 'finality-cert';
  if (/送達證書/.test(head)) return 'service-proof';
  if (/支付命令/.test(head) && !/聲請狀/.test(head)) return 'payment-order';
  if (/執行命令/.test(head)) return 'court-notice';
  if (/欠費|帳單|債權明細|繳款/.test(head)) return 'debt-statement';
  if (/戶籍謄本|戶籍資料/.test(head)) return 'household-register';
  return 'unknown';
}
