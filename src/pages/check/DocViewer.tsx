// 原文檢視：PDF 單頁渲染（可縮放、換頁）、DOCX 段落（紅字標示）、XLSX 儲存格、TXT。
// PDF 一次只渲染一頁，避免行動裝置記憶體不足。

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExtractedDoc, Provenance } from '../../core/types';
import { cellAt, splitRef } from '../../core/xlsx';
import { isLowMemoryDevice } from '../../ui/util';

type PdfMod = typeof import('../../core/pdf');
const pdfCache = new WeakMap<Uint8Array, Promise<Awaited<ReturnType<PdfMod['openPdf']>>>>();

function cleanSnippet(s: string): string {
  return s.replace(/^…|…$/g, '').trim().slice(0, 60);
}

function Highlight({ text, needle }: { text: string; needle: string }) {
  const n = cleanSnippet(needle);
  const i = n ? text.normalize('NFKC').indexOf(n.normalize('NFKC')) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + n.length)}</mark>
      {text.slice(i + n.length)}
    </>
  );
}

export function DocViewer({ doc, prov }: { doc: ExtractedDoc; prov: Provenance }) {
  if (doc.file.kind === 'pdf') return <PdfView doc={doc} prov={prov} />;
  if (doc.file.kind === 'docx') return <DocxView doc={doc} prov={prov} />;
  if (doc.file.kind === 'xlsx') return <XlsxView doc={doc} prov={prov} />;
  return <TextView doc={doc} prov={prov} />;
}

function PdfView({ doc, prov }: { doc: ExtractedDoc; prov: Provenance }) {
  const total = doc.pages.length;
  const [page, setPage] = useState(prov.page ?? 1);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [showText, setShowText] = useState(doc.pages.find((p) => p.page === page)?.method === 'ocr');
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const pt = doc.pages.find((p) => p.page === page);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBusy(true);
      setErr('');
      try {
        const mod: PdfMod = await import('../../core/pdf');
        let p = pdfCache.get(doc.file.data);
        if (!p) {
          p = mod.openPdf(doc.file.data);
          pdfCache.set(doc.file.data, p);
        }
        const pdf = await p;
        if (cancelled || !canvas.current) return;
        const pg = await pdf.getPage(page);
        const base = pg.getViewport({ scale: 1 }).width;
        const width = (box.current?.clientWidth ?? 600) - 4;
        const scale = zoom === 'fit' ? width / base : zoom;
        await mod.renderPdfPage(pdf, page, canvas.current, scale * (window.devicePixelRatio > 1 ? 1.5 : 1), isLowMemoryDevice() ? 2_500_000 : 6_000_000);
        canvas.current.style.width = `${Math.round(base * scale)}px`;
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, page, zoom]);

  const z = zoom === 'fit' ? 1 : zoom;
  return (
    <div className="viewer">
      <div className="viewer-bar">
        <button className="btn small" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="上一頁">‹</button>
        <label>
          <span className="sr-only">頁碼</span>
          <select className="input" style={{ width: 'auto', minHeight: 32 }} value={page} onChange={(e) => setPage(Number(e.target.value))}>
            {doc.pages.map((p) => (
              <option key={p.page} value={p.page}>
                第 {p.page} / {total} 頁{p.page === prov.page ? '（差異位置）' : ''}
              </option>
            ))}
          </select>
        </label>
        <button className="btn small" disabled={page >= total} onClick={() => setPage(page + 1)} aria-label="下一頁">›</button>
        <button className="btn small" onClick={() => setZoom(Math.max(0.5, z - 0.25))} aria-label="縮小">－</button>
        <button className="btn small" onClick={() => setZoom('fit')}>符合寬度</button>
        <button className="btn small" onClick={() => setZoom(Math.min(4, z + 0.25))} aria-label="放大">＋</button>
        {prov.page && page !== prov.page && (
          <button className="btn small" onClick={() => setPage(prov.page!)}>回到差異頁</button>
        )}
        <button className="btn small" aria-pressed={showText} onClick={() => setShowText(!showText)}>
          {showText ? '隱藏' : '顯示'}辨識出的文字
        </button>
        {busy && <span className="cell-sub">繪製中…</span>}
      </div>
      {err && <div className="note bad" style={{ margin: 8 }}>無法顯示原頁：{err}</div>}
      <div className="viewer-canvas" ref={box}>
        <canvas ref={canvas} aria-label={`${doc.file.name} 第 ${page} 頁影像`} />
      </div>
      {pt && (pt.method === 'ocr' || pt.needsOcr) && <ScanReview key={page} doc={doc} page={page} prov={page === prov.page ? prov : undefined} />}
      {showText && pt && (
        <div className="viewer-text">
          <div className="cell-sub">
            {pt.method === 'ocr' ? '電腦從掃描圖片讀出的文字，請對照上方原頁' : pt.needsOcr ? '這頁是掃描圖片，目前沒有可讀的文字' : 'PDF 內可選取的文字'}
          </div>
          {page === prov.page ? <Highlight text={pt.text} needle={prov.raw} /> : pt.text}
          {pt.scan && <details><summary>辨識原文及其他候選</summary><pre>{pt.scan.raw || '未讀到文字'}</pre>{pt.scan.alternate && <pre>{pt.scan.alternate}</pre>}</details>}
        </div>
      )}
    </div>
  );
}

