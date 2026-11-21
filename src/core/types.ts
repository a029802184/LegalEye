// 法眼 LegalEye 共用資料模型
// 所有抽取值都帶 provenance（來源），所有比對結果都有明確狀態；
// 「未檢查」永遠不等於「通過」。

export type FileKind = 'pdf' | 'docx' | 'xlsx' | 'txt' | 'csv' | 'zip' | 'other';

export interface SourceFile {
  id: string;
  /** 原始檔名（不含資料夾） */
  name: string;
  /** ZIP 內完整路徑或使用者選取的檔名 */
  path: string;
  kind: FileKind;
  size: number;
  sha256: string;
  data: Uint8Array;
}

export type ExtractMethod = 'pdf-text' | 'ocr' | 'docx' | 'xlsx' | 'txt' | 'manual';

export interface Provenance {
  fileId: string;
  fileName: string;
  path: string;
  kind: FileKind;
  /** PDF 頁碼／DOCX 分頁（1 起算） */
  page?: number;
  /** DOCX 段落序號（0 起算，全文） */
  para?: number;
  /** XLSX 工作表與儲存格 */
  sheet?: string;
  cell?: string;
  /** 在該段文字中的位置 */
  offset?: number;
  method: ExtractMethod;
  /** 0–1；文字層／DOCX＝1，OCR 依引擎信心 */
  confidence: number;
  /** 原始文字片段 */
  raw: string;
}

export function provLabel(p: Provenance | undefined): string {
  if (!p) return '—';
  const parts = [p.path];
  if (p.page) parts.push(`第 ${p.page} 頁`);
  if (p.para !== undefined && p.kind === 'docx') parts.push(`第 ${p.para + 1} 段`);
  if (p.sheet) parts.push(`${p.sheet}!${p.cell ?? ''}`);
  if (p.method === 'ocr') parts.push(`OCR 信心 ${Math.round(p.confidence * 100)}%`);
  return parts.join('・');
}

export interface TextRun {
  text: string;
  red: boolean;
  color?: string;
}

export interface Paragraph {
  index: number;
  page: number;
  part: 'body' | 'table' | 'header' | 'footer';
  text: string;
  runs: TextRun[];
}

export interface RedSpan {
  text: string;
  page: number;
  para: number;
  offset: number;
}

export interface Cell {
  ref: string;
  row: number;
  col: number;
  /** 解析值：數字、字串或布林 */
  value: string | number | boolean | null;
  /** 顯示文字（日期已轉換） */
  text: string;
  formula?: string;
  /** 公式存在但檔案沒有快取結果 */
  formulaNoCache?: boolean;
}

export interface Sheet {
  name: string;
  cells: Map<string, Cell>;
  maxRow: number;
  maxCol: number;
}

export interface PageText {
  page: number;
  text: string;
  method: ExtractMethod;
  confidence: number;
  /** 掃描頁：無文字層 */
  needsOcr?: boolean;
  ocrFailed?: boolean;
  rotationSuspect?: boolean;
}

export type ExtractStatus = 'ok' | 'partial' | 'needs-ocr' | 'error' | 'unsupported';

export type DocRole =
  | 'court-notice' // 法院公文／執行命令
  | 'notice-letter' // 前端 Word 通知函
  | 'enforcement-petition' // 民事強制執行聲請狀
  | 'payment-order' // 支付命令正本
  | 'finality-cert' // 確定證明書
  | 'service-proof' // 送達證書
  | 'payment-order-petition' // 支付命令聲請狀
  | 'debt-statement' // 欠費明細／帳單
  | 'household-register' // 戶籍謄本
  | 'court-letter' // 法院民事庭函
  | 'civil-report' // 民事陳報狀
  | 'debt-table' // 債務明細表（Excel）
  | 'attachment' // 附件
  | 'merged-source' // 合併來源 PDF（含多種文件）
  | 'unknown';

