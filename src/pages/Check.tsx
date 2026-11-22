import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, type CheckSession } from '../state/store';
import { Icon, PageHead, useConfirm } from '../ui/components';
import { isLowMemoryDevice, readFileBytes } from '../ui/util';
import { FLOWS, runFlow } from '../flows';
import { ingest, type IngestProgress, type InputFile } from '../core/ingest';
import { ROLE_LABEL, type CheckUnit, type DocRole, type ExtractedDoc, type FlowId, type FlowResult } from '../core/types';
import { pageRole } from '../core/classify';
import { FlowCards } from '../ui/FlowCards';
import { Results } from './check/Results';
import { DocViewer } from './check/DocViewer';
import { ChromeTextForm } from './check/ChromeText';
import { saveChromePage } from '../flows/chromeText';
import { provAt } from '../flows/common';

type UploadProgress = Omit<IngestProgress, 'phase'> & { phase: IngestProgress['phase'] | 'read' };
const PHASE: Record<UploadProgress['phase'], string> = { read: '讀取檔案', unzip: '解壓縮', parse: '讀取文件', ocr: '正在讀取掃描文字', classify: '分類', done: '完成' };
const ROLES: Record<FlowId, DocRole[]> = {
  A: ['court-notice', 'notice-letter'],
  B: ['enforcement-petition', 'payment-order', 'finality-cert', 'service-proof'],
  C: ['payment-order-petition', 'debt-statement', 'household-register'],
  D: ['court-letter', 'civil-report', 'debt-table', 'attachment'],
};
const STEPS = ['上傳文件', '檔案辨識與確認', '開始核對與查看結果'];
const ENFORCEMENT_STEPS = [
  { label: '上傳文件', target: 'h-upload' },
  { label: '確認案件配對', target: 'h-files' },
  { label: '當事人與金額', target: 'case-review' },
  { label: '利息起算日', target: 'interest-review' },
  { label: '檢視與下載報告', target: 'h-report' },
];
const DOC_STATUS: Record<ExtractedDoc['status'], string> = {
  ok: '已讀取', partial: '部分文字待確認', 'needs-ocr': '掃描文字尚未辨識', error: '讀取失敗', unsupported: '不支援',
};

