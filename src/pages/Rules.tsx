import { useRef, useState } from 'react';
import { useApp } from '../state/store';
import { Modal, PageHead, useConfirm } from '../ui/components';
import { download, readFileBytes, stamp } from '../ui/util';
import { CHECK_CATALOG, clearSettings, DEFAULT_SETTINGS, migrateSettings, RULESET_VERSION, type Settings } from '../core/rules';
import { SERVICE_RULE_VERSION } from '../core/service';
import { FLOWS } from '../flows';
import { DEFAULT_STATUSES, STATUS_GROUP_LABEL, type StatusDef, type StatusGroup } from '../patent/model';
import { decodeText } from '../core/ingest';
import { maskAccount } from '../core/idno';

export function RulesPage() {
  const { settings, setSettings, statuses, setStatuses, toast } = useApp();
  const [confirm, confirmNode] = useConfirm();
  const [disabling, setDisabling] = useState<{ id: string; label: string } | null>(null);
  const [reason, setReason] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const update = (patch: Partial<Settings>) => {
    setSettings({ ...settings, ...patch });
    toast('已儲存設定（此瀏覽器）');
  };

  const exportJson = () => {
    const data = { _說明: '法眼 LegalEye 規則設定檔。可在「規則與設定 → 匯入設定」載入。', settings, patentStatuses: statuses, exportedAt: new Date().toISOString() };
    download(`法眼_規則設定_${stamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
  };
  const importJson = async (f: File) => {
    try {
      if (f.size > 2 * 1024 * 1024) throw new Error('設定檔過大');
      const obj = JSON.parse(decodeText(await readFileBytes(f)));
      const s = migrateSettings(obj.settings ?? obj);
      if (!(await confirm(`匯入設定會取代目前的規則設定（規則版本：${s.rulesetVersion}）。確定？`))) return;
      setSettings(s);
      if (Array.isArray(obj.patentStatuses)) setStatuses(obj.patentStatuses.filter((x: StatusDef) => x && typeof x.name === 'string'));
      toast('已匯入設定');
    } catch (e) {
      toast('設定檔格式錯誤：' + (e as Error).message, 'error');
    }
  };

  return (
    <>
      <PageHead
        title="規則與設定"
        desc="不需修改程式即可維護核對規則、同義詞、帳號主檔與專利狀態。設定存在此瀏覽器，請定期匯出 JSON 備份交接。"
        actions={
          <>
            <button className="btn" onClick={exportJson}>匯出設定（JSON）</button>
            <button className="btn" onClick={() => fileRef.current?.click()}>匯入設定</button>
            <input ref={fileRef} type="file" hidden accept=".json,application/json" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importJson(f); }} />
          </>
        }
      />
      <div className="note">
        目前規則版本：<b>{settings.rulesetVersion}</b>（系統內建 {RULESET_VERSION}；送達／利息規則 {SERVICE_RULE_VERSION}）。報告會記錄所用版本。
      </div>

      <section className="panel">
        <div className="panel-head"><h2>檢查項目</h2><span className="hint">停用某項檢查必須填寫原因，原因會寫入每份報告</span></div>
        <div className="panel-body">
          {FLOWS.map((f) => (
            <div key={f.id} style={{ marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, margin: '4px 0' }}>{f.id}. {f.title}</h3>
              <div className="table-wrap noscroll">
                <table className="data">
                  <tbody>
                    {CHECK_CATALOG.filter((c) => c.flow === f.id).map((c) => {
                      const off = settings.disabledChecks.find((d) => d.id === c.id);
                      return (
                        <tr key={c.id}>
                          <td style={{ width: '28%' }}><b>{c.label}</b><span className="cell-sub">{c.id}</span></td>
                          <td>{c.desc}{off && <span className="cell-sub" style={{ color: 'var(--amber)' }}>已停用：{off.reason}（{off.at}）</span>}</td>
                          <td style={{ width: 110 }}>
                            {off ? (
                              <button className="btn small" onClick={() => update({ disabledChecks: settings.disabledChecks.filter((d) => d.id !== c.id) })}>重新啟用</button>
                            ) : (
                              <button className="btn small" onClick={() => { setReason(''); setDisabling({ id: c.id, label: c.label }); }}>停用…</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid-2">
        <ListEditor
          title="附件名稱同義詞"
          hint="每行一組，以「／」分隔。同組名稱視為同一種文件（例：行動寬頻申請書／申裝書）。檔名相似仍不等於內容一致。"
          value={settings.attachmentSynonyms.map((g) => g.join('／')).join('\n')}
          onSave={(v) => update({ attachmentSynonyms: v.split('\n').map((l) => l.split(/[／/]/).map((x) => x.trim()).filter(Boolean)).filter((g) => g.length >= 2) })}
        />
        <ListEditor
          title="法院簡稱對照"
          hint="每行「簡稱＝正式全名」。法院所在地、年度、字別、案號仍精準比對。"
          value={Object.entries(settings.courtAliases).map(([k, v]) => `${k}＝${v}`).join('\n')}
          onSave={(v) => update({ courtAliases: Object.fromEntries(v.split('\n').map((l) => l.split(/[＝=]/).map((x) => x.trim())).filter((p) => p.length === 2 && p[0] && p[1])) })}
        />
        <ListEditor
          title="公司收款帳號主檔"
          hint="每行「名稱＝帳號」。只有設定主檔時，流程 A 才會核對通知函帳號；法院未記載帳號時不判定錯誤。存在此瀏覽器，畫面顯示遮罩。"
          value={settings.bankMaster.map((b) => `${b.label}＝${b.account}`).join('\n')}
          display={settings.bankMaster.map((b) => `${b.label}＝${maskAccount(b.account)}`).join('\n') || '（尚未設定）'}
          onSave={(v) => update({ bankMaster: v.split('\n').map((l) => l.split(/[＝=]/).map((x) => x.trim())).filter((p) => p.length === 2 && /\d{6,}/.test(p[1])).map(([label, acc]) => ({ label, account: acc.replace(/\D/g, '') })) })}
        />
        <ListEditor
          title="債務明細表欄位名稱（流程 D）"
          hint="每行「欄位代碼：名稱1／名稱2」。代碼：key 門號、telecom 電信資費、collect 代收費用、subsidy 專案補貼款、other 其他應收、paid 已繳款、balance 未償債務。"
          value={Object.entries(settings.debtColumns).map(([k, v]) => `${k}：${(v as string[]).join('／')}`).join('\n')}
          onSave={(v) => {
            const next = { ...settings.debtColumns };
            for (const l of v.split('\n')) {
              const m = /^(\w+)\s*[:：]\s*(.+)$/.exec(l.trim());
              if (m && m[1] in next) (next as Record<string, string[]>)[m[1]] = m[2].split(/[／/]/).map((x) => x.trim()).filter(Boolean);
            }
            update({ debtColumns: next });
          }}
        />
      </div>

      <section className="panel">
        <div className="panel-head"><h2>核對畫面隱私</h2></div>
        <div className="panel-body">
          <label className="check">
            <input type="checkbox" checked={settings.maskByDefault} onChange={(e) => update({ maskByDefault: e.target.checked })} />
            核對畫面遮罩身分證字號、帳號、電話
          </label>
          <p className="cell-sub">每次開啟核對結果時，下載報告預設遮罩。需要完整版本時可在當次匯出前調整。</p>
        </div>
      </section>

      <StatusEditor statuses={statuses} onSave={(s) => { setStatuses(s); toast('已儲存專利狀態設定'); }} />

      <section className="panel">
        <div className="panel-head"><h2>還原與清除</h2></div>
        <div className="panel-body toolbar">
          <button className="btn" onClick={async () => { if (await confirm('將規則設定還原為系統預設值？（建議先匯出備份）', { danger: true })) { setSettings(structuredClone(DEFAULT_SETTINGS)); toast('已還原預設規則'); } }}>還原預設規則</button>
          <button className="btn" onClick={async () => { if (await confirm('將專利狀態清單還原為預設？', { danger: true })) setStatuses(DEFAULT_STATUSES); }}>還原預設狀態</button>
          <button className="btn danger" onClick={async () => { if (await confirm('清除此瀏覽器中儲存的所有規則設定？', { danger: true })) { clearSettings(); setSettings(structuredClone(DEFAULT_SETTINGS)); } }}>清除瀏覽器設定</button>
        </div>
      </section>

      {disabling && (
        <Modal
          title={`停用檢查：${disabling.label}`}
          narrow
          onClose={() => setDisabling(null)}
          footer={
            <>
              <button className="btn" onClick={() => setDisabling(null)}>取消</button>
              <button
                className="btn primary"
                disabled={reason.trim().length < 4}
                onClick={() => {
                  update({ disabledChecks: [...settings.disabledChecks, { id: disabling.id, reason: reason.trim(), at: new Date().toLocaleString('zh-TW', { hour12: false }) }] });
                  setDisabling(null);
                }}
              >
                停用
              </button>
            </>
          }
        >
          <label className="field">
            <span>停用原因（至少 4 字，會寫入報告）</span>
            <textarea className="input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
          </label>
        </Modal>
      )}
      {confirmNode}
    </>
  );
}

function ListEditor({ title, hint, value, display, onSave }: { title: string; hint: string; value: string; display?: string; onSave: (v: string) => void }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(value);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {!edit && <button className="btn small" onClick={() => { setV(value); setEdit(true); }}>編輯</button>}
      </div>
      <div className="panel-body">
        <p className="cell-sub" style={{ marginTop: 0 }}>{hint}</p>
        {edit ? (
          <>
            <textarea className="input" rows={8} value={v} onChange={(e) => setV(e.target.value)} aria-label={title} />
            <div className="toolbar" style={{ marginTop: 8 }}>
              <button className="btn primary" onClick={() => { onSave(v); setEdit(false); }}>儲存</button>
              <button className="btn" onClick={() => setEdit(false)}>取消</button>
            </div>
          </>
        ) : (
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit', fontSize: 14 }}>{display ?? (value || '（空白）')}</pre>
        )}
      </div>
    </section>
  );
}

function StatusEditor({ statuses, onSave }: { statuses: StatusDef[]; onSave: (s: StatusDef[]) => void }) {
  const [list, setList] = useState(statuses);
  const [name, setName] = useState('');
  const dirty = JSON.stringify(list) !== JSON.stringify(statuses);
  const move = (i: number, d: number) => {
    const l = [...list];
    const [x] = l.splice(i, 1);
    l.splice(i + d, 0, x);
    setList(l);
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>專利案件狀態</h2>
        <span className="hint">可新增、調整分組或停用；停用的狀態仍保留在既有案件中</span>
      </div>
      <div className="table-wrap noscroll">
        <table className="data">
          <thead><tr><th>狀態名稱</th><th>統計分組</th><th>啟用</th><th>順序</th></tr></thead>
          <tbody>
            {list.map((s, i) => (
              <tr key={s.name}>
                <td>{s.name}</td>
                <td>
                  <select className="input" style={{ minHeight: 34 }} value={s.group} aria-label={`${s.name} 分組`} onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, group: e.target.value as StatusGroup } : x)))}>
                    {Object.entries(STATUS_GROUP_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </td>
                <td><input type="checkbox" style={{ width: 20, height: 20 }} aria-label={`${s.name} 啟用`} checked={s.active} onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, active: e.target.checked } : x)))} /></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="上移">↑</button>{' '}
                  <button className="btn small" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="下移">↓</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel-body toolbar">
        <input className="input" style={{ maxWidth: 260 }} placeholder="新增狀態名稱" value={name} maxLength={30} onChange={(e) => setName(e.target.value)} aria-label="新增狀態名稱" />
        <button className="btn" disabled={!name.trim() || list.some((s) => s.name === name.trim())} onClick={() => { setList([...list, { name: name.trim(), group: 'other', active: true }]); setName(''); }}>新增</button>
        <button className="btn primary" disabled={!dirty} onClick={() => onSave(list)}>儲存狀態設定</button>
      </div>
    </section>
  );
}
