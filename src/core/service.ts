// 送達生效日與利息起算日計算（規則版本見 SERVICE_RULE_VERSION）。
//
// 原則：
// 1. 先確認執行名義的利息條款是「自支付命令送達翌日起」還是「自特定日期起」，兩者不可混用。
// 2. 只有「送達翌日」條款且有可靠的送達資料時才自動計算。
// 3. 一般送達：有效送達日 S → 起息日 S+1。
// 4. 寄存送達：依民事訴訟法第 138 條第 2 項，自寄存之日起經 10 日發生效力；
//    期間計算依民法第 120 條第 2 項始日不算入，寄存日 D → D+10 日屆滿時生效 → 翌日 D+11 起息。
//    例：7/1 寄存 → 7/11 生效 → 7/12 起息。
// 5. 寄存後於 10 日內實際領取、公示送達、境外送達、送達方式或日期不明、多名債務人日期不同 → 需人工判斷。
// 6. 起息日與法院所在地無關（不得把特定法院一律 +11）；不得把支付命令 20 日異議期間加入；
//    確定證明書日期、法院製作日期、寄件日期都不是送達日。

import { addDays, fmtBoth, type YMD } from './date';

export const SERVICE_RULE_VERSION = 'SVC-2026.11-1';

export const SERVICE_BASIS = [
  '民事訴訟法第 138 條（寄存送達，自寄存之日起經十日發生效力）：https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=B0010001&flno=138',
  '民法第 120 條第 2 項、第 121 條（期間始日不算入、以末日終止時為期間之終止）：https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=B0000001',
  '司法院釋字第 797 號解釋（寄存送達生效規定之說明；原文請至司法院憲法法庭網站 https://cons.judicial.gov.tw/ 查詢）',
];

export type InterestClause =
  | { type: 'after-service' } // 自支付命令送達翌日起
  | { type: 'fixed-date'; date: YMD } // 自特定日期起
  | { type: 'unknown' };

export type ServiceMethod = 'personal' | 'deposit' | 'public' | 'foreign' | 'unknown';

export const SERVICE_METHOD_LABEL: Record<ServiceMethod, string> = {
  personal: '一般送達（本人／同居人／受僱人收受等）',
  deposit: '寄存送達',
  public: '公示送達',
  foreign: '境外送達',
  unknown: '送達方式不明',
};

export interface ServiceInput {
  clause: InterestClause;
  method: ServiceMethod;
  /** 一般送達日 S 或寄存日 D */
  serviceDate?: YMD | null;
  /** 實際領取日（寄存送達後） */
  pickupDate?: YMD | null;
  /** 法院確認之送達生效日（例如確定證明書或法院函明載） */
  courtConfirmedEffective?: YMD | null;
  /** 多名債務人且送達日期不同 */
  multipleDebtorsDiffer?: boolean;
  /** 法院（僅供紀錄，不影響計算） */
  court?: string;
}

export interface ServiceResult {
  status: 'computed' | 'fixed' | 'manual';
  effectiveDate?: YMD;
  interestStart?: YMD;
  formula: string;
  warnings: string[];
  basis: string[];
  ruleVersion: string;
}