function ScanReview({ doc, page, prov }: { doc: ExtractedDoc; page: number; prov?: Provenance }) {
  const crop = useRef<HTMLCanvasElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();
  const region = prov?.region;
  useEffect(() => {
    if (!region) return;
    let active = true;
    import('../../core/ocr').then((mod) => mod.renderScanRegion(doc.file.data, page, region, isLowMemoryDevice())).then((image) => {
      const canvas = crop.current;
      if (active && canvas) {
        canvas.width = image.width;
        canvas.height = image.height;
        canvas.getContext('2d')?.drawImage(image, 0, 0);
      }
      image.width = image.height = 0;
    }).catch(() => { if (active) setResult('無法顯示局部影像，請參考上方原頁。'); });
    return () => { active = false; };
  }, [doc.file.data, page, region]);
  return <div className="viewer-text">
    {region && <canvas ref={crop} className="field-crop" aria-label="欄位原圖裁切" />}
    <button className="btn small" disabled={busy} onClick={async () => {
      setBusy(true);
      setResult(undefined);
      try {
        const { retryScan } = await import('../../core/ocr');
        setResult(await retryScan(doc.file.data, page, region, isLowMemoryDevice()) || '這次仍未讀出文字，請看原件。');
      } catch { setResult('無法重新辨識，請查看原件。'); }
      finally { setBusy(false); }
    }}>{busy ? '正在重新辨識…' : region ? '重新辨識此欄區域' : '重新辨識這一頁'}</button>
    {result !== undefined && <><p>重新辨識的候選文字（請對照原件後再更正）</p><pre aria-live="polite">{result}</pre></>}
  </div>;
}

function DocxView({ doc, prov }: { doc: ExtractedDoc; prov: Provenance }) {
  const target = useRef<HTMLParagraphElement>(null);
  const paras = useMemo(() => (doc.paragraphs ?? []).filter((p) => !prov.page || p.page === prov.page || p.page === 0), [doc, prov.page]);
  useEffect(() => {
    target.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  return (
    <div className="viewer">
      <div className="viewer-bar">
        <span>{doc.file.name}{prov.page ? `・第 ${prov.page} 頁` : ''}</span>
        <span className="red-run">紅字</span>
        <span className="cell-sub">＝前端標示的變動欄位</span>
      </div>
      <div className="viewer-text" style={{ whiteSpace: 'normal' }}>
        {paras.map((p) => (
          <p key={p.index} ref={p.index === prov.para ? target : undefined} className={p.index === prov.para ? 'target' : ''}>
            {p.part !== 'body' && <span className="cell-sub">［{p.part === 'table' ? '表格' : p.part === 'header' ? '頁首' : '頁尾'}］</span>}
            {p.runs.map((r, i) => (r.red ? <span key={i} className="red-run">{r.text}</span> : <span key={i}>{r.text}</span>))}
          </p>
        ))}
      </div>
    </div>
  );
}

function XlsxView({ doc, prov }: { doc: ExtractedDoc; prov: Provenance }) {
  const sheet = doc.sheets?.find((s) => s.name === prov.sheet) ?? doc.sheets?.[0];
  if (!sheet) return <div className="viewer"><div className="viewer-text">找不到工作表</div></div>;
  const t = prov.cell && /^[A-Z]+\d+$/.test(prov.cell) ? splitRef(prov.cell) : { col: 1, row: 1 };
  const r0 = Math.max(1, t.row - 6);
  const r1 = Math.min(sheet.maxRow, t.row + 3);
  const cols = Array.from({ length: Math.min(sheet.maxCol, 12) }, (_, i) => i + 1);
  return (
    <div className="viewer">
      <div className="viewer-bar">{doc.file.name}・{sheet.name}{prov.cell ? `!${prov.cell}` : ''}</div>
      <div className="table-wrap" style={{ maxHeight: 320 }}>
        <table className="sheet-table">
          <tbody>
            {Array.from({ length: r1 - r0 + 1 }, (_, i) => r0 + i).map((r) => (
              <tr key={r}>
                <th>{r}</th>
                {cols.map((c) => {
                  const cell = cellAt(sheet, r, c);
                  const isT = r === t.row && c === t.col;
                  return (
                    <td key={c} className={isT ? 'target num' : 'num'} title={cell?.formula ? `公式：=${cell.formula}` : undefined}>
                      {cell?.formulaNoCache ? '（公式無結果）' : cell?.text ?? ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TextView({ doc, prov }: { doc: ExtractedDoc; prov: Provenance }) {
  const p = doc.pages.find((x) => x.page === (prov.page ?? 1)) ?? doc.pages[0];
  return (
    <div className="viewer">
      <div className="viewer-bar">{doc.file.name}{p ? `・第 ${p.page} 頁` : ''}</div>
      <div className="viewer-text">{p ? <Highlight text={p.text} needle={prov.raw} /> : '（無內容）'}</div>
    </div>
  );
}
