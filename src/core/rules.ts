// 可由介面維護的規則設定：同義詞、法院簡稱、公司帳號主檔、停用檢查與原因、Excel 欄位對照。
// 存在瀏覽器 localStorage（僅設定，不含任何上傳文件內容），可匯出／匯入 JSON 交接。

import { DEFAULT_COURT_ALIASES } from './court';
import type { FlowId } from './types';

export const RULESET_VERSION = 'LE-RULES-2026.11.4';
export const SETTINGS_SCHEMA = 1;

export interface CheckDef {
  id: string;
  flow: FlowId;
  label: string;
  desc: string;
}

export const CHECK_CATALOG: CheckDef[] = [
  { id: 'A.court', flow: 'A', label: '法院名稱', desc: '通知函與法院公文的法院全名（臺／台、常見簡稱可正規化）' },
  { id: 'A.case', flow: 'A', label: '年度／字別／案號', desc: '精準比對，司執與司執助視為不同字別' },
  { id: 'A.name', flow: 'A', label: '債務人姓名', desc: '含「即」「原名」別名；異體字只提示不自動視為一致' },
  { id: 'A.id', flow: 'A', label: '身分證字號', desc: '只在來源有提供時比對；遮罩僅部分核對' },
  { id: 'A.amount', flow: 'A', label: '債權金額', desc: '依金額性質比對；法院未記載則不適用' },
  { id: 'A.account', flow: 'A', label: '公司銀行帳號', desc: '只依公司帳號主檔或法院公文核對，不猜測' },
  { id: 'A.attach', flow: 'A', label: '附件執行命令名稱', desc: '通知函提及的執行命令是否存在於法院公文' },
  { id: 'A.internal', flow: 'A', label: '通知函內部一致性', desc: '同一頁主旨、支票備註、附件欄的案號姓名是否一致' },
  { id: 'B.party', flow: 'B', label: '當事人', desc: '債權人、債務人姓名與身分證字號' },
  { id: 'B.address', flow: 'B', label: '住址', desc: '不同日期文件的住址可能不同，差異列為人工確認' },
  { id: 'B.case', flow: 'B', label: '法院與案號', desc: '執行名義法院、年度、字別、案號' },
  { id: 'B.title', flow: 'B', label: '執行名義與附件', desc: '支付命令、確定證明書、送達證書是否齊備' },
  { id: 'B.amount', flow: 'B', label: '金額', desc: '本金、程序費、已清償與驗算式；國字與數字等值' },
  { id: 'B.interest', flow: 'B', label: '利息起算日與利率', desc: '依執行名義條款與送達資料計算' },
  { id: 'C.name', flow: 'C', label: '姓名（戶籍）', desc: '聲請狀與戶籍謄本' },
  { id: 'C.id', flow: 'C', label: '身分證字號（戶籍）', desc: '聲請狀與戶籍謄本，含檢查碼' },
  { id: 'C.address', flow: 'C', label: '地址（戶籍）', desc: '門牌樓層里鄰不同不視為相同' },
  { id: 'C.amount', flow: 'C', label: '聲請本金與欠費', desc: '優先比對總欠費／未償債務額，不以本期應繳比對' },
  { id: 'C.internal', flow: 'C', label: '聲請狀內文金額', desc: '聲請本金與內文再次記載的金額' },
  { id: 'C.basedate', flow: 'C', label: '資料基準日', desc: '聲請狀計算基準日與帳務資料' },
  { id: 'D.excel', flow: 'D', label: 'Excel 驗算', desc: '各門號分項加總與總額' },
  { id: 'D.amount', flow: 'D', label: '陳報金額', desc: '國字、數字、附表與 Excel 總額' },
  { id: 'D.case', flow: 'D', label: '庭函與陳報狀案件資訊', desc: '法院、年度、字別、案號、股別、姓名' },
  { id: 'D.hearing', flow: 'D', label: '開庭日期', desc: '只有庭函記載時才比對' },
  { id: 'D.attach', flow: 'D', label: '附件名稱與份數', desc: '書狀引用與實際檢附文件' },
];

