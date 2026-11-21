// 專利案件資料模型。
// 相容舊版 LegalDesk 概念驗證版的 CSV（8 欄：內部編號、案件名稱、專利類型、申請案號、內部進度、下次確認日、承辦人、備註）。

import { diffDays, parseISO, todayTW, type YMD } from '../core/date';

export const PATENT_FORMAT_VERSION = '2.0';

export interface Patent {
  id: string;
  name: string;
  type: string;
  country: string;
  applicant: string;
  inventors: string;
  appNo: string;
  certNo: string;
  appDate: string;
  grantDate: string;
  pubDate: string;
  status: string;
  owner: string;
  firm: string;
  nextCheck: string;
  deadline: string;
  deadlineType: string;
  docLocation: string;
  note: string;
  updatedAt: string;
}

export type PatentKey = keyof Patent;

export interface FieldDef {
  key: PatentKey;
  label: string;
  kind: 'text' | 'date' | 'enum' | 'long';
  required?: boolean;
  desc: string;
  options?: string[];
  /** 舊版欄位名稱（匯入相容） */
  legacy?: string[];
}

export const PATENT_TYPES = ['發明', '新型', '設計', '其他'];
export const DEADLINE_TYPES = ['法定期限', '事務所通知期限', '公司內部追蹤日期'];

export const FIELDS: FieldDef[] = [
  { key: 'id', label: '內部案件編號', kind: 'text', required: true, desc: '公司自行管理的案件識別碼，不可重複', legacy: ['內部編號'] },
  { key: 'name', label: '專利名稱', kind: 'text', required: true, desc: '專利案件名稱（請勿填寫未公開技術細節）', legacy: ['案件名稱'] },
  { key: 'type', label: '專利類型', kind: 'enum', options: PATENT_TYPES, desc: '發明、新型、設計' },
  { key: 'country', label: '申請國家或地區', kind: 'text', desc: '例如：臺灣、美國、日本' },
  { key: 'applicant', label: '申請人', kind: 'text', desc: '公司或其他申請主體' },
  { key: 'inventors', label: '發明人或創作人', kind: 'text', desc: '多人以頓號分隔' },
  { key: 'appNo', label: '申請案號', kind: 'text', desc: '官方申請案號（提出申請後取得，不等於已取得專利權）' },
  { key: 'certNo', label: '專利證書號', kind: 'text', desc: '取得專利權後的證書號；與申請案號不同' },
  { key: 'appDate', label: '申請日', kind: 'date', desc: '實際提出申請日期（YYYY-MM-DD）' },
  { key: 'grantDate', label: '核准日', kind: 'date', desc: '適用時填寫' },
  { key: 'pubDate', label: '公告日', kind: 'date', desc: '適用時填寫' },
  { key: 'status', label: '目前案件狀態', kind: 'enum', desc: '可在「規則與設定」調整狀態清單', legacy: ['內部進度'] },
  { key: 'owner', label: '承辦人', kind: 'text', desc: '公司內部負責人' },
  { key: 'firm', label: '專利事務所', kind: 'text', desc: '外部委託單位' },
  { key: 'nextCheck', label: '下次確認日', kind: 'date', desc: '內部追蹤日期', legacy: ['下次人工確認日期'] },
  { key: 'deadline', label: '重要期限', kind: 'date', desc: '經人工確認的期限日期；系統不自行推算法定期限' },
  { key: 'deadlineType', label: '期限種類', kind: 'enum', options: DEADLINE_TYPES, desc: '法定期限／事務所通知期限／公司內部追蹤日期' },
  { key: 'docLocation', label: '文件位置', kind: 'text', desc: '相關文件存放位置（例如共用資料夾路徑）' },
  { key: 'note', label: '備註', kind: 'long', desc: '其他重要資訊' },
  { key: 'updatedAt', label: '最後更新時間', kind: 'text', desc: '系統自動填寫' },
];

export type StatusGroup = 'preparing' | 'filed' | 'review' | 'granted' | 'closed' | 'other';
export const STATUS_GROUP_LABEL: Record<StatusGroup, string> = {
  preparing: '準備中',
  filed: '申請中',
  review: '審查中',
  granted: '已取得專利',
  closed: '已結束',
  other: '其他',
};

export interface StatusDef {
  name: string;
  group: StatusGroup;
  active: boolean;
}

