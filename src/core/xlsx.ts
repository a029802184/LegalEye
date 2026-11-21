// 輕量 XLSX 讀寫（JSZip + XML），不需大型試算表套件。
// 讀取：工作表、儲存格值、顯示文字、公式、公式快取值；公式無快取值時明確標示。
// 寫入：多工作表、表頭樣式、欄寬、凍結窗格、下拉清單資料驗證。

import JSZip from 'jszip';
import type { Cell, Sheet } from './types';

function kids(el: Element, local?: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstElementChild; n; n = n.nextElementSibling) if (!local || n.localName === local) out.push(n);
  return out;
}
function kid(el: Element | null, local: string): Element | null {
  if (!el) return null;
  for (let n = el.firstElementChild; n; n = n.nextElementSibling) if (n.localName === local) return n;
  return null;
}
function parseXml(s: string): Document {
  const d = new DOMParser().parseFromString(s, 'application/xml');
  if (d.getElementsByTagName('parsererror').length) throw new Error('XLSX 內部 XML 結構錯誤');
  return d;
}

export function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
export function indexToCol(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
export function splitRef(ref: string): { col: number; row: number } {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref);
  if (!m) return { col: 0, row: 0 };
  return { col: colToIndex(m[1]), row: Number(m[2]) };
}