export const ROLE_LABEL: Record<DocRole, string> = {
  'court-notice': '法院公文／執行命令',
  'notice-letter': '通知函（Word）',
  'enforcement-petition': '民事強制執行聲請狀',
  'payment-order': '支付命令',
  'finality-cert': '確定證明書',
  'service-proof': '送達證書',
  'payment-order-petition': '支付命令聲請狀',
  'debt-statement': '欠費明細／帳單',
  'household-register': '戶籍謄本',
  'court-letter': '法院民事庭函',
  'civil-report': '民事陳報狀',
  'debt-table': '債務明細表',
  attachment: '附件',
  'merged-source': '合併來源文件',
  unknown: '未辨識',
};

export interface RoleCandidate {
  role: DocRole;
  score: number;
  reason: string;
}

export interface ExtractedDoc {
  file: SourceFile;
  status: ExtractStatus;
  warnings: string[];
  pages: PageText[];
  paragraphs?: Paragraph[];
  redSpans?: RedSpan[];
  sheets?: Sheet[];
  fullText: string;
  role: DocRole;
  roleCandidates: RoleCandidate[];
  roleManual?: boolean;
}

export type CheckStatus =
  | 'match' // 已核對一致
  | 'mismatch' // 發現不一致
  | 'partial' // 部分核對（例如身分證遮罩）
  | 'missing' // 缺資料（來源未提供／書狀未記載）
  | 'unreadable' // 檔案中可能有但辨識失敗
  | 'needs-review' // 需人工判斷
  | 'not-applicable'; // 不適用

export const STATUS_LABEL: Record<CheckStatus, string> = {
  match: '一致',
  mismatch: '不一致',
  partial: '部分核對',
  missing: '缺資料',
  unreadable: '辨識失敗',
  'needs-review': '需人工判斷',
  'not-applicable': '不適用',
};

export type Severity = 'high' | 'medium' | 'low' | 'info';
export const SEVERITY_LABEL: Record<Severity, string> = { high: '高', medium: '中', low: '低', info: '參考' };

export type ReviewState = 'pending' | 'fix' | 'false-positive' | 'done';
export const REVIEW_LABEL: Record<ReviewState, string> = {
  pending: '待確認',
  fix: '需修正',
  'false-positive': '誤報',
  done: '已處理',
};

export interface Evidence {
  label: string;
  raw: string;
  normalized: string;
  prov?: Provenance;
}

export interface CheckItem {
  id: string;
  field: string;
  status: CheckStatus;
  severity: Severity;
  reason: string;
  /** 來源 A（基準） */
  a?: Evidence;
  /** 待核書狀 B */
  b?: Evidence;
  /** 計算式／驗算說明 */
  calc?: string;
  basis?: string[];
  review: { state: ReviewState; note: string; at?: string };
}

export type UnitStatus = 'consistent' | 'inconsistent' | 'missing' | 'pending' | 'not-applicable';
export const UNIT_STATUS_LABEL: Record<UnitStatus, string> = {
  consistent: '已核對一致',
  inconsistent: '發現不一致',
  missing: '缺資料',
  pending: 'OCR／配對待確認',
  'not-applicable': '不適用',
};

export interface MatchInfo {
  score: number;
  evidence: string[];
  needsManual: boolean;
}

/** 一位債務人或一個案件 */
export interface CheckUnit {
  id: string;
  label: string;
  subLabel?: string;
  match?: MatchInfo;
  /** 該單元使用的文件（角色 → 檔案 id） */
  docs: { role: DocRole; fileId: string; pages?: number[] }[];
  items: CheckItem[];
}

export type FlowId = 'A' | 'B' | 'C' | 'D';

export interface BatchIssue {
  id: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  fileId?: string;
}

export interface FlowResult {
  flow: FlowId;
  units: CheckUnit[];
  batchIssues: BatchIssue[];
  /** 本次未完成的檢查（會寫入報告） */
  notDone: string[];
  ruleVersion: string;
  createdAt: string;
}

export function unitStatus(u: CheckUnit): UnitStatus {
  const s = u.items.map((i) => i.status);
  if (s.includes('mismatch')) return 'inconsistent';
  if (u.match?.needsManual) return 'pending';
  if (!s.length) return 'missing';
  if (s.includes('unreadable') || s.includes('needs-review')) return 'pending';
  if (s.includes('missing')) return 'missing';
  if (s.every((x) => x === 'not-applicable')) return 'not-applicable';
  return 'consistent';
}
