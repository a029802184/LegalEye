import { FLOWS } from '../flows';
import { Icon } from './components';

const CARDS = {
  A: { icon: 'doc-check', desc: '核對法院執行命令與通知函的當事人、案號及金額。' },
  B: { icon: 'doc-search', desc: '比對支付命令正本、債權金額、當事人及利息起算日。' },
  C: { icon: 'doc-stack', desc: '整批核對債務人聲請狀、戶籍謄本與欠費資料。' },
  D: { icon: 'doc-clip', desc: '比對法院庭函、債務明細、陳報狀及附件名稱。' },
};

export function FlowCards() {
  return (
    <div className="flow-grid">
      {FLOWS.map((flow) => (
        <article className="flow-card" key={flow.id} aria-labelledby={`card-${flow.id}`}>
          <span className="feature-icon"><Icon name={CARDS[flow.id].icon} size={24} /></span>
          <div className="flow-card-body">
            <h3 id={`card-${flow.id}`}>{flow.title}</h3>
            <p>{CARDS[flow.id].desc}</p>
            <a className="btn flow-action" href={`#/check/${flow.id}`} aria-labelledby={`action-${flow.id} card-${flow.id}`}>
              <span id={`action-${flow.id}`}>{flow.id === 'C' ? '開始批次核對' : '開始核對'}</span>
            </a>
          </div>
        </article>
      ))}
    </div>
  );
}