const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormat(id: number, code?: string): boolean {
  if (BUILTIN_DATE_FMT.has(id)) return true;
  if (!code) return false;
  const c = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  return /[ymd]/i.test(c) && !/[#0]/.test(c.replace(/[ymdhs]/gi, ''));
}

function serialToISO(serial: number, date1904: boolean): string {
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(base + Math.round(serial * 86400000));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export interface XlsxReadResult {
  sheets: Sheet[];
  warnings: string[];
}

export async function readXlsx(data: Uint8Array): Promise<XlsxReadResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new Error('XLSX 檔無法開啟（可能已損毀、加密或並非 XLSX）');
  }
  const wbFile = zip.file('xl/workbook.xml');
  if (!wbFile) throw new Error('找不到 xl/workbook.xml，這不是有效的 XLSX');
  const warnings: string[] = [];
  const wb = parseXml(await wbFile.async('string'));
  const date1904 = kid(wb.documentElement, 'workbookPr')?.getAttribute('date1904') === '1';

  const rels = new Map<string, string>();
  const relFile = zip.file('xl/_rels/workbook.xml.rels');
  if (relFile) {
    const r = parseXml(await relFile.async('string'));
    for (const rel of kids(r.documentElement, 'Relationship')) {
      let target = rel.getAttribute('Target') ?? '';
      target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
      rels.set(rel.getAttribute('Id') ?? '', target);
    }
  }

  const shared: string[] = [];
  const ssFile = zip.file('xl/sharedStrings.xml');
  if (ssFile) {
    const ss = parseXml(await ssFile.async('string'));
    for (const si of kids(ss.documentElement, 'si')) {
      let t = '';
      const walk = (e: Element) => {
        for (const c of kids(e)) {
          if (c.localName === 't') t += c.textContent ?? '';
          else if (c.localName === 'r') walk(c);
        }
      };
      walk(si);
      shared.push(t);
    }
  }

  const xfFmt: number[] = [];
  const customFmt = new Map<number, string>();
  const stFile = zip.file('xl/styles.xml');
  if (stFile) {
    const st = parseXml(await stFile.async('string'));
    for (const f of kids(kid(st.documentElement, 'numFmts') ?? st.documentElement, 'numFmt')) {
      customFmt.set(Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') ?? '');
    }
    for (const xf of kids(kid(st.documentElement, 'cellXfs') ?? st.documentElement, 'xf')) {
      xfFmt.push(Number(xf.getAttribute('numFmtId') ?? 0));
    }
  }

  const sheets: Sheet[] = [];
  let noCache = 0;
  for (const s of kids(kid(wb.documentElement, 'sheets') ?? wb.documentElement, 'sheet')) {
    const name = s.getAttribute('name') ?? 'Sheet';
    const rid = s.getAttribute('r:id') ?? s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? '';
    const path = rels.get(rid);
    const f = path ? zip.file(path) : null;
    if (!f) {
      warnings.push(`工作表「${name}」找不到內容，已略過`);
      continue;
    }
    const x = parseXml(await f.async('string'));
    const cells = new Map<string, Cell>();
    let maxRow = 0;
    let maxCol = 0;
    const sd = kid(x.documentElement, 'sheetData');
    for (const row of sd ? kids(sd, 'row') : []) {
      for (const c of kids(row, 'c')) {
        const ref = c.getAttribute('r') ?? '';
        const { col, row: r } = splitRef(ref);
        const t = c.getAttribute('t') ?? 'n';
        const sIdx = Number(c.getAttribute('s') ?? 0);
        const fEl = kid(c, 'f');
        const vEl = kid(c, 'v');
        const v = vEl?.textContent ?? null;
        let value: Cell['value'] = null;
        let text = '';
        if (t === 's' && v !== null) value = text = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') value = text = kid(c, 'is')?.textContent ?? '';
        else if (t === 'str') value = text = v ?? '';
        else if (t === 'b') {
          value = v === '1';
          text = value ? 'TRUE' : 'FALSE';
        } else if (t === 'e') value = text = v ?? '#ERROR';
        else if (v !== null && v !== '') {
          const num = Number(v);
          value = num;
          const fmtId = xfFmt[sIdx] ?? 0;
          text = isDateFormat(fmtId, customFmt.get(fmtId)) ? serialToISO(num, date1904) : String(num);
        }
        const formula = fEl ? (fEl.textContent || (fEl.getAttribute('t') === 'shared' ? '（共用公式）' : '')) : undefined;
        const formulaNoCache = !!fEl && (v === null || v === '');
        if (formulaNoCache) noCache++;
        if (value === null && !formula) continue;
        cells.set(ref, { ref, row: r, col, value, text, formula: formula || undefined, formulaNoCache });
        maxRow = Math.max(maxRow, r);
        maxCol = Math.max(maxCol, col);
      }
    }
    sheets.push({ name, cells, maxRow, maxCol });
  }
  if (noCache) warnings.push(`有 ${noCache} 個公式儲存格沒有計算結果（檔案未在 Excel 重新計算後儲存），這些值不能視為已核對。`);
  return { sheets, warnings };
}

export function cellAt(sheet: Sheet, row: number, col: number): Cell | undefined {
  return sheet.cells.get(indexToCol(col) + row);
}

export function sheetToRows(sheet: Sheet): string[][] {
  const rows: string[][] = [];
  for (let r = 1; r <= sheet.maxRow; r++) {
    const row: string[] = [];
    for (let c = 1; c <= sheet.maxCol; c++) row.push(cellAt(sheet, r, c)?.text ?? '');
    rows.push(row);
  }
  return rows;
}

export function sheetText(sheet: Sheet): string {
  return sheetToRows(sheet)
    .map((r) => r.join('\t').replace(/\t+$/, ''))
    .filter((x) => x.trim())
    .join('\n');
}

// ---------------- 寫入 ----------------

export type WCell = string | number | null | { f: string; v?: number | string };

export interface WSheet {
  name: string;
  rows: WCell[][];
  colWidths?: number[];
  freezeHeader?: boolean;
  /** 第一列使用表頭樣式 */
  header?: boolean;
  validations?: { sqref: string; formula: string; prompt?: string }[];
}

function xmlEsc(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sheetXml(s: WSheet): string {
  const rows = s.rows
    .map((row, ri) => {
      const r = ri + 1;
      const cells = row
        .map((v, ci) => {
          if (v === null || v === '') return '';
          const ref = indexToCol(ci + 1) + r;
          const style = s.header && ri === 0 ? ' s="1"' : ' s="2"';
          if (typeof v === 'number') return `<c r="${ref}"${style}><v>${v}</v></c>`;
          if (typeof v === 'object') {
            const cached = v.v === undefined ? '' : typeof v.v === 'number' ? `<v>${v.v}</v>` : `<v>${xmlEsc(String(v.v))}</v>`;
            const t = typeof v.v === 'string' ? ' t="str"' : '';
            return `<c r="${ref}"${style}${t}><f>${xmlEsc(v.f)}</f>${cached}</c>`;
          }
          return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r}">${cells}</row>`;
    })
    .join('');
  const cols = s.colWidths?.length
    ? `<cols>${s.colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const views = s.freezeHeader
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : '';
  const dv = s.validations?.length
    ? `<dataValidations count="${s.validations.length}">${s.validations
        .map(
          (v) =>
            `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1"${v.prompt ? ` prompt="${xmlEsc(v.prompt)}"` : ''} sqref="${v.sqref}"><formula1>${xmlEsc(v.formula)}</formula1></dataValidation>`,
        )
        .join('')}</dataValidations>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${views}${cols}<sheetData>${rows}</sheetData>${dv}</worksheet>`;
}

export async function writeXlsx(sheets: WSheet[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
      .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('')}</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map((s, i) => `<sheet name="${xmlEsc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  zip.file(
    'xl/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Microsoft JhengHei"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft JhengHei"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF243E59"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs></styleSheet>`,
  );
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
