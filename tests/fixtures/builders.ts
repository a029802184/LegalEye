// 測試檔案產生器（全部為合成資料）。可在瀏覽器與 Node 測試中共用。
// - DOCX：可指定紅字 run、以樣式繼承的紅字、分頁、表格
// - PDF：使用 Adobe 預定義 CMap（UniCNS-UCS2-H，不內嵌字型）產生具文字層的繁中 PDF；
//        也可產生「無文字層」頁面模擬掃描檔
// - ZIP：JSZip

import JSZip from 'jszip';

// ---------------- DOCX ----------------

export interface DRun {
  text: string;
  red?: boolean;
  /** 以字元樣式 RedMark 呈現紅字（測試樣式繼承） */
  styleRed?: boolean;
  color?: string;
}
export type DBlock = { runs: DRun[] } | { table: string[][] };

function x(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function runXml(r: DRun): string {
  const props: string[] = [];
  if (r.styleRed) props.push('<w:rStyle w:val="RedMark"/>');
  if (r.red) props.push('<w:color w:val="FF0000"/>');
  else if (r.color) props.push(`<w:color w:val="${r.color}"/>`);
  return `<w:r>${props.length ? `<w:rPr>${props.join('')}</w:rPr>` : ''}<w:t xml:space="preserve">${x(r.text)}</w:t></w:r>`;
}

function blockXml(b: DBlock): string {
  if ('table' in b) {
    return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${b.table
      .map((row) => `<w:tr>${row.map((c) => `<w:tc><w:p>${runXml({ text: c })}</w:p></w:tc>`).join('')}</w:tr>`)
      .join('')}</w:tbl>`;
  }
  return `<w:p>${b.runs.map(runXml).join('')}</w:p>`;
}

/** pages：每頁的段落；頁與頁之間插入明確分頁符號 */
export async function buildDocx(pages: DBlock[][]): Promise<Uint8Array> {
  const body = pages
    .map((blocks, i) => blocks.map(blockXml).join('') + (i < pages.length - 1 ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : ''))
    .join('');
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  );
  zip.file(
    'word/styles.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:eastAsia="標楷體"/><w:sz w:val="28"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="character" w:styleId="RedBase"><w:name w:val="Red Base"/><w:rPr><w:color w:val="C00000"/></w:rPr></w:style><w:style w:type="character" w:styleId="RedMark"><w:name w:val="Red Mark"/><w:basedOn w:val="RedBase"/><w:rPr><w:b/></w:rPr></w:style></w:styles>',
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/** 簡便寫法：字串中以【】包住的文字為紅字 */
export function para(s: string): DBlock {
  const runs: DRun[] = [];
  const re = /【([^】]*)】/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if ((m.index ?? 0) > last) runs.push({ text: s.slice(last, m.index) });
    runs.push({ text: m[1], red: true });
    last = (m.index ?? 0) + m[0].length;
  }
  if (last < s.length) runs.push({ text: s.slice(last) });
  return { runs };
}

// ---------------- PDF ----------------

function ucs2Hex(s: string): string {
  let h = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c > 0xffff) continue;
    h += c.toString(16).padStart(4, '0').toUpperCase();
  }
  return h;
}

export interface PdfPageSpec {
  lines: string[];
  /** true：只畫灰色方塊、不含文字層（模擬掃描） */
  scanned?: boolean;
  raster?: { width: number; height: number; jpegHex: string };
}

export function buildPdf(pages: PdfPageSpec[]): Uint8Array {
  const objs: string[] = [];
  // 1 catalog, 2 pages, 3 font, 4 cidfont, 5 descriptor, then page/content pairs
  const pageIds: number[] = [];
  const contents: string[] = [];
  pages.forEach((p, i) => {
    const pageId = 6 + i * 2;
    pageIds.push(pageId);
    let stream: string;
    if (p.raster) {
      stream = 'q 535 0 0 260 30 520 cm /Picture Do Q';
    } else if (p.scanned) {
      stream = '0.85 g 60 420 475 360 re f 0.6 g 80 700 300 14 re f 80 670 380 14 re f 80 640 340 14 re f';
    } else {
      const lines = p.lines.map((ln, j) => `BT /F1 12 Tf 1 0 0 1 56 ${790 - j * 20} Tm <${ucs2Hex(ln)}> Tj ET`);
      stream = lines.join('\n');
    }
    contents.push(stream);
  });
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type0 /BaseFont /MSung-Light /Encoding /UniCNS-UCS2-H /DescendantFonts [4 0 R] >>';
  objs[4] = '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /MSung-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (CNS1) /Supplement 0 >> /FontDescriptor 5 0 R /DW 1000 >>';
  objs[5] = '<< /Type /FontDescriptor /FontName /MSung-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>';
  let nextImage = 6 + pages.length * 2;
  pages.forEach((spec, i) => {
    const pageId = 6 + i * 2;
    const contentId = pageId + 1;
    let xobject = '';
    if (spec.raster) {
      const { width, height, jpegHex } = spec.raster;
      const image = nextImage++;
      objs[image] = `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCIIHexDecode /DCTDecode] /Length ${jpegHex.length + 1} >>\nstream\n${jpegHex}>\nendstream`;
      xobject = `/XObject << /Picture ${image} 0 R >>`;
    }
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> ${xobject} >> /Contents ${contentId} 0 R >>`;
    const s = contents[i];
    objs[contentId] = `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
  });
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * 僅供 Node 單元測試：讀回 buildPdf 產生的文字（解碼 UCS-2 十六進位字串）。
 * 正式網站使用 PDF.js 抽取。
 */
export function readTestPdf(data: Uint8Array): { page: number; text: string; needsOcr: boolean }[] {
  let s = '';
  for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
  const streams = [...s.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => m[1]);
  return streams.map((st, i) => {
    const lines = [...st.matchAll(/<([0-9A-F]*)> Tj/g)].map((m) => {
      let t = '';
      for (let j = 0; j < m[1].length; j += 4) t += String.fromCharCode(parseInt(m[1].slice(j, j + 4), 16));
      return t;
    });
    const text = lines.join('\n');
    return { page: i + 1, text, needsOcr: text.replace(/\s/g, '').length < 12 };
  });
}

// ---------------- ZIP ----------------

export async function buildZip(files: Record<string, Uint8Array | string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, data] of Object.entries(files)) zip.file(path, data);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

// ---------------- 身分證（虛構、檢查碼正確） ----------------

const LETTER_CODE: Record<string, number> = { A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, G: 16, H: 17, J: 18, K: 19, L: 20, M: 21, N: 22, P: 23, Q: 24, R: 25, S: 26, T: 27, U: 28, V: 29, X: 30, Y: 31, W: 32, Z: 33, I: 34, O: 35 };

export function fakeId(letter: string, body8: string): string {
  const code = LETTER_CODE[letter];
  const d = [Math.floor(code / 10), code % 10, ...body8.split('').map(Number)];
  const w = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const sum = d.reduce((a, v, i) => a + v * w[i], 0);
  const check = (10 - (sum % 10)) % 10;
  return letter + body8 + check;
}
