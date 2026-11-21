import { useEffect, useId, useRef, useState } from 'react';
import { useApp, type CheckSession } from '../../state/store';
import { Icon, StatusBadge, UnitBadge, useMedia } from '../../ui/components';
import { canShareFiles, download, shareFile, stamp } from '../../ui/util';
import { buildCsvReport, buildHtmlReport, maskText } from '../../report/report';
import { caseKey, findCaseNumbers } from '../../core/court';
import { maskId } from '../../core/idno';
import {
  provLabel,
  REVIEW_LABEL,
  SEVERITY_LABEL,
  unitStatus,
  type CheckItem,
  type CheckUnit,
  type Evidence,
  type ReviewState,
  type UnitStatus,
} from '../../core/types';
import { SERVICE_METHOD_LABEL, type ServiceMethod } from '../../core/service';
import type { FlowCExtra } from '../../flows/flowC';
import { DocViewer } from './DocViewer';

type Filter = 'all' | UnitStatus;

function unitDone(u: CheckUnit): boolean {
  return u.items.every((i) => i.status === 'match' || i.status === 'not-applicable' || i.review.state !== 'pending');
}

export function Results({ session, onChange, onRerun }: { session: CheckSession; onChange: (s: CheckSession) => void; onRerun: (s: CheckSession) => void }) {
  const { settings, toast } = useApp();
  const res = session.result!;
  const wide = useMedia('(min-width: 1024px)');
  const [filter, setFilter] = useState<Filter>('all');
  const [sel, setSel] = useState<string | null>(null);
  const [mask, setMask] = useState(settings.maskByDefault);
  const [reviewer, setReviewer] = useState('');
  const detailRef = useRef<HTMLDivElement>(null);

  const items = res.units.flatMap((u) => u.items);
  const pendingItems = items.filter((i) => i.status !== 'match' && i.status !== 'not-applicable' && i.review.state === 'pending').length;
  const consistent = items.filter((i) => i.status === 'match').length;
  const inconsistent = items.filter((i) => i.status === 'mismatch').length;
  const missing = items.filter((i) => i.status === 'missing').length;
  const unreadable = items.filter((i) => i.status === 'unreadable').length;
  const done = res.units.filter(unitDone).length;
  const list = res.units.filter((u) => filter === 'all' || unitStatus(u) === filter);
  // 只有一個核對單位時（例如快速文字校對），手機也直接顯示詳情
  const single = res.units.length === 1;
  const unit = res.units.find((u) => u.id === sel) ?? (wide || single ? list[0] : undefined);

  useEffect(() => {
    if (!wide && sel) detailRef.current?.scrollIntoView({ block: 'start' });
  }, [sel, wide]);

  const updateItem = (u: CheckUnit, item: CheckItem, patch: Partial<CheckItem['review']>) => {
    const units = res.units.map((x) =>
      x.id !== u.id ? x : { ...x, items: x.items.map((i) => (i.id !== item.id ? i : { ...i, review: { ...i.review, ...patch, at: new Date().toLocaleString('zh-TW', { hour12: false }) } })) },
    );
    onChange({ ...session, result: { ...res, units } });
  };

  const reportName = `法眼_${res.flow}_核對報告_${stamp()}`;
  const html = () => buildHtmlReport(res, session.docs, { mask, batchName: session.batchName, reviewer });
  const csv = () => buildCsvReport(res, { mask, batchName: session.batchName });

  return (
    <>
      <section className="panel" aria-labelledby="h-sum">
        <div className="panel-head">
          <h2 id="h-sum">核對結果</h2>
          <span className="hint">規則版本 {res.ruleVersion}</span>
        </div>
        <div className="stats" style={{ margin: 0, border: 0, borderRadius: 0 }}>
          <div className="stat"><div className="k">一致項目</div><div className="v">{consistent}</div></div>
          <div className="stat"><div className="k">不一致項目</div><div className={`v ${inconsistent ? 'alert' : ''}`}>{inconsistent}</div></div>
          <div className="stat"><div className="k">缺資料項目</div><div className="v">{missing}</div></div>
          <div className="stat"><div className="k">無法辨識項目</div><div className="v">{unreadable}</div></div>
          <div className="stat"><div className="k">待人工確認項目</div><div className="v">{pendingItems}</div></div>
          <div className="stat"><div className="k">完成覆核的單位</div><div className="v">{done}/{res.units.length}</div></div>
        </div>
        {(res.batchIssues.length > 0 || res.notDone.length > 0) && (
          <div className="panel-body">
            {res.batchIssues.map((i) => (
              <div key={i.id} className={`note ${i.level === 'error' ? 'bad' : i.level === 'warning' ? 'warn' : ''}`}>
                <b>{i.level === 'error' ? '✕ 待處理' : i.level === 'warning' ? '! 注意' : 'ⓘ 資訊'}</b>　{i.message}
              </div>
            ))}
            {res.notDone.map((x, i) => (
              <div key={i} className="note warn">! 未完成：{x}</div>
            ))}
          </div>
        )}
        {res.units.length > 0 && res.units.every((unit) => unitStatus(unit) === 'consistent') && !res.batchIssues.some((issue) => issue.level !== 'info') && !res.notDone.length && (
          <div className="panel-body"><div className="note">未發現符合目前規則的疑點。這不代表文件完全正確，仍請依報告逐項確認。</div></div>
        )}
      </section>

      {res.flow === 'B' && <ServiceForm session={session} onRerun={onRerun} />}

      <div className="result-layout">
        {(wide || !unit) && !(single && !wide) && (
          <section className="panel unit-pane" aria-labelledby="h-units">
            <div className="panel-head">
              <h2 id="h-units">{res.flow === 'C' || res.flow === 'A' ? '債務人' : '核對單位'}（{res.units.length}）</h2>
                <select className="input" style={{ width: 'auto' }} value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="篩選狀態">
                <option value="all">全部</option>
                <option value="inconsistent">發現不一致</option>
                <option value="pending">待確認</option>
                <option value="missing">缺資料</option>
                <option value="consistent">已核對一致</option>
              </select>
            </div>
            <ul className="unit-list">
              {list.map((u) => {
                const st = unitStatus(u);
                const bad = u.items.filter((i) => i.status === 'mismatch').length;
                const rev = u.items.filter((i) => ['needs-review', 'partial', 'unreadable'].includes(i.status)).length;
                const ok = u.items.filter((i) => i.status === 'match').length;
                return (
                  <li key={u.id}>
                    <button aria-current={unit?.id === u.id} onClick={() => setSel(u.id)}>
                      <span className="u-name">{u.label}</span>
                      {u.subLabel && <span className="u-sub">{u.subLabel}</span>}
                      <span className="u-counts">
                        <UnitBadge status={st} />
                        <span className="badge ok">✓ {ok}</span>
                        {bad > 0 && <span className="badge bad">✕ {bad}</span>}
                        {rev > 0 && <span className="badge warn">! {rev}</span>}
                        {unitDone(u) && <span className="badge info">覆核完成</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
              {!list.length && <li className="empty">沒有符合篩選的項目</li>}
            </ul>
          </section>
        )}

        {unit && (
          <section className="panel" aria-labelledby="h-detail" ref={detailRef}>
            {!wide && !single && (
              <div className="panel-body" style={{ paddingBottom: 0 }}>
                <button className="btn mobile-back" onClick={() => setSel(null)}>
                  <Icon name="back" size={18} />
                  返回清單
                </button>
              </div>
            )}
            <UnitDetail key={unit.id} unit={unit} session={session} onReview={updateItem} onRerun={onRerun} />
          </section>
        )}
      </div>

      <section className="panel" aria-labelledby="h-report">
        <div className="panel-head">
          <h2 id="h-report">下載校對報告</h2>
          <span className="hint">報告含來源檔案、頁碼、雜湊、計算依據、人工覆核紀錄與免責說明</span>
        </div>
        <div className="panel-body">
          <div className="form-grid">
            <label className="field">
              <span>覆核人員（選填，會寫入報告）</span>
              <input className="input" value={reviewer} maxLength={40} onChange={(e) => setReviewer(e.target.value)} />
            </label>
            <label className="check">
              <input type="checkbox" checked={mask} onChange={(e) => setMask(e.target.checked)} />
              遮罩身分證字號、帳號、電話（建議保持開啟）
            </label>
          </div>
          <div className="toolbar" style={{ marginTop: 10 }}>
            <button className="btn primary" onClick={() => { download(reportName + '.html', html(), 'text/html;charset=utf-8'); toast('已下載 HTML 報告；以瀏覽器開啟後可列印存成 PDF'); }}>
              <Icon name="download" size={18} />
              下載 HTML 報告
            </button>
            <button className="btn" onClick={() => download(reportName + '.csv', csv(), 'text/csv;charset=utf-8')}>下載 CSV</button>
            <button
              className="btn"
              onClick={() => {
                const url = URL.createObjectURL(new Blob([html()], { type: 'text/html' }));
                const w = window.open(url, '_blank');
                if (w) w.opener = null;
                else toast('瀏覽器封鎖了新視窗，請改用「下載 HTML 報告」', 'error');
                setTimeout(() => URL.revokeObjectURL(url), 60000);
              }}
            >
              開啟報告（可列印為 PDF）
            </button>
            {canShareFiles() && (
              <button className="btn" onClick={async () => { if (!(await shareFile(reportName + '.html', html(), 'text/html'))) toast('此瀏覽器無法分享檔案，請改用下載', 'error'); }}>
                <Icon name="share" size={18} />
                分享／儲存到…
              </button>
            )}
          </div>
          <p className="cell-sub">
            手機與平板：iPhone／iPad Safari 下載的檔案會放在「檔案」App 的「下載項目」；Android Chrome 會放在「下載」資料夾。分享功能由使用者自行選擇目的地，系統不會自動傳送。
          </p>
        </div>
      </section>
    </>
  );
}

function UnitDetail({
  unit,
  session,
  onReview,
  onRerun,
}: {
  unit: CheckUnit;
  session: CheckSession;
  onReview: (u: CheckUnit, i: CheckItem, patch: Partial<CheckItem['review']>) => void;
  onRerun: (s: CheckSession) => void;
}) {
  const firstIssue = unit.items.find((i) => i.status !== 'match' && i.status !== 'not-applicable');
  const [open, setOpen] = useState<string | null>(firstIssue?.id ?? null);
  const st = unitStatus(unit);
  const extra = (session.result as unknown as { extra?: FlowCExtra }).extra;
  const petitionId = unit.docs.find((d) => d.role === 'payment-order-petition')?.fileId;

  return (
    <>
      <div className="panel-head">
        <div>
          <h2 id="h-detail">{unit.label}</h2>
          {unit.subLabel && <div className="cell-sub">{unit.subLabel}</div>}
        </div>
        <UnitBadge status={st} />
      </div>
      {unit.match && (
        <div className="panel-body" style={{ borderBottom: '1px solid var(--line)' }}>
          <div className="cell-sub">
            配對依據：{unit.match.evidence.join('；')}
            {unit.match.needsManual && <b style={{ color: 'var(--amber)' }}>（需人工確認配對）</b>}
          </div>
          {session.flow === 'C' && extra && petitionId && (
            <div className="form-grid" style={{ marginTop: 8 }}>
              <label className="field">
                <span>人工配對：戶籍資料</span>
                <select
                  className="input"
                  value={session.manualPairs[petitionId]?.person ?? ''}
                  onChange={(e) => onRerun({ ...session, manualPairs: { ...session.manualPairs, [petitionId]: { ...session.manualPairs[petitionId], person: e.target.value || undefined } } })}
                >
                  <option value="">（自動配對）</option>
                  {extra.persons.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name || '（姓名未辨識）'} {p.id ? maskId(p.id) : ''}・{p.doc.file.name} 第 {p.page} 頁
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>人工配對：帳務資料</span>
                <select
                  className="input"
                  value={session.manualPairs[petitionId]?.statement ?? ''}
                  onChange={(e) => onRerun({ ...session, manualPairs: { ...session.manualPairs, [petitionId]: { ...session.manualPairs[petitionId], statement: e.target.value || undefined } } })}
                >
                  <option value="">（自動配對）</option>
                  {extra.statements.map((s) => (
                    <option key={s.doc.file.id} value={s.doc.file.id}>
                      {s.doc.file.path}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>
      )}
      <ul className="item-list">
        {unit.items.map((i) => {
          const isOpen = open === i.id;
          return (
            <li key={i.id}>
              <button className="item-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : i.id)}>
                <span className="f">{i.field}</span>
                <span><StatusBadge status={i.status} /></span>
                <span className="r">{i.reason}</span>
                <span className="cell-sub" style={{ textAlign: 'right' }}>
                  {i.review.state !== 'pending' ? `✔ ${REVIEW_LABEL[i.review.state]}` : `優先 ${SEVERITY_LABEL[i.severity]}`}
                </span>
              </button>
              {isOpen && <ItemEvidence item={i} session={session} onReview={(p) => onReview(unit, i, p)} />}
            </li>
          );
        })}
        {!unit.items.length && <li className="empty">沒有檢查項目</li>}
      </ul>
    </>
  );
}

function ItemEvidence({ item, session, onReview }: { item: CheckItem; session: CheckSession; onReview: (p: Partial<CheckItem['review']>) => void }) {
  const { settings } = useApp();
  const twoCol = useMedia('(min-width: 1200px), (min-width: 1024px) and (orientation: landscape)');
  const [tab, setTab] = useState<'a' | 'b'>(item.a ? 'a' : 'b');
  const [note, setNote] = useState(item.review.note);
  const sides = (['a', 'b'] as const).filter((s) => item[s]);
  const show = twoCol ? sides : sides.filter((s) => s === tab);
  const mask = (value: string) => settings.maskByDefault ? maskText(value) : value;
  return (
    <div className="evidence">
      {sides.length === 2 && !twoCol && (
        <div className="seg" role="tablist" aria-label="切換來源" style={{ margin: '8px 0' }}>
          {sides.map((s) => (
            <button key={s} role="tab" aria-pressed={tab === s} aria-selected={tab === s} onClick={() => setTab(s)}>
              {s === 'a' ? `來源 A：${item.a!.label}` : `書狀 B：${item.b!.label}`}
            </button>
          ))}
        </div>
      )}
      {/* 窄螢幕切換時，仍保留雙方數值摘要 */}
      {sides.length === 2 && !twoCol && (
        <div className="cell-sub" style={{ marginBottom: 6 }}>
          A：{mask(item.a!.normalized)}　｜　B：{mask(item.b!.normalized)}
        </div>
      )}
      <div className={`ev-cols ${show.length === 2 ? 'two' : ''}`} style={{ marginTop: 8 }}>
        {show.map((s) => (
          <EvCard key={s} ev={item[s]!} title={s === 'a' ? '來源 A' : '待核書狀 B'} session={session} compact={!twoCol} />
        ))}
        {!sides.length && <div className="cell-sub">此項目沒有可顯示的原文證據（例如缺件或來源未提供）。</div>}
      </div>
      {item.calc && <pre className="calc">{item.calc}</pre>}
      {item.basis && (
        <ul className="cell-sub" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {item.basis.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}
      <div className="review">
        <div className="seg" role="group" aria-label="人工覆核結果">
          {(['pending', 'fix', 'false-positive', 'done'] as ReviewState[]).map((s) => (
            <button key={s} aria-pressed={item.review.state === s} onClick={() => onReview({ state: s })}>
              {REVIEW_LABEL[s]}
            </button>
          ))}
        </div>
        <label className="field">
          <span>覆核備註</span>
          <textarea className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== item.review.note && onReview({ note })} />
        </label>
        <div className="toolbar" style={{ marginTop: 6 }}>
          <button className="btn small" onClick={() => onReview({ note })} disabled={note === item.review.note}>
            儲存備註
          </button>
          {item.review.at && <span className="cell-sub">最後更新 {item.review.at}</span>}
        </div>
      </div>
    </div>
  );
}

function EvCard({ ev, title, session, compact }: { ev: Evidence; title: string; session: CheckSession; compact: boolean }) {
  const { settings } = useApp();
  const tabId = useId();
  const [view, setView] = useState(false);
  // 畫面上的原文與前後文依設定遮罩身分證、帳號、電話；「查看原頁」才顯示原件
  const m = (s: string) => (settings.maskByDefault ? maskText(s) : s);
  const doc = ev.prov ? session.docs.find((d) => d.file.id === ev.prov!.fileId) : undefined;
  const tabbed = compact && !!doc;
  const tabLabels = ['核對摘要', '查看原頁'];
  return (
    <div className="ev-card">
      <h4>
        {title}：{ev.label}
      </h4>
      {tabbed && <div className="tabs evidence-tabs" role="tablist" aria-label="核對摘要與原文" onKeyDown={(e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const original = e.key === 'End' || (e.key !== 'Home' && !view);
        setView(original);
        e.currentTarget.querySelectorAll<HTMLButtonElement>('button')[Number(original)]?.focus();
      }}>
        {tabLabels.map((label, index) => (
          <button key={label} id={`${tabId}-${index}`} type="button" role="tab" aria-controls={`${tabId}-panel`} aria-selected={view === Boolean(index)} tabIndex={view === Boolean(index) ? 0 : -1} onClick={() => setView(Boolean(index))}>{label}</button>
        ))}
      </div>}
      <div role={tabbed ? 'tabpanel' : undefined} id={tabbed ? `${tabId}-panel` : undefined} aria-labelledby={tabbed ? `${tabId}-${Number(view)}` : undefined}>
        {(!tabbed || !view) && <>
          <div className="val">{m(ev.normalized) || '—'}</div>
          <div className="raw">原文：{m(ev.raw) || '—'}</div>
          {ev.prov && <div className="loc">來源：{provLabel(ev.prov)}</div>}
          {ev.prov?.raw && ev.prov.raw !== ev.raw && <div className="raw">前後文：{m(ev.prov.raw)}</div>}
        </>}
        {!tabbed && doc && <button className="btn small" style={{ marginTop: 6 }} aria-expanded={view} onClick={() => setView(!view)}>{view ? '收合原文' : '查看原頁'}</button>}
        {view && doc && ev.prov && <DocViewer doc={doc} prov={ev.prov} />}
      </div>
    </div>
  );
}

function ServiceForm({ session, onRerun }: { session: CheckSession; onRerun: (s: CheckSession) => void }) {
  const units = session.result!.units.filter((u) => u.items.some((i) => i.field === '利息起算日'));
  const [draft, setDraft] = useState(session.service);
  if (!units.length) return null;
  return (
    <section className="panel" aria-labelledby="h-svc">
      <div className="panel-head">
        <h2 id="h-svc">送達資料（利息起算日）</h2>
        <span className="hint">自動辨識不完整時請人工補充；確定證明書日期不是送達日</span>
      </div>
      <div className="panel-body">
        {units.map((u) => {
          const c = findCaseNumbers(u.subLabel ?? '')[0];
          if (!c) return null;
          const key = caseKey(c);
          const v = draft[key] ?? {};
          const set = (patch: object) => setDraft({ ...draft, [key]: { ...v, ...patch } });
          return (
            <div key={u.id} style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                {u.label}・{u.subLabel}
              </div>
              <div className="form-grid cols-3">
                <label className="field">
                  <span>送達方式</span>
                  <select className="input" value={v.method ?? ''} onChange={(e) => set({ method: (e.target.value || undefined) as ServiceMethod | undefined })}>
                    <option value="">（依送達證書自動辨識）</option>
                    {(Object.keys(SERVICE_METHOD_LABEL) as ServiceMethod[]).map((m) => (
                      <option key={m} value={m}>
                        {SERVICE_METHOD_LABEL[m]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>送達日／寄存日</span>
                  <input className="input" type="date" value={v.serviceDate ?? ''} onChange={(e) => set({ serviceDate: e.target.value || undefined })} />
                </label>
                <label className="field">
                  <span>實際領取日（寄存後，如有）</span>
                  <input className="input" type="date" value={v.pickupDate ?? ''} onChange={(e) => set({ pickupDate: e.target.value || undefined })} />
                </label>
                <label className="field">
                  <span>法院確認之送達生效日（如有）</span>
                  <input className="input" type="date" value={v.courtConfirmedEffective ?? ''} onChange={(e) => set({ courtConfirmedEffective: e.target.value || undefined })} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={!!v.multipleDebtorsDiffer} onChange={(e) => set({ multipleDebtorsDiffer: e.target.checked })} />
                  多名債務人且送達日不同
                </label>
              </div>
            </div>
          );
        })}
        <button className="btn primary" onClick={() => onRerun({ ...session, service: draft })}>
          套用並重新計算
        </button>
      </div>
    </section>
  );
}
