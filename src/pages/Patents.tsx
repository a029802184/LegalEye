import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { Icon, Modal, PageHead, useConfirm } from '../ui/components';
import { download, stamp, XLSX_MIME } from '../ui/util';
import { demoPatents, exportPatentCsv, exportPatentXlsx } from '../patent/io';
import { PatentImport } from '../patent/PatentImport';
import {
  checkIntegrity,
  DEADLINE_TYPES,
  dueBucket,
  DUE_LABEL,
  emptyPatent,
  FIELDS,
  groupOf,
  PATENT_TYPES,
  STATUS_GROUP_LABEL,
  type DueBucket,
  type Patent,
  type PatentKey,
  type StatusGroup,
} from '../patent/model';

type SortKey = 'id' | 'name' | 'status' | 'owner' | 'nextCheck' | 'deadline' | 'appDate' | 'updatedAt';
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'nextCheck', label: '下次確認日' },
  { key: 'deadline', label: '重要期限' },
  { key: 'id', label: '內部案件編號' },
  { key: 'name', label: '專利名稱' },
  { key: 'status', label: '狀態' },
  { key: 'owner', label: '承辦人' },
  { key: 'appDate', label: '申請日' },
  { key: 'updatedAt', label: '最後更新' },
];

function DueText({ date }: { date: string }) {
  if (!date) return <span className="cell-sub">未設定</span>;
  const { bucket, days } = dueBucket(date);
  const cls = bucket === 'overdue' ? 'due-overdue' : bucket === 'd7' || bucket === 'd30' ? 'due-soon' : '';
  return (
    <span className={`num ${cls}`}>
      {date}
      {bucket !== 'later' && bucket !== 'none' && (
        <span className="cell-sub">
          {bucket === 'overdue' ? '⚠ ' : ''}
          {DUE_LABEL[bucket]}
          {days !== null && (days < 0 ? `（${-days} 天）` : `（剩 ${days} 天）`)}
        </span>
      )}
    </span>
  );
}