export const DEFAULT_STATUSES: StatusDef[] = [
  { name: '內部資料準備中', group: 'preparing', active: true },
  { name: '交由專利事務所處理', group: 'preparing', active: true },
  { name: '已提出申請', group: 'filed', active: true },
  { name: '審查中', group: 'review', active: true },
  { name: '收到補正或審查意見', group: 'review', active: true },
  { name: '核准', group: 'granted', active: true },
  { name: '已公告', group: 'granted', active: true },
  { name: '不予專利', group: 'closed', active: true },
  { name: '撤回或放棄', group: 'closed', active: true },
  { name: '已結案', group: 'closed', active: true },
  { name: '其他', group: 'other', active: true },
];

/** 舊版概念驗證版的狀態 → 建議分組（匯入時保留原值，不自動改寫） */
export const LEGACY_STATUS_GROUP: Record<string, StatusGroup> = {
  提案中: 'preparing',
  申請準備中: 'preparing',
  已送件: 'filed',
  審查中: 'review',
  已核准: 'granted',
  已公告: 'granted',
  結案: 'closed',
  停止辦理: 'closed',
};

export function emptyPatent(): Patent {
  return {
    id: '', name: '', type: '發明', country: '臺灣', applicant: '', inventors: '', appNo: '', certNo: '',
    appDate: '', grantDate: '', pubDate: '', status: DEFAULT_STATUSES[0].name, owner: '', firm: '',
    nextCheck: '', deadline: '', deadlineType: '', docLocation: '', note: '', updatedAt: '',
  };
}

export function groupOf(status: string, statuses: StatusDef[]): StatusGroup {
  return statuses.find((s) => s.name === status)?.group ?? LEGACY_STATUS_GROUP[status] ?? 'other';
}

export type DueBucket = 'overdue' | 'd7' | 'd30' | 'later' | 'none';
export const DUE_LABEL: Record<DueBucket, string> = { overdue: '已逾期', d7: '7 天內到期', d30: '30 天內到期', later: '尚未到期', none: '未設定' };

export function dueBucket(date: string, today: YMD = todayTW()): { bucket: DueBucket; days: number | null } {
  const d = parseISO(date);
  if (!d) return { bucket: 'none', days: null };
  const n = diffDays(d, today);
  if (n < 0) return { bucket: 'overdue', days: n };
  if (n <= 7) return { bucket: 'd7', days: n };
  if (n <= 30) return { bucket: 'd30', days: n };
  return { bucket: 'later', days: n };
}

export interface IntegrityIssue {
  id: string;
  field: string;
  message: string;
  level: 'error' | 'warning';
}

/** 資料完整性檢查（不修改資料） */
export function checkIntegrity(list: Patent[], statuses: StatusDef[]): IntegrityIssue[] {
  const out: IntegrityIssue[] = [];
  const seen = new Map<string, number>();
  for (const p of list) seen.set(p.id, (seen.get(p.id) ?? 0) + 1);
  for (const p of list) {
    const tag = p.id || '（無編號）';
    if (!p.id) out.push({ id: tag, field: '內部案件編號', message: '缺少內部案件編號', level: 'error' });
    if ((seen.get(p.id) ?? 0) > 1) out.push({ id: tag, field: '內部案件編號', message: '內部案件編號重複', level: 'error' });
    if (!p.name) out.push({ id: tag, field: '專利名稱', message: '缺少專利名稱', level: 'error' });
    for (const f of FIELDS.filter((x) => x.kind === 'date')) {
      const v = p[f.key];
      if (v && !parseISO(v)) out.push({ id: tag, field: f.label, message: `日期格式不正確：「${v}」（應為 YYYY-MM-DD）`, level: 'error' });
    }
    if (p.status && !statuses.some((s) => s.name === p.status)) out.push({ id: tag, field: '目前案件狀態', message: `「${p.status}」不在狀態清單中（可能為舊版狀態）`, level: 'warning' });
    if (p.status && statuses.find((s) => s.name === p.status && !s.active)) out.push({ id: tag, field: '目前案件狀態', message: `「${p.status}」已停用`, level: 'warning' });
    const g = groupOf(p.status, statuses);
    if (g === 'granted' && !p.certNo) out.push({ id: tag, field: '專利證書號', message: '狀態為已取得專利，但未填專利證書號', level: 'warning' });
    if ((g === 'filed' || g === 'review') && !p.appNo) out.push({ id: tag, field: '申請案號', message: '已提出申請，但未填申請案號', level: 'warning' });
    if (p.certNo && p.appNo && p.certNo === p.appNo) out.push({ id: tag, field: '專利證書號', message: '專利證書號與申請案號相同，請確認是否誤填', level: 'warning' });
    if (p.deadline && !p.deadlineType) out.push({ id: tag, field: '期限種類', message: '有重要期限但未指定期限種類', level: 'warning' });
  }
  return out;
}
