// 核對報告：HTML（可列印存成 PDF）與 CSV。預設遮罩身分證、帳號、電話。
// 報告包含：批次資訊、檔案與雜湊、辨識成功率、配對狀態、欄位差異與來源、計算依據、
// 人工覆核紀錄、規則版本、未完成的檢查與免責說明。

import { escapeHtml } from '../core/text';
import { maskAccount, maskId } from '../core/idno';
import { csvCell } from '../patent/io';
import { RULESET_VERSION } from '../core/rules';
import { SERVICE_RULE_VERSION } from '../core/service';
import brandIcon from '../ui/legaleye-icon.svg?raw';
import {
  provLabel,
  REVIEW_LABEL,
  ROLE_LABEL,
  SEVERITY_LABEL,
  STATUS_LABEL,
  UNIT_STATUS_LABEL,
  unitStatus,
  type CheckItem,
  type ExtractedDoc,
  type FlowResult,
} from '../core/types';
import { FLOWS } from '../flows';

export const DISCLAIMER =
  '本報告由「法眼 LegalEye」依規則式比對產生，僅供法務人員審查輔助。系統結果不代表文件已符合法律規定，亦不構成法律意見；「一致」僅表示依目前規則在所列來源中找到相同記載。實際內容、送達效力、利息計算與附件齊備與否，仍應由承辦人員依原始文件確認。';

export function maskText(s: string): string {
  return String(s ?? '')
    .replace(/[A-Z][1289][\d*]{8}/g, (m) => maskId(m))
    .replace(/(?<!\d)09\d{2}-?\d{3}-?(\d{3})(?!\d)/g, (_m, last: string) => `09**-***-${last}`)
    .replace(/(?<![\d,])\d{10,20}(?![\d,])/g, (m) => maskAccount(m));
}

export interface ReportOptions {
  mask: boolean;
  batchName: string;
  reviewer?: string;
}

function stats(docs: ExtractedDoc[]) {
  const pages = docs.flatMap((d) => d.pages);
  const ok = pages.filter((p) => !p.needsOcr && !p.ocrFailed && p.text.trim()).length;
  const ocr = pages.filter((p) => p.method === 'ocr').length;
  const failed = pages.filter((p) => p.needsOcr || p.ocrFailed).length;
  return { total: pages.length, ok, ocr, failed, rate: pages.length ? Math.round((ok / pages.length) * 1000) / 10 : 0 };
}

