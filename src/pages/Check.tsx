import { useEffect, useRef, useState } from 'react';
import { useApp, type CheckSession } from '../state/store';
import { Icon, PageHead, useConfirm } from '../ui/components';
import { isLowMemoryDevice, readFileBytes } from '../ui/util';
import { FLOWS, runFlow } from '../flows';
import { ingest, type IngestProgress, type InputFile } from '../core/ingest';
import { ROLE_LABEL, type DocRole, type ExtractedDoc, type FlowId, type FlowResult } from '../core/types';
import { pageRole } from '../core/classify';
import { FlowCards } from '../ui/FlowCards';
import { Results } from './check/Results';

type UploadProgress = Omit<IngestProgress, 'phase'> & { phase: IngestProgress['phase'] | 'read' };
const PHASE: Record<UploadProgress['phase'], string> = { read: '讀取檔案', unzip: '解壓縮', parse: '解析文件', ocr: '本機 OCR', classify: '分類', done: '完成' };
const ROLES: Record<FlowId, DocRole[]> = {
  A: ['court-notice', 'notice-letter'],
  B: ['enforcement-petition', 'payment-order', 'finality-cert', 'service-proof'],
  C: ['payment-order-petition', 'debt-statement', 'household-register'],
  D: ['court-letter', 'civil-report', 'debt-table', 'attachment'],
};
const STEPS = ['上傳文件', '檔案辨識與確認', '開始核對與查看結果'];
const DOC_STATUS: Record<ExtractedDoc['status'], string> = {
  ok: '已讀取', partial: '部分讀取', 'needs-ocr': '需 OCR（掃描影像）', error: '讀取失敗', unsupported: '不支援',
};

/** 重新執行時保留人工覆核紀錄（依檔案＋單位＋欄位＋序號對應） */
function mergeReviews(prev: FlowResult | undefined, next: FlowResult): FlowResult {
  if (!prev) return next;
  const key = (u: FlowResult['units'][number], field: string, n: number) => `${u.docs[0]?.fileId}|${u.subLabel}|${field}|${n}`;
  const map = new Map<string, FlowResult['units'][number]['items'][number]['review']>();
  for (const u of prev.units) {
    const cnt = new Map<string, number>();
    for (const i of u.items) {
      const n = cnt.get(i.field) ?? 0;
      cnt.set(i.field, n + 1);
      if (i.review.state !== 'pending' || i.review.note) map.set(key(u, i.field, n), i.review);
    }
  }
  for (const u of next.units) {
    const cnt = new Map<string, number>();
    for (const i of u.items) {
      const n = cnt.get(i.field) ?? 0;
      cnt.set(i.field, n + 1);
      const r = map.get(key(u, i.field, n));
      if (r) i.review = { ...r };
    }
  }
  return next;
}

export function CheckPage({ flow }: { flow?: FlowId }) {
  if (!flow) return <FlowChooser />;
  return <FlowWorkspace key={flow} flow={flow} />;
}

function FlowChooser() {
  return (
    <div className="home-workspace">
      <PageHead title="法律文件核對" desc="選擇文件類型，確認來源文件後執行核對。" />
      <h2 className="sr-only">選擇核對類型</h2>
      <FlowCards />
      <p><a className="text-action" href="#/check/quick">快速文字校對</a> <span className="muted">貼上書狀文字或匯入 TXT／DOCX，與自行輸入的案件資料比對。</span></p>
    </div>
  );
}

