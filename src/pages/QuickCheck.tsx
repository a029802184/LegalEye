// 快速文字校對頁：保留舊版 LegalDesk「強執狀校對」的操作方式（貼上文字＋人工基準資料），
// 並加入 DOCX 匯入與新版比對引擎。
import { useRef, useState } from 'react';
import { useApp, type CheckSession } from '../state/store';
import { PageHead } from '../ui/components';
import { readFileBytes } from '../ui/util';
import { parseOne } from '../core/ingest';
import { sha256Hex } from '../core/hash';
import { uid } from '../core/text';
import type { ExtractedDoc } from '../core/types';
import { runQuickCheck, type QuickBaseline } from '../flows/quick';
import { Results } from './check/Results';

const EMPTY: QuickBaseline = { creditor: '', debtor: '', caseNo: '', principal: '' };

function textDoc(name: string, text: string): ExtractedDoc {
  const data = new TextEncoder().encode(text);
  return {
    file: { id: uid('f'), name, path: name, kind: 'txt', size: data.length, sha256: sha256Hex(data), data },
    status: 'ok',
    warnings: [],
    pages: [{ page: 1, text, method: 'txt', confidence: 1 }],
    fullText: text,
    role: 'enforcement-petition',
    roleCandidates: [],
  };
}

export function QuickCheckPage() {
  const { settings, toast } = useApp();
  const [base, setBase] = useState<QuickBaseline>(EMPTY);
  const [text, setText] = useState('');
  const [doc, setDoc] = useState<ExtractedDoc | null>(null);
  const [session, setSession] = useState<CheckSession | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = (d: ExtractedDoc | null = doc, b = base) => {
    const target = d ?? (text.trim() ? textDoc('貼上的文字.txt', text) : null);
    if (!target || !target.fullText.trim()) return toast('請先貼上書狀文字或匯入檔案', 'error');
    const result = runQuickCheck(target, b, { settings });
    setSession({ flow: 'B', batchName: `快速文字校對：${target.file.name}`, docs: [target], skipped: [], folders: [], errors: [], result, service: {}, manualPairs: {} });
  };

  const onFile = async (f: File) => {
    if (f.size > 5 * 1024 * 1024) return toast('檔案請勿超過 5 MB', 'error');
    const ext = f.name.toLowerCase().split('.').pop();
    if (ext !== 'txt' && ext !== 'docx') return toast('只支援 .txt 或 .docx', 'error');
    const data = await readFileBytes(f);
    const d = await parseOne({ id: uid('f'), name: f.name, path: f.name, kind: ext, size: data.length, sha256: sha256Hex(data), data }, {});
    if (d.status === 'error') return toast('讀取失敗：' + d.warnings.join('；'), 'error');
    d.role = 'enforcement-petition';
    setDoc(d);
    setText(d.fullText);
    if (d.warnings.length) toast(d.warnings[0]);
  };

  const clear = () => {
    setBase(EMPTY);
    setText('');
    setDoc(null);
    setSession(null);
  };

  const field = (k: keyof QuickBaseline, label: string) => (
    <label className="field">
      <span>{label}</span>
      <input className="input" value={base[k]} maxLength={120} onChange={(e) => setBase({ ...base, [k]: e.target.value })} />
    </label>
  );

  return (
    <>
      <PageHead title="快速文字校對" desc="舊版「強執狀校對」功能：貼上書狀文字或匯入 TXT／DOCX，對照人工輸入的案件基準資料。沒有基準資料的欄位不判定對錯。" />
      <div className="grid-2">
        <section className="panel">
          <div className="panel-head"><h2>1. 案件基準資料（人工確認後輸入）</h2></div>
          <div className="panel-body">
            <div className="form-grid">
              {field('creditor', '債權人')}
              {field('debtor', '債務人')}
              {field('caseNo', '執行名義案號')}
              {field('principal', '本金（元）')}
            </div>
            <p className="cell-sub">空白欄位會略過比對；系統不會自行認定哪個值才是正確的。</p>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>2. 書狀內容</h2>
            <div className="toolbar">
              <button className="btn small" onClick={() => fileRef.current?.click()}>匯入 TXT／DOCX</button>
              <input ref={fileRef} type="file" hidden accept=".txt,.docx,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onFile(f); }} />
            </div>
          </div>
          <div className="panel-body">
            <label className="field">
              <span>聲請狀全文{doc ? `（已匯入 ${doc.file.name}，修改文字會改用貼上內容）` : ''}</span>
              <textarea className="input" rows={10} value={text} onChange={(e) => { setText(e.target.value); setDoc(null); }} placeholder="請將 Word 聲請狀的文字貼在這裡…" />
            </label>
            <div className="toolbar" style={{ marginTop: 8 }}>
              <button className="btn primary" onClick={() => run()}>執行文字檢查</button>
              <button className="btn" onClick={clear}>清空</button>
            </div>
          </div>
        </section>
      </div>
      {session?.result && <Results session={session} onChange={setSession} onRerun={() => run()} />}
    </>
  );
}
