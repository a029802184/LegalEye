import { useRef, useState } from 'react';
import { useApp } from '../state/store';
import { Icon, Modal } from '../ui/components';
import { readFileBytes } from '../ui/util';
import { importPatentFile, type ImportReport } from './io';

export function PatentImport({ label = '匯入 Excel／CSV' }: { label?: string }) {
  const { patents, setPatents, setStatuses, toast } = useApp();
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const close = () => {
    setReport(null);
    setConfirmReplace(false);
  };

  const read = async (file: File) => {
    if (file.size > 20 * 1024 * 1024) return toast('檔案超過 20 MB', 'error');
    setBusy(true);
    try {
      setReport(await importPatentFile(file.name, await readFileBytes(file)));
    } catch (e) {
      toast('匯入失敗：' + (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const apply = (replace: boolean) => {
    if (!report || report.errors.length || !report.records.length) return;
    if (replace && patents.length && !confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    const records = replace ? report.records : [...new Map([...patents, ...report.records].map((p) => [p.id, p])).values()];
    setPatents(records, { dirty: false });
    if (report.statuses?.length) setStatuses(report.statuses);
    toast(`已匯入 ${report.records.length} 筆${report.statuses ? '，並套用檔案中的狀態設定' : ''}`);
    close();
  };

  return (
    <>
      <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
        <Icon name="upload" size={16} />{busy ? '讀取中…' : label}
      </button>
      <input ref={fileRef} type="file" hidden data-testid="patent-import" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) void read(file);
      }} />
      {report && (
        <Modal
          title={confirmReplace ? '確認取代清單' : '匯入預覽'}
          onClose={close}
          footer={confirmReplace ? (
            <><button className="btn" onClick={() => setConfirmReplace(false)}>返回預覽</button><button className="btn danger" onClick={() => apply(true)}>確認取代</button></>
          ) : (
            <>
              <button className="btn" onClick={close}>取消</button>
              <button className="btn" disabled={!!report.errors.length || !report.records.length} onClick={() => apply(false)}>合併（同編號以匯入為準）</button>
              <button className="btn primary" disabled={!!report.errors.length || !report.records.length} onClick={() => apply(true)}>取代目前清單</button>
            </>
          )}
        >
          {confirmReplace ? <p>以匯入的 {report.records.length} 筆案件取代目前的 {patents.length} 筆案件？</p> : (
            <>
              <p>讀到 <b>{report.records.length}</b> 筆案件，資料格式版本 {report.version}。</p>
              {report.errors.length > 0 && <div className="note bad"><b>請修正 Excel 後重新匯入</b><ul>{report.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></div>}
              {report.warnings.length > 0 && <div className="note warn"><ul>{report.warnings.slice(0, 30).map((e, i) => <li key={i}>{e}</li>)}</ul></div>}
              {report.statuses && <p className="cell-sub">匯入時會一併套用 {report.statuses.length} 種案件狀態設定。</p>}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