/** 重新執行時保留人工覆核紀錄（依檔案＋單位＋欄位＋序號對應） */
function mergeReviews(prev: FlowResult | undefined, next: FlowResult): FlowResult {
  if (!prev) return next;
  const key = (u: FlowResult['units'][number], field: string, n: number) => `${u.id}|${field}|${n}`;
  const map = new Map<string, FlowResult['units'][number]['items'][number]>();
  for (const u of prev.units) {
    const cnt = new Map<string, number>();
    for (const i of u.items) {
      const n = cnt.get(i.field) ?? 0;
      cnt.set(i.field, n + 1);
      map.set(key(u, i.field, n), i);
    }
  }
  for (const u of next.units) {
    const cnt = new Map<string, number>();
    for (const i of u.items) {
      const n = cnt.get(i.field) ?? 0;
      cnt.set(i.field, n + 1);
      const previous = map.get(key(u, i.field, n));
      if (!previous) continue;
      i.id = previous.id;
      const source = (ev: typeof i.a) => JSON.stringify([ev?.prov?.fileId, ev?.prov?.page, ev?.normalized, ev?.correction?.applied?.at,
        ev?.candidates?.map((candidate) => [candidate.prov.fileId, candidate.prov.page, candidate.value])]);
      if (previous.status === i.status && source(previous.a) === source(i.a) && source(previous.b) === source(i.b)) i.review = { ...previous.review };
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
  const [scanPreview, setScanPreview] = useState<string>();
  const [chromeOpen, setChromeOpen] = useState(false);
  const [chromeTarget, setChromeTarget] = useState<CheckUnit>();
  const chromeHeading = useRef<HTMLHeadingElement>(null);
  const [enforcementStep, setEnforcementStep] = useState(3);
  const abort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const filesHeading = useRef<HTMLHeadingElement>(null);
  const resultsRegion = useRef<HTMLDivElement>(null);
  const focusStep = useRef<2 | 3 | null>(null);
  const lowMem = isLowMemoryDevice();
  const assistanceUnits = useMemo(() => chromeOpen && session && !session.result ? runFlow(flow, session.docs, { settings }).units : session?.result?.units ?? [],
    [chromeOpen, flow, session, settings]);

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
    const result = mergeReviews(s.result, runFlow(flow, s.docs, { settings, service: s.service, manualPairs: s.manualPairs, corrections: s.corrections, chromePages: s.chromePages }));
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
      setChromeTarget(undefined);
      setChromeOpen(false);
      setScanPreview(undefined);
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
    if (!session || !session.docs.some((d) => d.fullText.trim() || (d.file.kind === 'pdf' && d.role !== 'unknown' && d.pages.length))) return;
    focusStep.current = 3;
    setShowFiles(false);
    setSession(flow, rerun(session));
  };

  const clear = async () => {
    const message = session?.result ? '清除本次文件、核對結果與人工覆核紀錄？請先下載需要留存的報告。' : '清除本次匯入的所有文件？';
    if (!(await confirm(message, { danger: true, okText: '清除' }))) return;
    setChromeOpen(false);
    setChromeTarget(undefined);
    setScanPreview(undefined);
    setSession(flow, undefined);
    toast('已清除本次資料');
  };

  const pct = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;
  const step = progress ? 1 : session?.result ? 3 : session ? 2 : 1;
  const docs = session?.docs ?? [];
  const readable = docs.some((d) => d.fullText.trim());
  const canCheck = readable || docs.some((d) => d.file.kind === 'pdf' && d.role !== 'unknown' && d.pages.length);
  const openChrome = (unit?: CheckUnit) => {
    setChromeTarget(unit);
    setChromeOpen(true);
    chromeHeading.current?.focus({ preventScroll: true });
    chromeHeading.current?.scrollIntoView({ block: 'start' });
  };
  const mergedRoles = docs.filter((d) => d.role === 'merged-source').flatMap((d) => d.pages.map((p) => pageRole(p.text)));
  const roleStates = ROLES[flow].map((role) => {
    const found = docs.filter((d) => d.role === role);
    const identified = found.some((d) => role === 'attachment' ? d.status !== 'error' : !!d.fullText.trim()) || mergedRoles.includes(role);
    return { role, identified, status: identified ? '已辨識' : found.length ? '無法讀取' : '未辨識' };
  });
  const displayedStep = flow === 'B' && step === 3 ? enforcementStep : step;
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
        {(flow === 'B' ? ENFORCEMENT_STEPS : STEPS.map((label) => ({ label, target: '' }))).map(({ label, target }, i) => (
          <li key={label} aria-current={displayedStep === i + 1 ? 'step' : undefined}>
            <span className="step-number" aria-hidden="true">{i + 1}</span>
            {target ? <button type="button" disabled={i > 0 && !session || i > 1 && !session?.result} onClick={() => {
              setEnforcementStep(i + 1);
              if (i === 1) setShowFiles(true);
              const section = i === 1 && session?.result ? 'case-review' : target;
              (document.getElementById(section) ?? document.getElementById('case-review'))?.scrollIntoView({ block: 'start' });
            }}>{label}</button> : label}
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
            <div className="upload-options" aria-labelledby="scan-method-heading">
              <h3 id="scan-method-heading" ref={chromeHeading} tabIndex={-1}>讀取掃描文件文字</h3>
              <label className="check">
                <input type="checkbox" checked={ocr} disabled={!!progress} onChange={(e) => setOcr(e.target.checked)} />
                自動辨識掃描文件中的文字
              </label>
              <span className="cell-sub">
                如果 PDF 是掃描圖片，系統會嘗試讀取姓名、身分證字號與地址。可能多花一些時間，資料只在這台裝置處理。已有文字的頁面會直接讀取。
              </span>
              <span className="cell-sub">{ocrReady === null ? '正在準備掃描文字辨識…' : ocrReady ? '掃描文字辨識已準備好，可在本機處理檔案。' : '掃描辨識工具目前無法使用，可用 Chrome 協助讀取或手動更正。'}</span>
              <div className="toolbar">
                <button className="btn small" type="button" disabled={!!progress} aria-expanded={chromeOpen} aria-controls="chrome-text-form" onClick={() => {
                  if (chromeOpen) setChromeOpen(false);
                  else openChrome();
                }}>使用 Chrome 協助讀取掃描文件</button>
                {canCheck && <button className="btn small" type="button" disabled={!!progress} onClick={() => {
                  if (!session?.result) beginCheck();
                  else { resultsRegion.current?.scrollIntoView({ block: 'start' }); resultsRegion.current?.focus({ preventScroll: true }); }
                }}>我直接更正文字</button>}
              </div>
            </div>
            {lowMem && ocr && <p className="cell-sub">行動裝置會逐頁辨識。大量掃描檔建議使用桌機。</p>}
            {progress && (
              <div style={{ marginTop: 10 }} role="status" aria-live="polite">
                <div className="toolbar" style={{ justifyContent: 'space-between' }}>
                  <span>{PHASE[progress.phase]}：{progress.label}（{progress.phase === 'ocr' ? `第 ${progress.done}／${progress.total} 掃描頁` : `${progress.done}/${progress.total}`}）</span>
                  <button className="btn small danger" onClick={() => abort.current?.abort()}>取消</button>
                </div>
                <div className="progress" aria-hidden="true"><div style={{ width: `${pct}%` }} /></div>
              </div>
            )}
          </div>
        </div>
        {chromeOpen && !progress && <div className="panel-body" id="chrome-text-form">
          <ChromeTextForm key={chromeTarget?.id ?? 'all'} docs={docs} units={assistanceUnits} roles={def.roles} initial={chromeTarget} onSave={(entry) => {
            if (!session) return;
            const updated = rerun({ ...session, chromePages: saveChromePage(session.chromePages ?? [], entry) });
            focusStep.current = 3;
            if (!session.result) setShowFiles(false);
            setSession(flow, updated);
            const used = updated.result?.units.find((u) => u.id === entry.unitId)?.chromeSources?.find((s) => s.fileId === entry.fileId && s.page === entry.page)?.used;
            toast(used ? `已使用第 ${entry.page} 頁文字重新核對，請對照原件` : `已保留第 ${entry.page} 頁文字，請確認案件配對或補入完整欄位`);
          }} />
        </div>}
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
                  <p>{!readable ? '目前沒有可核對的文字。可指定文件類型後，用 Chrome 協助讀取或查看原件。'
                    : roleStates.some(({ identified }) => !identified) ? '仍有文件未辨識或無法讀取。可先核對已讀取的文件，結果會列出缺漏。'
                    : '確認分類後，可查看核對結果、來源與校對報告。'}</p>
                  <button className="btn primary" onClick={beginCheck} disabled={!canCheck || !!progress}>開始核對</button>
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
                      {d.file.kind === 'pdf' && d.pages.some((p) => p.method === 'ocr' || p.needsOcr) && (
                        <><button className="btn small" onClick={() => setScanPreview(scanPreview === d.file.id ? undefined : d.file.id)} aria-expanded={scanPreview === d.file.id}>查看掃描原頁</button>
                          {scanPreview === d.file.id && <DocViewer doc={d} prov={provAt(d, (d.pages.find((p) => p.ocrFailed || p.needsOcr) ?? d.pages.find((p) => p.method === 'ocr')!).page, 0, '')} />}
                        </>
                      )}
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
          <Results session={session} onChange={(s) => setSession(flow, s)} onRerun={(s) => setSession(flow, rerun(s))} onChrome={openChrome} />
        </div>
      )}
      {confirmNode}
    </>
  );
}