export function computeInterestStart(input: ServiceInput): ServiceResult {
  const base = { basis: SERVICE_BASIS, ruleVersion: SERVICE_RULE_VERSION };
  const warnings: string[] = [];

  if (input.clause.type === 'fixed-date') {
    return {
      ...base,
      status: 'fixed',
      interestStart: input.clause.date,
      formula: `執行名義明載自 ${fmtBoth(input.clause.date)} 起算利息（與送達日無關）`,
      warnings,
    };
  }
  if (input.clause.type === 'unknown') {
    return { ...base, status: 'manual', formula: '未能確認執行名義的利息起算條款', warnings: ['請人工閱讀執行名義利息條款'] };
  }
  if (input.multipleDebtorsDiffer) {
    return { ...base, status: 'manual', formula: '多名債務人送達日期不同', warnings: ['各債務人起息日可能不同，請逐人判斷'] };
  }
  if (input.courtConfirmedEffective) {
    const start = addDays(input.courtConfirmedEffective, 1);
    return {
      ...base,
      status: 'computed',
      effectiveDate: input.courtConfirmedEffective,
      interestStart: start,
      formula: `法院確認送達生效日 ${fmtBoth(input.courtConfirmedEffective)} ＋ 1 日 ＝ ${fmtBoth(start)}`,
      warnings,
    };
  }
  switch (input.method) {
    case 'personal': {
      if (!input.serviceDate) return { ...base, status: 'manual', formula: '缺少有效送達日', warnings: ['無送達證書或可靠送達日來源，不能計算'] };
      const start = addDays(input.serviceDate, 1);
      return {
        ...base,
        status: 'computed',
        effectiveDate: input.serviceDate,
        interestStart: start,
        formula: `一般送達日 ${fmtBoth(input.serviceDate)} ＋ 1 日 ＝ 起息日 ${fmtBoth(start)}`,
        warnings,
      };
    }
    case 'deposit': {
      if (!input.serviceDate) return { ...base, status: 'manual', formula: '缺少寄存日期', warnings: ['無寄存日期，不能計算'] };
      const effective = addDays(input.serviceDate, 10);
      const start = addDays(input.serviceDate, 11);
      if (input.pickupDate && Date.UTC(input.pickupDate.y, input.pickupDate.m - 1, input.pickupDate.d) < Date.UTC(effective.y, effective.m - 1, effective.d)) {
        return {
          ...base,
          status: 'manual',
          formula: `寄存日 ${fmtBoth(input.serviceDate)}；實際領取日 ${fmtBoth(input.pickupDate)} 早於十日期滿日 ${fmtBoth(effective)}`,
          warnings: ['寄存後提前領取，送達生效日須依具體資料判斷，系統不自動套用 +11 日'],
        };
      }
      return {
        ...base,
        status: 'computed',
        effectiveDate: effective,
        interestStart: start,
        formula: `寄存日 ${fmtBoth(input.serviceDate)} → 經 10 日於 ${fmtBoth(effective)} 期間屆滿時生效 → 翌日 ${fmtBoth(start)} 起息（D＋11）`,
        warnings,
      };
    }
    case 'public':
      return { ...base, status: 'manual', formula: '公示送達', warnings: ['公示送達之生效日依民事訴訟法第 152 條等規定及法院公告，請人工判斷'] };
    case 'foreign':
      return { ...base, status: 'manual', formula: '境外送達', warnings: ['境外送達生效期間另有規定，請人工判斷'] };
    default:
      return { ...base, status: 'manual', formula: '送達方式不明', warnings: ['送達方式不明，不自動計算（不會依法院地點套用 +11 日）'] };
  }
}

/** 從執行名義文字判斷利息條款 */
export function detectInterestClause(text: string, findDate: (s: string) => YMD | null): { clause: InterestClause; raw: string } {
  const t = text.normalize('NFKC').replace(/\s+/g, '');
  const after = /自[^。；]{0,12}?(支付命令|本命令|起訴狀繕本|聲請狀繕本)?送達(之)?翌日起/.exec(t);
  if (after) return { clause: { type: 'after-service' }, raw: after[0] };
  const fixed = /自((?:民國)?[\d一二三四五六七八九十〇零]{2,4}年[\d一二三四五六七八九十〇零]{1,3}月[\d一二三四五六七八九十〇零]{1,3}日)起/.exec(t);
  if (fixed) {
    const d = findDate(fixed[1]);
    if (d) return { clause: { type: 'fixed-date', date: d }, raw: fixed[0] };
  }
  return { clause: { type: 'unknown' }, raw: '' };
}

/** 從送達證書文字判斷送達方式 */
export function detectServiceMethod(text: string): ServiceMethod {
  const t = text.normalize('NFKC');
  if (/公示送達/.test(t)) return 'public';
  if (/寄存/.test(t)) return 'deposit';
  if (/(外國|境外|國外|駐外)/.test(t) && /送達/.test(t)) return 'foreign';
  if (/(本人|同居人|受僱人|受雇人|管理員|親自)[^。]{0,8}(收受|簽收|收領)|已交付/.test(t)) return 'personal';
  return 'unknown';
}
