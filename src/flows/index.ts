import type { ChromePageText, DocRole, ExtractedDoc, FieldCorrection, FlowId, FlowResult, ManualPair } from '../core/types';
import { runFlowA } from './flowA';
import { runFlowB, type ServiceManualInput } from './flowB';
import { runFlowC } from './flowC';
import { runFlowD } from './flowD';
import type { Settings } from '../core/rules';
import { addDirectCorrections, applyChromePages } from './chromeText';

export interface FlowDef {
  id: FlowId;
  title: string;
  short: string;
  desc: string;
  roles: DocRole[];
  expects: string[];
}

export const FLOWS: FlowDef[] = [
  {
    id: 'A',
    title: '法院公文／通知函核對',
    short: '公文通知函',
    desc: '法院執行命令 PDF（可為多頁掃描合併檔）與前端 Word 通知函逐人交叉比對；紅字為優先審核線索。',
    roles: ['court-notice', 'notice-letter', 'attachment'],
    expects: ['法院執行命令 PDF', 'Word 通知函（每頁一位債務人，紅字為變動欄位）'],
  },
  {
    id: 'B',
    title: '強制執行聲請狀核對',
    short: '強執聲請狀',
    desc: '聲請狀對照支付命令、確定證明書、送達證書與債權資料，含金額驗算與利息起算日計算。',
    roles: ['enforcement-petition', 'payment-order', 'finality-cert', 'service-proof', 'merged-source', 'debt-statement', 'tax-record', 'attachment'],
    expects: ['強制執行聲請狀（用來確認書狀的當事人與金額）', '支付命令正本／確定證明書（用來確認執行名義，可合併為 PDF）', '送達資料（送達翌日起息時使用）', '清償明細、查稅／財產所得資料（如有）'],
  },
  {
    id: 'C',
    title: '支付命令聲請狀批次核對',
    short: '支付命令批次',
    desc: '整批 ZIP：個別聲請狀、數字檔名的欠費明細、多人合併戶籍謄本，逐人配對與核對。',
    roles: ['payment-order-petition', 'debt-statement', 'household-register', 'attachment'],
    expects: ['支付命令聲請狀（每人一份）', '欠費明細／帳單（常以數字編號命名）', '合併戶籍謄本 PDF'],
  },
  {
    id: 'D',
    title: '民事陳報狀核對',
    short: '民事陳報狀',
    desc: '法院庭函、Word 陳報狀、Excel 債務明細與附件，逐項驗算金額並核對附件名稱與份數。',
    roles: ['court-letter', 'civil-report', 'debt-table', 'attachment'],
    expects: ['法院民事庭函 PDF', 'Word 民事陳報狀', 'Excel 債務明細表', '陳報狀附件 PDF 與其他附件'],
  },
];

export interface RunOptions {
  settings: Settings;
  service?: Record<string, ServiceManualInput>;
  manualPairs?: Record<string, ManualPair>;
  corrections?: Record<string, FieldCorrection>;
  chromePages?: ChromePageText[];
}

export function runFlow(flow: FlowId, docs: ExtractedDoc[], opt: RunOptions): FlowResult {
  const base = addDirectCorrections(runChecks(flow, docs, opt), opt);
  if (!opt.chromePages?.length) return base;
  const roles = FLOWS.find((entry) => entry.id === flow)!.roles;
  return applyChromePages(base, docs, roles, opt, (variant, pairs) => runChecks(flow, variant, { ...opt, manualPairs: pairs, corrections: undefined }));
}

function runChecks(flow: FlowId, docs: ExtractedDoc[], opt: RunOptions): FlowResult {
  const ctx = { settings: opt.settings, service: opt.service, manualPairs: opt.manualPairs, corrections: opt.corrections };
  switch (flow) {
    case 'A':
      return runFlowA(docs, ctx);
    case 'B':
      return runFlowB(docs, ctx);
    case 'C':
      return runFlowC(docs, ctx);
    case 'D':
      return runFlowD(docs, ctx);
  }
}