export function buildHtmlReport(res: FlowResult, docs: ExtractedDoc[], opt: ReportOptions): string {
  const m = (s: string) => escapeHtml(opt.mask ? maskText(s) : s);
  const flow = FLOWS.find((f) => f.id === res.flow)!;
  const st = stats(docs);
  const now = new Date().toLocaleString('zh-TW', { hour12: false });
  const cell = (i: CheckItem, side: 'a' | 'b') => {
    const e = i[side];
    if (!e) return '<span class="mut">—</span>';
    return `<div><b>${escapeHtml(e.label)}</b>：${m(e.normalized)}</div><div class="mut">原文：${m(e.raw)}</div>${e.prov ? `<div class="mut">來源：${m(provLabel(e.prov))}</div>` : ''}`;
  };
  const units = res.units
    .map((u, ui) => {
      const us = unitStatus(u);
      const rows = u.items
        .map(
          (i) => `<tr class="s-${i.status}"><td>${escapeHtml(i.field)}</td><td><span class="tag t-${i.status}">${STATUS_LABEL[i.status]}</span><div class="mut">優先：${SEVERITY_LABEL[i.severity]}</div></td><td>${cell(i, 'a')}</td><td>${cell(i, 'b')}</td><td>${m(i.reason)}${i.calc ? `<pre>${m(i.calc)}</pre>` : ''}${i.basis?.length ? `<div class="mut">依據：${i.basis.map(escapeHtml).join('<br>')}</div>` : ''}</td><td>${REVIEW_LABEL[i.review.state]}${i.review.note ? `<div>${m(i.review.note)}</div>` : ''}${i.review.at ? `<div class="mut">${escapeHtml(i.review.at)}</div>` : ''}</td></tr>`,
        )
        .join('');
      return `<section class="unit"><h3>${ui + 1}. ${m(u.label)} <span class="tag u-${us}">${UNIT_STATUS_LABEL[us]}</span></h3>${u.subLabel ? `<div class="mut">${m(u.subLabel)}</div>` : ''}${u.match ? `<div class="mut">配對：${u.match.evidence.map(m).join('；')}${u.match.needsManual ? '（需人工確認）' : ''}</div>` : ''}<table><thead><tr><th>欄位</th><th>狀態</th><th>來源 A</th><th>待核書狀 B</th><th>原因／計算</th><th>人工覆核</th></tr></thead><tbody>${rows || '<tr><td colspan="6">無檢查項目</td></tr>'}</tbody></table></section>`;
    })
    .join('');
  const counts = res.units.reduce<Record<string, number>>((acc, u) => {
    const k = unitStatus(u);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const reviewed = res.units.flatMap((u) => u.items).filter((i) => i.review.state !== 'pending').length;
  const totalItems = res.units.flatMap((u) => u.items).length;
  const logo = brandIcon.replace('<svg ', '<svg width="28" height="28" aria-hidden="true" ');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>法眼 LegalEye 核對報告｜${escapeHtml(flow.title)}</title><style>
body{font-family:"Microsoft JhengHei","PingFang TC","Noto Sans TC",system-ui,sans-serif;color:#1f2a37;margin:0;padding:24px;font-size:13px;line-height:1.6;background:#fff}
header{display:flex;align-items:center;gap:10px;border-bottom:2px solid #243E59;padding-bottom:10px;margin-bottom:16px}header h1{font-size:18px;margin:0}
h2{font-size:15px;color:#243E59;border-left:4px solid #32648C;padding-left:8px;margin:22px 0 8px}h3{font-size:14px;margin:16px 0 4px}
table{width:100%;border-collapse:collapse;margin:6px 0 12px;table-layout:fixed}th,td{border:1px solid #d5dce5;padding:6px 7px;vertical-align:top;text-align:left;word-break:break-word}th{background:#eef2f7;font-weight:600}
.mut{color:#5b6b7f;font-size:12px}.tag{display:inline-block;border:1px solid #9aa9bb;border-radius:4px;padding:0 6px;font-size:12px;white-space:nowrap}
.t-mismatch,.u-inconsistent{border-color:#b42318;color:#b42318}.t-match,.u-consistent{border-color:#1b6e4c;color:#1b6e4c}.t-needs-review,.t-partial,.t-unreadable,.u-pending{border-color:#9a5b00;color:#9a5b00}
pre{white-space:pre-wrap;background:#f5f7fa;padding:6px;margin:6px 0;font-family:inherit}.kv td:first-child{width:180px;background:#f7f9fb}
.disc{border:1px solid #d5dce5;background:#f7f9fb;padding:10px;margin-top:20px}.unit{break-inside:auto}tr{break-inside:avoid}
@media print{body{padding:0}a{color:inherit}}</style></head><body>
<header>${logo}<div><h1>法眼 LegalEye｜${escapeHtml(flow.title)} 核對報告</h1><div class="mut">報告產生時間：${escapeHtml(now)}${opt.mask ? '｜已遮罩身分證字號、帳號、電話' : '｜<b>未遮罩敏感資料，請依公司保密規範處理</b>'}</div></div></header>
<h2>批次資訊</h2><table class="kv"><tbody>
<tr><td>批次／案件</td><td>${m(opt.batchName)}</td></tr>
<tr><td>核對流程</td><td>${escapeHtml(flow.id)}. ${escapeHtml(flow.title)}</td></tr>
<tr><td>規則版本</td><td>${escapeHtml(res.ruleVersion)}；送達／利息規則 ${escapeHtml(SERVICE_RULE_VERSION)}；目前系統規則 ${escapeHtml(RULESET_VERSION)}</td></tr>
<tr><td>文字辨識成功率</td><td>${st.ok}/${st.total} 頁（${st.rate}%）；OCR ${st.ocr} 頁；無法辨識 ${st.failed} 頁</td></tr>
<tr><td>核對單位</td><td>共 ${res.units.length}：${Object.entries(counts).map(([k, v]) => `${UNIT_STATUS_LABEL[k as keyof typeof UNIT_STATUS_LABEL]} ${v}`).join('、') || '—'}</td></tr>
<tr><td>人工覆核進度</td><td>${reviewed}/${totalItems} 項已標記</td></tr>
${opt.reviewer ? `<tr><td>覆核人員</td><td>${escapeHtml(opt.reviewer)}</td></tr>` : ''}
</tbody></table>
<h2>文件清單與雜湊摘要（SHA-256）</h2><table><thead><tr><th style="width:30%">檔案（ZIP 內路徑）</th><th style="width:14%">角色</th><th style="width:10%">頁數／大小</th><th style="width:16%">讀取狀態</th><th>SHA-256</th></tr></thead><tbody>
${docs.map((d) => `<tr><td>${m(d.file.path)}</td><td>${ROLE_LABEL[d.role]}${d.roleManual ? '（人工指定）' : ''}</td><td>${d.pages.length} 頁／${Math.ceil(d.file.size / 1024)} KB</td><td>${escapeHtml(d.status)}${d.warnings.length ? `<div class="mut">${d.warnings.map(escapeHtml).join('<br>')}</div>` : ''}</td><td style="font-family:monospace;font-size:11px">${d.file.sha256}</td></tr>`).join('')}
</tbody></table>
${res.batchIssues.length ? `<h2>批次問題與待人工處理</h2><ul>${res.batchIssues.map((i) => `<li>[${i.level === 'error' ? '錯誤' : i.level === 'warning' ? '警示' : '資訊'}] ${m(i.message)}</li>`).join('')}</ul>` : ''}
<h2>逐項核對結果</h2>${units || '<p>沒有可核對的單位。</p>'}
<h2>未完成或無法執行的檢查</h2>${res.notDone.length ? `<ul>${res.notDone.map((x) => `<li>${m(x)}</li>`).join('')}</ul>` : '<p>依目前規則無未完成項目；仍須人工確認標示為「需人工判斷」「缺資料」「部分核對」的項目。</p>'}
<div class="disc"><b>免責說明</b><br>${escapeHtml(DISCLAIMER)}<br>若結果顯示「未發現不一致」，僅代表「未發現符合目前規則的疑點」，不代表整份文件完全正確。</div>
</body></html>`;
}

export function buildCsvReport(res: FlowResult, opt: ReportOptions): string {
  const mm = (s: string) => (opt.mask ? maskText(s) : s);
  const rows: unknown[][] = [['批次', '核對單位', '單位狀態', '欄位', '狀態', '優先', '來源A', '來源A位置', '書狀B', '書狀B位置', '原因', '計算', '人工覆核', '備註', '規則版本']];
  for (const u of res.units) {
    for (const i of u.items) {
      rows.push([
        opt.batchName,
        mm(u.label),
        UNIT_STATUS_LABEL[unitStatus(u)],
        i.field,
        STATUS_LABEL[i.status],
        SEVERITY_LABEL[i.severity],
        i.a ? mm(i.a.normalized) : '',
        i.a?.prov ? mm(provLabel(i.a.prov)) : '',
        i.b ? mm(i.b.normalized) : '',
        i.b?.prov ? mm(provLabel(i.b.prov)) : '',
        mm(i.reason),
        i.calc ? mm(i.calc) : '',
        REVIEW_LABEL[i.review.state],
        mm(i.review.note),
        res.ruleVersion,
      ]);
    }
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}