export interface DebtColumnSynonyms {
  key: string[];
  telecom: string[];
  collect: string[];
  subsidy: string[];
  other: string[];
  paid: string[];
  balance: string[];
}

export interface Settings {
  schema: number;
  rulesetVersion: string;
  /** 附件名稱同義詞群組：同一群組內的名稱視為同一種文件 */
  attachmentSynonyms: string[][];
  courtAliases: Record<string, string>;
  /** 公司核准的收款帳號主檔 */
  bankMaster: { label: string; account: string }[];
  disabledChecks: { id: string; reason: string; at: string }[];
  debtColumns: DebtColumnSynonyms;
  /** 核對畫面是否遮罩敏感資料 */
  maskByDefault: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  schema: SETTINGS_SCHEMA,
  rulesetVersion: RULESET_VERSION,
  attachmentSynonyms: [
    ['行動寬頻申請書', '申裝書', '行動寬頻業務申請書', '服務申請書'],
    ['帳單', '繳費通知', '電信帳單', '繳費通知單'],
    ['債務明細表', '欠費明細', '債權明細表', '債務明細'],
    ['支付命令', '支付命令正本'],
    ['確定證明書', '支付命令確定證明書'],
  ],
  courtAliases: { ...DEFAULT_COURT_ALIASES },
  bankMaster: [],
  disabledChecks: [],
  debtColumns: {
    key: ['門號', '電話號碼', '用戶號碼', '帳號'],
    telecom: ['電信資費', '月租費', '通信費'],
    collect: ['代收費用', '代收'],
    subsidy: ['專案補貼款', '補貼款', '專案補貼'],
    other: ['其他應收', '其他費用'],
    paid: ['已繳款', '已繳', '已付款', '沖銷'],
    balance: ['未償債務', '未償金額', '欠費金額', '未繳金額'],
  },
  maskByDefault: true,
};

const KEY = 'legaleye.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    return migrateSettings(JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 私密瀏覽或儲存空間不足時忽略 */
  }
}

export function clearSettings(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** 匯入的設定檔做結構驗證與版本轉換；不合法欄位以預設值補上 */
export function migrateSettings(input: unknown): Settings {
  const d = structuredClone(DEFAULT_SETTINGS);
  if (!input || typeof input !== 'object') return d;
  const o = input as Partial<Settings>;
  const strArr2 = (v: unknown) => Array.isArray(v) && v.every((g) => Array.isArray(g) && g.every((x) => typeof x === 'string'));
  return {
    schema: SETTINGS_SCHEMA,
    rulesetVersion: typeof o.rulesetVersion === 'string' ? o.rulesetVersion : d.rulesetVersion,
    attachmentSynonyms: strArr2(o.attachmentSynonyms) ? (o.attachmentSynonyms as string[][]) : d.attachmentSynonyms,
    courtAliases:
      o.courtAliases && typeof o.courtAliases === 'object' && Object.values(o.courtAliases).every((x) => typeof x === 'string')
        ? (o.courtAliases as Record<string, string>)
        : d.courtAliases,
    bankMaster: Array.isArray(o.bankMaster)
      ? o.bankMaster.filter((b) => b && typeof b.account === 'string').map((b) => ({ label: String(b.label ?? ''), account: b.account.replace(/[^\d]/g, '') }))
      : [],
    disabledChecks: Array.isArray(o.disabledChecks)
      ? o.disabledChecks.filter((x) => x && typeof x.id === 'string').map((x) => ({ id: x.id, reason: String(x.reason ?? ''), at: String(x.at ?? '') }))
      : [],
    debtColumns: { ...d.debtColumns, ...(o.debtColumns && typeof o.debtColumns === 'object' ? o.debtColumns : {}) },
    maskByDefault: typeof o.maskByDefault === 'boolean' ? o.maskByDefault : true,
  };
}

export function disabledReason(s: Settings, id: string): string | null {
  const x = s.disabledChecks.find((d) => d.id === id);
  return x ? x.reason || '（未填原因）' : null;
}

export function synonymGroup(s: Settings, name: string): string[] | null {
  const n = name.replace(/\s/g, '');
  return s.attachmentSynonyms.find((g) => g.some((x) => n.includes(x.replace(/\s/g, '')))) ?? null;
}