export function PatentsPage({ query }: { query: string }) {
  const { patents, setPatents, statuses, setStatuses, patentDirty, markExported, persistPatents, setPersistPatents, toast } = useApp();
  const [confirm, confirmNode] = useConfirm();
  const params = new URLSearchParams(query);
  const view = params.get('view');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [fStatus, setFStatus] = useState('');
  const [fOwner, setFOwner] = useState('');
  const [fDue, setFDue] = useState<'' | DueBucket | 'recent'>(view === 'due' ? 'recent' : '');
  const [sort1, setSort1] = useState<SortKey>('nextCheck');
  const [sort2, setSort2] = useState<SortKey>('id');
  const [asc, setAsc] = useState(true);
  const [editing, setEditing] = useState<{ p: Patent; isNew: boolean } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showIntegrity, setShowIntegrity] = useState(false);
  const listHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (view !== 'list' && view !== 'due') return;
    const frame = requestAnimationFrame(() => listHeading.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [view]);

  const owners = useMemo(() => [...new Set(patents.map((p) => p.owner).filter(Boolean))].sort(), [patents]);
  const statusNames = useMemo(() => [...new Set([...statuses.map((s) => s.name), ...patents.map((p) => p.status).filter(Boolean)])], [statuses, patents]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = patents.filter((p) => {
      if (fStatus && p.status !== fStatus) return false;
      if (fOwner && p.owner !== fOwner) return false;
      if (fDue) {
        const a = dueBucket(p.deadline).bucket;
        const b = dueBucket(p.nextCheck).bucket;
        if (fDue === 'recent') {
          if (groupOf(p.status, statuses) === 'closed' || ![a, b].some((bucket) => ['overdue', 'd7', 'd30'].includes(bucket))) return false;
        } else if (a !== fDue && b !== fDue) return false;
      }
      if (!needle) return true;
      return [p.id, p.name, p.appNo, p.certNo, p.owner, p.firm, p.applicant, p.inventors, p.note].join(' ').toLowerCase().includes(needle);
    });
    const cmp = (a: Patent, b: Patent, k: SortKey) => {
      const x = a[k] || '￿';
      const y = b[k] || '￿';
      return x.localeCompare(y, 'zh-Hant');
    };
    return [...list].sort((a, b) => (asc ? 1 : -1) * (cmp(a, b, sort1) || cmp(a, b, sort2)));
  }, [patents, statuses, q, fStatus, fOwner, fDue, sort1, sort2, asc]);

  const stats = useMemo(() => {
    const g = (p: Patent) => groupOf(p.status, statuses);
    const live = patents.filter((p) => g(p) !== 'closed');
    const soon = live.filter((p) => ['d7', 'd30', 'overdue'].includes(dueBucket(p.deadline).bucket) && dueBucket(p.deadline).bucket !== 'overdue').length;
    const overdue = live.filter((p) => dueBucket(p.nextCheck).bucket === 'overdue' || dueBucket(p.deadline).bucket === 'overdue').length;
    const byGroup = Object.keys(STATUS_GROUP_LABEL).map((k) => ({ k: k as StatusGroup, n: patents.filter((p) => g(p) === k).length }));
    return {
      total: patents.length,
      filed: patents.filter((p) => g(p) === 'filed').length,
      review: patents.filter((p) => g(p) === 'review').length,
      granted: patents.filter((p) => g(p) === 'granted').length,
      soon,
      overdue,
      byGroup,
      recent: [...patents].filter((p) => p.updatedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5),
    };
  }, [patents, statuses]);

  const integrity = useMemo(() => checkIntegrity(patents, statuses), [patents, statuses]);

  const save = (p: Patent, isNew: boolean, originalId: string) => {
    if (!p.id.trim() || !p.name.trim()) return toast('請填寫內部案件編號與專利名稱', 'error');
    if (patents.some((x) => x.id === p.id && (isNew || x.id !== originalId))) return toast('內部案件編號已存在，請改用其他編號', 'error');
    const rec = { ...p, id: p.id.trim(), name: p.name.trim(), updatedAt: new Date().toISOString() };
    setPatents(isNew ? [...patents, rec] : patents.map((x) => (x.id === originalId ? rec : x)));
    setEditing(null);
    toast(isNew ? `已新增 ${rec.id}（尚未匯出）` : `已更新 ${rec.id}（尚未匯出）`);
  };

  const remove = async (ids: string[]) => {
    if (!(await confirm(`確定從清單移除 ${ids.length} 筆案件？\n${ids.slice(0, 5).join('、')}${ids.length > 5 ? '…' : ''}\n\n此操作不會修改原始 Excel；匯出前可重新匯入原檔還原。`, { okText: '移除', danger: true }))) return;
    setPatents(patents.filter((p) => !ids.includes(p.id)));
    setSelected(new Set());
    toast(`已移除 ${ids.length} 筆`);
  };

  const batchStatus = async (status: string) => {
    if (!status) return;
    const ids = [...selected];
    if (!(await confirm(`將 ${ids.length} 筆案件的狀態改為「${status}」？`))) return;
    const now = new Date().toISOString();
    setPatents(patents.map((p) => (selected.has(p.id) ? { ...p, status, updatedAt: now } : p)));
    toast(`已更新 ${ids.length} 筆狀態`);
  };

  const exportX = async () => {
    download(`法眼_專利主檔_${stamp()}.xlsx`, await exportPatentXlsx(patents, statuses), XLSX_MIME);
    markExported();
    toast('已下載 Excel。請存回公司核准的共用位置（網頁不會修改原始檔）');
  };
  const exportC = () => {
    download(`法眼_專利主檔_${stamp()}.csv`, exportPatentCsv(patents), 'text/csv;charset=utf-8');
    markExported();
  };

  const addStatus = (name: string) => {
    if (statuses.some((s) => s.name === name)) return;
    setStatuses([...statuses, { name, group: 'other', active: true }]);
    toast(`已將「${name}」加入狀態清單（分組可在規則與設定調整）`);
  };

  const toggleSel = (id: string) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSelected(s);
  };
  const headSort = (k: SortKey) => {
    if (sort1 === k) setAsc(!asc);
    else {
      setSort2(sort1);
      setSort1(k);
      setAsc(true);
    }
  };
  const Th = ({ k, children }: { k: SortKey; children: string }) => (
    <th aria-sort={sort1 === k ? (asc ? 'ascending' : 'descending') : undefined}>
      <button onClick={() => headSort(k)}>
        {children}
        {sort1 === k ? (asc ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  );
  const max = Math.max(1, ...stats.byGroup.map((x) => x.n));

  return (
    <>
      <PageHead
        title="專利案件管理"
        desc="Excel 是正式主檔：匯入 → 在此新增／修改 → 匯出新檔存回共用位置。網頁不會直接修改原始 Excel。"
        actions={
          <>
            <button className="btn primary" onClick={() => setEditing({ p: emptyPatent(), isNew: true })}>
              <Icon name="plus" size={18} />
              新增案件
            </button>
            <PatentImport />
            <button className="btn" onClick={exportX} disabled={!patents.length}>
              <Icon name="download" size={18} />
              匯出 Excel
            </button>
            <button className="btn" onClick={exportC} disabled={!patents.length}>
              匯出 CSV
            </button>
          </>
        }
      />

      {patentDirty && !persistPatents && (
        <div className="note warn" role="status">
          有尚未匯出的修改。資料只在目前瀏覽器分頁中，關閉或重新整理前請先「匯出 Excel」。
        </div>
      )}

      <div className="stats" aria-label="案件統計">
        <div className="stat"><div className="k">案件總數</div><div className="v">{stats.total}</div></div>
        <div className="stat"><div className="k">申請中</div><div className="v">{stats.filed}</div></div>
        <div className="stat"><div className="k">審查中</div><div className="v">{stats.review}</div></div>
        <div className="stat"><div className="k">已取得專利</div><div className="v">{stats.granted}</div></div>
        <div className="stat"><div className="k">30 天內重要期限</div><div className="v">{stats.soon}</div></div>
        <div className="stat"><div className="k">已逾追蹤日／期限</div><div className={`v ${stats.overdue ? 'alert' : ''}`}>{stats.overdue}</div></div>
      </div>

      {!!patents.length && (
        <div className="grid-2">
          <section className="panel">
            <div className="panel-head"><h2>案件進度分布</h2></div>
            <div className="panel-body bar-chart" role="list">
              {stats.byGroup.map((x) => (
                <div className="row" role="listitem" key={x.k}>
                  <span>{STATUS_GROUP_LABEL[x.k]}</span>
                  <div className="track" aria-hidden="true"><div className="fill" style={{ width: `${(x.n / max) * 100}%` }} /></div>
                  <span className="num">{x.n}</span>
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>最近更新</h2></div>
            <ul className="case-list">
              {stats.recent.map((p) => (
                <li key={p.id} style={{ padding: '8px 12px', fontSize: 14 }}>
                  <b>{p.id}</b> {p.name}
                  <span className="cell-sub">{p.status}・{new Date(p.updatedAt).toLocaleString('zh-TW', { hour12: false })}</span>
                </li>
              ))}
              {!stats.recent.length && <li className="empty">尚無更新紀錄</li>}
            </ul>
          </section>
        </div>
      )}

      <section className="panel" aria-labelledby="h-list">
        <div className="panel-head">
          <h2 id="h-list" ref={listHeading} tabIndex={-1}>案件清單</h2>
          <div className="toolbar">
            <button className="btn small" onClick={() => setShowIntegrity(true)} disabled={!patents.length}>
              完整性檢查{integrity.length ? `（${integrity.length}）` : ''}
            </button>
            <button
              className="btn small"
              onClick={async () => {
                if (patents.length && !(await confirm('載入虛構示範資料會取代目前清單，建議先匯出。確定？', { danger: true }))) return;
                setPatents(demoPatents(), { dirty: false });
                toast('已載入 4 筆虛構示範資料');
              }}
            >
              載入示範資料
            </button>
            <button className="btn small" onClick={async () => download(`法眼_專利主檔範本_${stamp()}.xlsx`, await exportPatentXlsx([], statuses), XLSX_MIME)}>
              下載範本
            </button>
          </div>
        </div>
        <div className="panel-body" style={{ paddingBottom: 6 }}>
          <div className="form-grid cols-3" style={{ gridTemplateColumns: undefined }}>
            <label className="field span-2">
              <span>搜尋</span>
              <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="編號、名稱、申請案號、證書號、承辦人、事務所…" />
            </label>
            <label className="field">
              <span>狀態</span>
              <select className="input" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                <option value="">全部狀態</option>
                {statusNames.map((s) => <option key={s}>{s}</option>)}
              </select>
            </label>
            <label className="field">
              <span>承辦人</span>
              <select className="input" value={fOwner} onChange={(e) => setFOwner(e.target.value)}>
                <option value="">全部承辦人</option>
                {owners.map((s) => <option key={s}>{s}</option>)}
              </select>
            </label>
            <label className="field">
              <span>期限／追蹤日</span>
              <select className="input" value={fDue} onChange={(e) => setFDue(e.target.value as typeof fDue)}>
                <option value="recent">近期提醒（含逾期）</option>
                <option value="">全部</option>
                <option value="overdue">已逾期</option>
                <option value="d7">7 天內到期</option>
                <option value="d30">30 天內到期</option>
                <option value="later">尚未到期</option>
              </select>
            </label>
            <div className="field">
              <span>排序（主要／次要）</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <select className="input" aria-label="主要排序" value={sort1} onChange={(e) => setSort1(e.target.value as SortKey)}>
                  {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
                <select className="input" aria-label="次要排序" value={sort2} onChange={(e) => setSort2(e.target.value as SortKey)}>
                  {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
                <button className="btn" onClick={() => setAsc(!asc)} aria-label={asc ? '目前遞增，改為遞減' : '目前遞減，改為遞增'}>{asc ? '▲' : '▼'}</button>
              </div>
            </div>
          </div>
          {selected.size > 0 && (
            <div className="toolbar" style={{ marginTop: 10 }} role="region" aria-label="批次操作">
              <span className="badge info">已選 {selected.size} 筆</span>
              <select className="input" style={{ width: 'auto' }} defaultValue="" onChange={(e) => { void batchStatus(e.target.value); e.target.value = ''; }} aria-label="批次變更狀態">
                <option value="">批次變更狀態…</option>
                {statuses.filter((s) => s.active).map((s) => <option key={s.name}>{s.name}</option>)}
              </select>
              <button className="btn danger small" onClick={() => remove([...selected])}>移除所選</button>
              <button className="btn small" onClick={() => setSelected(new Set())}>取消選取</button>
            </div>
          )}
          <div className="cell-sub" style={{ marginTop: 8 }}>顯示 {rows.length} / {patents.length} 筆</div>
        </div>

        {!patents.length ? (
          <div className="empty">
            尚無資料。請「匯入 Excel／CSV」、按「新增案件」，或「載入示範資料」練習。
            <br />
            系統首次開啟為空白，不會放入任何假資料。
          </div>
        ) : (
          <>
            <div className="only-desktop">
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th><input type="checkbox" aria-label="全選" checked={rows.length > 0 && rows.every((r) => selected.has(r.id))} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>
                      <Th k="id">內部案件編號</Th>
                      <Th k="name">專利名稱</Th>
                      <th>申請案號／證書號</th>
                      <Th k="status">狀態</Th>
                      <Th k="owner">承辦人</Th>
                      <Th k="nextCheck">下次確認日</Th>
                      <Th k="deadline">重要期限</Th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.id} className={selected.has(p.id) ? 'selected' : ''}>
                        <td><input type="checkbox" aria-label={`選取 ${p.id}`} checked={selected.has(p.id)} onChange={() => toggleSel(p.id)} /></td>
                        <td className="num"><b>{p.id}</b></td>
                        <td>{p.name}<span className="cell-sub">{[p.type, p.country, p.firm].filter(Boolean).join('・')}</span></td>
                        <td className="num">{p.appNo || '—'}<span className="cell-sub">{p.certNo ? `證書 ${p.certNo}` : '尚無證書號'}</span></td>
                        <td>{p.status}</td>
                        <td>{p.owner || '—'}</td>
                        <td><DueText date={p.nextCheck} /></td>
                        <td>{p.deadline ? <><DueText date={p.deadline} /><span className="cell-sub">{p.deadlineType || '未指定種類'}</span></> : <span className="cell-sub">未設定</span>}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn small" onClick={() => setEditing({ p: { ...p }, isNew: false })}>編輯</button>{' '}
                          <button className="btn small danger" onClick={() => remove([p.id])}>刪除</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <ul className="case-list only-mobile" aria-label="案件清單（精簡）">
              {rows.map((p) => {
                const open = expanded === p.id;
                const nb = dueBucket(p.nextCheck).bucket;
                const db = dueBucket(p.deadline).bucket;
                const alert = nb === 'overdue' || db === 'overdue';
                return (
                  <li key={p.id}>
                    <div className="case-row">
                      <input type="checkbox" aria-label={`選取 ${p.id}`} checked={selected.has(p.id)} onChange={() => toggleSel(p.id)} style={{ width: 22, height: 22, marginTop: 2 }} />
                      <div className="title">{p.id}・{p.name}</div>
                      <button className="btn small" aria-expanded={open} onClick={() => setExpanded(open ? null : p.id)}>{open ? '收合' : '詳情'}</button>
                      <div className="meta">
                        <span>{p.status}</span>
                        {p.appNo && <span>申請 {p.appNo}</span>}
                        {p.nextCheck && <span className={nb === 'overdue' ? 'due-overdue' : nb === 'd7' || nb === 'd30' ? 'due-soon' : ''}>確認 {p.nextCheck}</span>}
                        {p.deadline && <span className={db === 'overdue' ? 'due-overdue' : db === 'd7' || db === 'd30' ? 'due-soon' : ''}>期限 {p.deadline}</span>}
                        {alert && <span className="badge bad">⚠ 已逾期</span>}
                      </div>
                    </div>
                    {open && (
                      <div className="case-detail">
                        <dl>
                          {FIELDS.filter((f) => p[f.key]).map((f) => (
                            <div key={f.key} style={{ display: 'contents' }}>
                              <dt>{f.label}</dt>
                              <dd>{f.key === 'updatedAt' ? new Date(p.updatedAt).toLocaleString('zh-TW', { hour12: false }) : p[f.key]}</dd>
                            </div>
                          ))}
                        </dl>
                        <div className="toolbar">
                          <button className="btn small" onClick={() => setEditing({ p: { ...p }, isNew: false })}>編輯</button>
                          <button className="btn small danger" onClick={() => remove([p.id])}>刪除</button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <div className="panel-body" style={{ borderTop: '1px solid var(--line)' }}>
          <label className="check">
            <input type="checkbox" checked={persistPatents} onChange={(e) => setPersistPatents(e.target.checked)} />
            在此瀏覽器暫存專利清單（localStorage，可隨時取消並清除）
          </label>
          <div className="cell-sub">預設不保存。開啟後資料只存在這台電腦的這個瀏覽器，不會上傳；正式備份仍請匯出 Excel 存至公司共用位置。</div>
        </div>
      </section>

      {editing && <PatentForm init={editing.p} isNew={editing.isNew} statuses={statuses.filter((s) => s.active || s.name === editing.p.status).map((s) => s.name)} onClose={() => setEditing(null)} onSave={(p) => save(p, editing.isNew, editing.p.id)} />}

      {showIntegrity && (
        <Modal title={`資料完整性檢查（${integrity.length}）`} onClose={() => setShowIntegrity(false)} footer={<button className="btn" onClick={() => setShowIntegrity(false)}>關閉</button>}>
          {!integrity.length ? (
            <p>未發現符合目前規則的問題。</p>
          ) : (
            <div className="table-wrap noscroll">
              <table className="data">
                <thead><tr><th>案件</th><th>欄位</th><th>問題</th><th></th></tr></thead>
                <tbody>
                  {integrity.map((i, n) => {
                    const legacy = /不在狀態清單/.exec(i.message) ? /「(.+?)」/.exec(i.message)?.[1] : undefined;
                    return (
                      <tr key={n}>
                        <td>{i.id}</td>
                        <td>{i.field}</td>
                        <td><span className={`badge ${i.level === 'error' ? 'bad' : 'warn'}`}>{i.level === 'error' ? '✕ 錯誤' : '! 提醒'}</span> {i.message}</td>
                        <td>{legacy && <button className="btn small" onClick={() => addStatus(legacy)}>加入狀態清單</button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
      {confirmNode}
    </>
  );
}

function PatentForm({ init, isNew, statuses, onClose, onSave }: { init: Patent; isNew: boolean; statuses: string[]; onClose: () => void; onSave: (p: Patent) => void }) {
  const [p, setP] = useState<Patent>(init);
  const set = (k: PatentKey, v: string) => setP({ ...p, [k]: v });
  const opts = (k: PatentKey) => (k === 'type' ? PATENT_TYPES : k === 'deadlineType' ? ['', ...DEADLINE_TYPES] : k === 'status' ? [...new Set([...statuses, p.status])] : []);
  return (
    <Modal
      title={isNew ? '新增專利案件' : `編輯 ${init.id}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" type="submit" form="patent-form">{isNew ? '新增' : '儲存修改'}</button>
        </>
      }
    >
      <form id="patent-form" onSubmit={(e) => { e.preventDefault(); onSave(p); }}>
        <div className="form-grid cols-3">
          {FIELDS.filter((f) => f.key !== 'updatedAt').map((f) => (
            <label key={f.key} className={`field ${f.kind === 'long' || f.key === 'name' ? 'span-2' : ''}`}>
              <span>{f.label}{f.required ? ' *' : ''}</span>
              {f.kind === 'enum' ? (
                <select className="input" value={p[f.key]} onChange={(e) => set(f.key, e.target.value)}>
                  {opts(f.key).map((o) => <option key={o} value={o}>{o || '（未指定）'}</option>)}
                </select>
              ) : f.kind === 'long' ? (
                <textarea className="input" value={p[f.key]} maxLength={1000} onChange={(e) => set(f.key, e.target.value)} />
              ) : (
                <input className="input" type={f.kind === 'date' ? 'date' : 'text'} required={f.required} maxLength={200} value={p[f.key]} onChange={(e) => set(f.key, e.target.value)} />
              )}
              <span className="help">{f.desc}</span>
            </label>
          ))}
        </div>
      </form>
    </Modal>
  );
}
