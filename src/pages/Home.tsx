import { FLOWS } from '../flows';
import { PatentImport } from '../patent/PatentImport';
import { dueBucket, DUE_LABEL, groupOf } from '../patent/model';
import { useApp } from '../state/store';
import { Icon } from '../ui/components';
import { FlowCards } from '../ui/FlowCards';
import { Logo } from '../ui/Logo';

export function HomePage() {
  const { patents, statuses, sessions } = useApp();
  const active = FLOWS.filter(({ id }) => sessions[id]);
  const dueItems = patents.filter((p) => groupOf(p.status, statuses) !== 'closed')
    .flatMap((p) => [
      { p, field: 'deadline', kind: p.deadlineType || '重要期限', date: p.deadline, ...dueBucket(p.deadline) },
      { p, field: 'nextCheck', kind: '下次確認日', date: p.nextCheck, ...dueBucket(p.nextCheck) },
    ])
    .filter((x) => x.bucket === 'overdue' || x.bucket === 'd7' || x.bucket === 'd30')
    .sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div className="home-workspace">
      <header className="home-intro">
        <div className="home-brand">
          <span className="home-logo"><Logo size={32} /></span>
          <div><span className="home-wordmark">法眼 <span>LegalEye</span></span><p>法務文件核對與專利案件管理</p></div>
        </div>
        <h1>今天要處理什麼工作？</h1>
        <p>選擇文件類型，上傳相關資料，即可開始交叉核對。</p>
      </header>

      <section className="home-section" aria-labelledby="home-check">
        <div className="section-heading">
          <h2 id="home-check">法律文件核對</h2>
          <p>上傳文件、確認分類、查看結果並下載校對報告。</p>
        </div>
        <FlowCards />
        {active.length > 0 && (
          <div className="active-work">
            <h3>繼續本次核對</h3>
            <ul>
              {active.map(({ id, title }) => {
                const session = sessions[id];
                const units = session?.result?.units;
                return <li key={id}><a href={`#/check/${id}`}>{title}</a><span>{units ? `${units.length} 個核對單位` : '待確認文件分類'}</span></li>;
              })}
            </ul>
          </div>
        )}
      </section>

      <section className="patent-overview" aria-labelledby="home-patent">
        <div className="patent-entry">
          <span className="feature-icon"><Icon name="folder" size={24} /></span>
          <div>
            <h2 id="home-patent">專利案件管理</h2>
            <p>維護案件主檔、查找案件並追蹤重要期限。</p>
            <div className="toolbar">
              <a className="btn primary" href="#/patents">開啟專利管理</a>
              <PatentImport label="匯入 Excel" />
              <a className="text-action" href="#/patents?view=list">查看案件清單</a>
            </div>
          </div>
        </div>
        <div className="patent-reminders">
          <div className="reminder-heading"><Icon name="calendar" size={18} /><h3>近期待辦及期限提醒</h3></div>
          {!patents.length ? <p>匯入專利主檔後，即可查看期限提醒。</p>
            : !dueItems.length ? <p>目前沒有已逾期或 30 天內的待辦。</p>
            : <ul>{dueItems.slice(0, 3).map(({ p, field, kind, date, bucket }) => (
              <li key={`${p.id}/${field}`}>
                <div><a href={`#/patents?view=list&q=${encodeURIComponent(p.id)}`}>{p.id} {p.name}</a><span className="cell-sub">{kind}</span></div>
                <div className={`num ${bucket === 'overdue' ? 'due-overdue' : 'due-soon'}`}>{date}<span className="cell-sub">{DUE_LABEL[bucket]}</span></div>
              </li>
            ))}</ul>}
          {patents.length > 0 && <a className="text-action" href="#/patents?view=due">查看近期提醒</a>}
        </div>
      </section>
    </div>
  );
}