function FlowWorkspace({ flow }: { flow: FlowId }) {
  const def = FLOWS.find((f) => f.id === flow)!;
  const { sessions, setSession, settings, toast } = useApp();
  const session = sessions[flow];
  const [confirm, confirmNode] = useConfirm();
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [over, setOver] = useState(false);
  const [ocr, setOcr] = useState(true);
  const [ocrReady, setOcrReady] = useState<boolean | null>(null);
  const [showFiles, setShowFiles] = useState(!session?.result);
  const abort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const filesHeading = useRef<HTMLHeadingElement>(null);
  const resultsRegion = useRef<HTMLDivElement>(null);
  const focusStep = useRef<2 | 3 | null>(null);
  const lowMem = isLowMemoryDevice();

  useEffect(() => {
    let alive = true;
    import('../core/ocr').then((m) => m.ocrAvailable()).then((ok) => alive && setOcrReady(ok)).catch(() => alive && setOcrReady(false));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const target = focusStep.current === 2 ? filesHeading.current : focusStep.current === 3 ? resultsRegion.current : null;
    target?.scrollIntoView({ block: 'start' });
    target?.focus({ preventScroll: true });
    focusStep.current = null;
  }, [session]);

  useEffect(() => () => abort.current?.abort(), []);

  const rerun = (s: CheckSession): CheckSession => {
    const result = mergeReviews(s.result, runFlow(flow, s.docs, { settings, service: s.service, manualPairs: s.manualPairs }));
    return { ...s, result };
  };

  const onFiles = async (list: FileList | File[]) => {
    if (abort.current || !list.length) return;
    const arr = [...list];
    const big = arr.find((f) => f.size > 200 * 1024 * 1024);
    if (big) return toast(`${big.name} 超過 200 MB，請分批處理`, 'error');
    const ac = new AbortController();
    abort.current = ac;
    try {
      if (session?.result && !(await confirm('匯入新檔案會清除目前的核對結果與人工覆核紀錄（未下載報告將遺失）。確定？', { danger: true, okText: '清除並匯入' }))) return;
      if (ac.signal.aborted) return;
      setProgress({ phase: 'read', done: 0, total: arr.length, label: '準備中' });
      const inputs: InputFile[] = [];
      for (const file of arr) {
        setProgress({ phase: 'read', done: inputs.length, total: arr.length, label: file.name });
        inputs.push({ name: file.name, data: await readFileBytes(file) });
        if (ac.signal.aborted) throw new DOMException('已取消', 'AbortError');
      }
      const r = await ingest(inputs, {
        signal: ac.signal,
        ocr: ocr && ocrReady !== false,
        lowMemory: lowMem,
        allowedRoles: def.roles,
        onProgress: setProgress,
      });
      if (ac.signal.aborted) throw new DOMException('已取消', 'AbortError');
      const batchName = arr.length === 1 ? arr[0].name : `${arr[0].name} 等 ${arr.length} 個檔案`;
      const s: CheckSession = { flow, batchName, docs: r.docs, skipped: r.skipped, folders: r.folders, errors: r.errors, service: {}, manualPairs: {} };
      focusStep.current = 2;
      setShowFiles(true);
      setSession(flow, s);
      toast(`已讀取 ${r.docs.length} 個檔案${r.skipped.length ? `，略過 ${r.skipped.length} 個` : ''}`);
    } catch (e) {
      if ((e as Error).name === 'AbortError') toast('已取消處理');
      else toast('處理失敗：' + (e as Error).message, 'error');
    } finally {
      setProgress(null);
      abort.current = null;
    }
  };

  const setRole = (doc: ExtractedDoc, role: DocRole) => {
    if (!session) return;
    const docs = session.docs.map((d) => (d === doc ? { ...d, role, roleManual: true } : d));
    const updated = { ...session, docs };
    setSession(flow, session.result ? rerun(updated) : updated);
    toast(`已將 ${doc.file.name} 指定為「${ROLE_LABEL[role]}」${session.result ? '並重新核對' : ''}`);
  };

  const beginCheck = () => {
    if (!session || !session.docs.some((d) => d.fullText.trim())) return;
    focusStep.current = 3;
    setShowFiles(false);
    setSession(flow, rerun(session));
  };

  const clear = async () => {
    const message = session?.result ? '清除本次文件、核對結果與人工覆核紀錄？請先下載需要留存的報告。' : '清除本次匯入的所有文件？';
    if (!(await confirm(message, { danger: true, okText: '清除' }))) return;
    setSession(flow, undefined);
    toast('已清除本次資料');
  };

  const pct = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;
  const step = progress ? 1 : session?.result ? 3 : session ? 2 : 1;
  const docs = session?.docs ?? [];
  const readable = docs.some((d) => d.fullText.trim());
  const mergedRoles = docs.filter((d) => d.role === 'merged-source').flatMap((d) => d.pages.map((p) => pageRole(p.text)));
  const roleStates = ROLES[flow].map((role) => {
    const found = docs.filter((d) => d.role === role);
    const identified = found.some((d) => role === 'attachment' ? d.status !== 'error' : !!d.fullText.trim()) || mergedRoles.includes(role);
    return { role, identified, status: identified ? '已辨識' : found.length ? '無法讀取' : '未辨識' };
  });
  const packing = flow === 'D' ? '將法院庭函、陳報狀、Excel 債務明細及附件放入同一個 ZIP。'
    : flow === 'C' ? '將同一批聲請狀、欠費明細及戶籍謄本放入同一個 ZIP。'
    : '可上傳包含所需文件的 ZIP，或一次選取多個檔案。';

  return (
    <>
      <PageHead
        title={def.title}
        desc={def.desc}
        actions={
          session && (
            <button className="btn danger" onClick={clear} disabled={!!progress}>
              清除本次資料
            </button>
          )
        }
      />
      <ol className="workflow-steps" aria-label="核對進度">
        {STEPS.map((label, i) => (
          <li key={label} aria-current={step === i + 1 ? 'step' : undefined} className={step > i + 1 ? 'complete' : undefined}>
            <span className="step-number" aria-hidden="true">{step > i + 1 ? <Icon name="check" size={15} /> : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      <section className="panel" aria-labelledby="h-upload">
        <div className="panel-head">
          <h2 id="h-upload">上傳文件</h2>
        </div>
        <div className="panel-body upload-layout">
          <div className="upload-guide">
            <h3>請準備以下文件</h3>
            <ul>{def.expects.map((label) => <li key={label}>{label}</li>)}</ul>
            <p>{packing}</p>
          </div>
          <div className="upload-controls">
            <div
              className={`drop ${over ? 'over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                if (!progress) setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                void onFiles(e.dataTransfer.files);
              }}
            >
              <button className="btn primary" onClick={() => inputRef.current?.click()} disabled={!!progress}>
                <Icon name="upload" size={18} />選擇檔案
              </button>
              <input
                ref={inputRef}
                type="file"
                multiple
                hidden
                accept=".zip,.pdf,.docx,.xlsx,.txt,.csv"
                onChange={(e) => {
                  if (e.target.files) void onFiles(e.target.files);
                  e.target.value = '';
                }}
                data-testid="file-input"
              />
              <p className="cell-sub">支援 ZIP、PDF、DOCX、XLSX、TXT、CSV</p>
              <p className="cell-sub only-desktop">也可以將檔案拖曳到這裡</p>
            </div>
            <div className="upload-options">
              <label className="check">
                <input type="checkbox" checked={ocr} disabled={!!progress} onChange={(e) => setOcr(e.target.checked)} />
                掃描 PDF 自動執行本機 OCR（繁體中文，較慢）
              </label>
              <span className="cell-sub">
                {ocrReady === null ? '檢查 OCR 元件…' : ocrReady ? 'OCR 元件已就緒（離線）' : 'OCR 語言資料未安裝：掃描頁將標示「需 OCR」'}
              </span>
            </div>
            {lowMem && ocr && <p className="cell-sub">行動裝置會逐頁辨識。大量掃描檔建議使用桌機。</p>}
            {progress && (
              <div style={{ marginTop: 10 }} role="status" aria-live="polite">
                <div className="toolbar" style={{ justifyContent: 'space-between' }}>
                  <span>{PHASE[progress.phase]}：{progress.label}（{progress.done}/{progress.total}）</span>
                  <button className="btn small danger" onClick={() => abort.current?.abort()}>取消</button>
                </div>
                <div className="progress" aria-hidden="true"><div style={{ width: `${pct}%` }} /></div>
              </div>
            )}
          </div>
        </div>
      </section>

      {session && (
        <section className="panel" aria-labelledby="h-files">
          <div className="panel-head">
            <h2 id="h-files" ref={filesHeading} tabIndex={-1}>檔案辨識與確認</h2>
            <button className="btn small" aria-expanded={showFiles} onClick={() => setShowFiles(!showFiles)}>
              {showFiles ? '收合' : `展開（${session.docs.length} 個檔案${session.skipped.length ? `、略過 ${session.skipped.length}` : ''}）`}
            </button>
          </div>
          {(!session.result || showFiles) && (
            <div className="panel-body">
              {showFiles && <>
                <ul className="role-summary" aria-label="所需文件辨識狀態">
                  {roleStates.map(({ role, identified, status }) => (
                    <li key={role}><span>{ROLE_LABEL[role]}</span><span className={`badge ${identified ? 'ok' : 'warn'}`}>{status}</span></li>
                  ))}
                </ul>
                <p className="cell-sub">{session.result ? '更正檔案分類後，系統會重新核對。' : '請確認每個檔案的分類。若有誤，可用各檔案的選單更正。'}</p>
                {session.errors.map((error, i) => <div key={i} className="note bad">{error}</div>)}
              </>}
              {!session.result && (
                <div className="check-next">
                  <p>{!readable ? '目前沒有可核對的文字，請確認檔案可讀或重新上傳。'
                    : roleStates.some(({ identified }) => !identified) ? '仍有文件未辨識或無法讀取。可先核對已讀取的文件，結果會列出缺漏。'
                    : '確認分類後，可查看核對結果、來源與校對報告。'}</p>
                  <button className="btn primary" onClick={beginCheck} disabled={!readable || !!progress}>開始核對</button>
                </div>
              )}
              {showFiles && <>
              <ul className="file-tree">
                {session.docs.map((d) => (
                  <li key={d.file.id}>
                    <div>
                      <div className="path">
                        {d.file.path.includes('/') && <span className="folder">{d.file.path.split('/').slice(0, -1).join(' / ')} / </span>}
                        <b>{d.file.name}</b>
                      </div>
                      <div className="cell-sub">
                        {d.file.kind.toUpperCase()}・{d.pages.length} 頁・{Math.ceil(d.file.size / 1024)} KB・
                        {DOC_STATUS[d.status]}
                        {d.roleCandidates[0] && !d.roleManual && `・判斷依據：${d.roleCandidates[0].reason}`}
                        {d.roleManual && '・人工指定'}
                      </div>
                      {d.warnings.map((w, i) => (
                        <div key={i} className="cell-sub" style={{ color: 'var(--amber)' }}>
                          ! {w}
                        </div>
                      ))}
                    </div>
                    <label className="field">
                      <span className="sr-only">{d.file.name} 的文件角色</span>
                      <select className="input" value={d.role} onChange={(e) => setRole(d, e.target.value as DocRole)} disabled={!!progress}>
                        {[...def.roles, 'unknown' as DocRole].map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </li>
                ))}
              </ul>
              {session.skipped.length > 0 && (
                <>
                  <h3 style={{ fontSize: 14, margin: '12px 0 4px' }}>略過的項目</h3>
                  <ul className="file-tree">
                    {session.skipped.map((s, i) => (
                      <li key={i}>
                        <span className="path">{s.path}</span>
                        <span className="cell-sub">{s.reason}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              </>}
            </div>
          )}
        </section>
      )}

      {session?.result && (
        <div ref={resultsRegion} tabIndex={-1} className="check-results" role="region" aria-label="核對結果與報告">
          <Results session={session} onChange={(s) => setSession(flow, s)} onRerun={(s) => setSession(flow, rerun(s))} />
        </div>
      )}
      {confirmNode}
    </>
  );
}
