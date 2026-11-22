import { useRef, useState } from 'react';
import { decodeText } from '../../core/ingest';
import { ROLE_LABEL, type CheckUnit, type ChromePageText, type DocRole, type ExtractedDoc } from '../../core/types';
import { validChromeText } from '../../flows/chromeText';
import { provAt } from '../../flows/common';
import { readFileBytes } from '../../ui/util';
import { DocViewer } from './DocViewer';

export function ChromeTextForm({ docs, units, roles, initial, onSave }: {
  docs: ExtractedDoc[];
  units: CheckUnit[];
  roles: DocRole[];
  initial?: CheckUnit;
  onSave: (source: ChromePageText) => void;
}) {
  const pdfs = docs.filter((doc) => doc.file.kind === 'pdf' && doc.pages.length);
  const linked = initial?.docs.find((source) => pdfs.some((doc) => doc.file.id === source.fileId && doc.pages.length));
  const [unitId, setUnitId] = useState(initial?.id ?? '');
  const [fileId, setFileId] = useState(linked?.fileId ?? '');
  const [page, setPage] = useState(linked?.pages?.length === 1 ? linked.pages[0] : 0);
  const [role, setRole] = useState<DocRole>(linked?.role ?? 'unknown');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState('');
  const txtRead = useRef(0);
  const doc = pdfs.find((candidate) => candidate.file.id === fileId);
  const unit = units.find((candidate) => candidate.id === unitId);
  const roleOptions: DocRole[] = roles.filter((entry) => entry !== 'merged-source' && entry !== 'debt-table');
  const mobile = /Android|iPhone|iPad|Mobile/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  return <div className="chrome-text">
    <ol className="scan-steps">
      <li>在公司允許的桌面 Chrome 開啟電腦裡的原始 PDF。請勿上傳或儲存到雲端硬碟。</li>
      <li>等文字可反白選取後，複製要核對的一頁。多人同頁時，只複製本案人物的欄位。</li>
      <li>回到法眼，選擇案件、原始 PDF、文件類型和頁碼，再貼上文字或選取純文字檔。</li>
      <li>按「重新核對這一頁」，再對照原件確認欄位。</li>
    </ol>
    <p className="cell-sub">{mobile ? '此裝置可用自動讀取或手動更正，也可貼入已在核准電腦取得的文字。' : 'Chrome 能否選取掃描文字取決於版本與公司設定。若無法複製，可用法眼自動讀取或手動更正。'}</p>
    {!pdfs.length ? <p>請先選擇原始 PDF。</p> : !units.length ? <p>請先確認書狀的文件類型，以建立可連結的案件。</p> : <form className="form-grid" onSubmit={(event) => {
      event.preventDefault();
      if (!doc || !unit || !doc.pages.some((p) => p.page === page) || !roleOptions.includes(role) || !validChromeText(text)) {
        setError('請選擇案件、PDF、文件類型及頁碼，並輸入一頁的文字（最多 60,000 字元）。');
        return;
      }
      if (unit.docs.some((link) => link.role === role && link.pages?.length)
        && !unit.docs.some((link) => link.role === role && link.fileId === fileId && (!link.pages || link.pages.includes(page)))) {
        setError('所選文件或頁碼與本案已配對的來源不同。請先在案件結果確認配對。');
        return;
      }
      if (doc.role !== 'unknown' && doc.role !== 'merged-source' && doc.role !== role
        && !unit.docs.some((link) => link.role === role && link.fileId === fileId && (!link.pages || link.pages.includes(page)))) {
        setError('所選類型與原始 PDF 的分類不同。請先在檔案清單確認分類。');
        return;
      }
      txtRead.current++;
      onSave({ unitId, fileId, page, role, text });
      setText('');
      setError('');
    }}>
      <label className="field"><span>案件／當事人</span><select className="input" value={unitId} onChange={(e) => setUnitId(e.target.value)} required>
        <option value="">請選擇案件</option>
        {units.map((candidate, index) => <option key={candidate.id} value={candidate.id}>{index + 1}. {candidate.label} · {candidate.subLabel}</option>)}
      </select></label>
      <label className="field"><span>原始 PDF</span><select className="input" value={fileId} onChange={(e) => {
        const next = pdfs.find((candidate) => candidate.file.id === e.target.value);
        setFileId(e.target.value);
        setRole(next && roleOptions.includes(next.role) ? next.role : 'unknown');
        setPage(0);
        setPreview(false);
      }} required>
        <option value="">請選擇 PDF</option>{pdfs.map((candidate) => <option key={candidate.file.id} value={candidate.file.id}>{candidate.file.path}</option>)}
      </select></label>
      <label className="field"><span>文件類型</span><select className="input" value={role === 'unknown' || role === 'merged-source' ? '' : role} onChange={(e) => setRole((e.target.value || 'unknown') as DocRole)} required>
        <option value="">請選擇類型</option>{roleOptions.map((entry) => <option key={entry} value={entry}>{ROLE_LABEL[entry]}</option>)}
      </select></label>
      <label className="field"><span>原件頁碼</span><select className="input" value={page || ''} onChange={(e) => setPage(Number(e.target.value))} disabled={!doc} required>
        <option value="">請選擇頁碼</option>{doc?.pages.map((entry) => <option key={entry.page} value={entry.page}>第 {entry.page} 頁</option>)}
      </select></label>
      {doc && page > 0 && <div className="chrome-wide">
        <button type="button" className="btn small" aria-expanded={preview} onClick={() => setPreview(!preview)}>{preview ? '收合原件' : '檢查這一頁'}</button>
        {preview && <DocViewer key={`${fileId}:${page}`} doc={doc} prov={provAt(doc, page, 0, '')} />}
      </div>}
      <label className="field chrome-wide"><span>貼上 Chrome 辨識的文字</span><textarea className="input" rows={6} maxLength={60_000} autoComplete="off" spellCheck={false} value={text} onChange={(e) => {
        txtRead.current++;
        setText(e.target.value);
      }} required /></label>
      <label className="field chrome-wide"><span>從本機匯入一頁純文字（.txt）</span><input type="file" accept=".txt" onChange={async (e) => {
        const file = e.currentTarget.files?.[0];
        e.currentTarget.value = '';
        if (!file) return;
        const request = ++txtRead.current;
        if (file.size > 240_000 || !/\.txt$/i.test(file.name)) { setError('請選擇 240 KB 以內的 .txt 檔。'); return; }
        try {
          const imported = decodeText(await readFileBytes(file));
          if (request !== txtRead.current) return;
          if (!validChromeText(imported)) { setError('此檔無法當作一頁純文字讀取。'); return; }
          setText(imported);
          setError('');
        } catch { if (request === txtRead.current) setError('無法讀取這個文字檔，請直接貼上文字。'); }
      }} /></label>
      <div className="toolbar chrome-wide"><button className="btn primary" type="submit">重新核對這一頁</button></div>
      {error && <p className="note bad chrome-wide" role="alert">{error}</p>}
    </form>}
  </div>;
}
