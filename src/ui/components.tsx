import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { STATUS_LABEL, UNIT_STATUS_LABEL, type CheckStatus, type UnitStatus } from '../core/types';

// ---------- 圖示（單色線條，僅用於有意義的操作） ----------
const PATHS: Record<string, string> = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6L6 18',
  back: 'M15 18l-6-6 6-6',
  upload: 'M12 16V4m0 0l-5 5m5-5l5 5M4 20h16',
  download: 'M12 4v12m0 0l-5-5m5 5l5-5M4 20h16',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zm9 2l-4.3-4.3',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
  folder: 'M3 7h6l2 2h10v10H3z',
  check: 'M5 13l4 4L19 7',
  doc: 'M7 3h7l5 5v13H7zM14 3v5h5',
  'doc-check': 'M13 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8l5 5v3M14 3v5h5M8 8h2m-2 4h5m1 5 3 3 5-6',
  'doc-search': 'M11 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8l5 5v2M14 3v5h5M8 8h2m-2 4h3m9.5 8.5L22 22m-4.5-1a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  'doc-stack': 'M4 17H3V3h12v1M7 20V6h9l4 4v2M16 6v4h4M7 20h5m2-3 3 3 5-6',
  'doc-clip': 'M12 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8l5 5M14 3v5h5M8 8h2m-2 4h3m9 2-4.2 4.2a1.4 1.4 0 0 1-2-2l4.1-4.2a2.8 2.8 0 0 1 4 4l-4.1 4.2',
  calendar: 'M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm2-2v4m8-4v4M4 10h16m-12 5h3',
  lock: 'M6 10h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Zm2 0V7a4 4 0 0 1 8 0v3m-4 4v2',
  chevron: 'M9 6l6 6-6 6',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8-3l2-1-2-4-2 1-2-1-1-2h-4l-1 2-2 1-2-1-2 4 2 1v2l-2 1 2 4 2-1 2 1 1 2h4l1-2 2-1 2 1 2-4-2-1z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm-2.5-12a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14m0 3h.01',
  share: 'M4 12v8h16v-8M12 3v13m0-13l-4 4m4-4l4 4',
};

export function Icon({ name, size = 20, label }: { name: keyof typeof PATHS | string; size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}

// ---------- 狀態標籤：文字＋符號，不只靠顏色 ----------
const ITEM_STYLE: Record<CheckStatus, [string, string]> = {
  match: ['ok', '✓'],
  mismatch: ['bad', '✕'],
  partial: ['warn', '◐'],
  missing: ['', '○'],
  unreadable: ['warn', '?'],
  'needs-review': ['warn', '!'],
  'not-applicable': ['', '–'],
};
export function StatusBadge({ status }: { status: CheckStatus }) {
  const [cls, sym] = ITEM_STYLE[status];
  return (
    <span className={`badge ${cls}`}>
      <span aria-hidden="true">{sym}</span>
      {STATUS_LABEL[status]}
    </span>
  );
}
const UNIT_STYLE: Record<UnitStatus, [string, string]> = {
  consistent: ['ok', '✓'],
  inconsistent: ['bad', '✕'],
  missing: ['', '○'],
  pending: ['warn', '!'],
  'not-applicable': ['', '–'],
};
export function UnitBadge({ status }: { status: UnitStatus }) {
  const [cls, sym] = UNIT_STYLE[status];
  return (
    <span className={`badge ${cls}`}>
      <span aria-hidden="true">{sym}</span>
      {UNIT_STATUS_LABEL[status]}
    </span>
  );
}

// ---------- 對話框：可鍵盤操作、ESC 關閉、內容可獨立捲動 ----------
export function Modal({
  title,
  onClose,
  children,
  footer,
  narrow,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  narrow?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('input,select,textarea,button:not([data-close])');
    (first ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && el) {
        const f = [...el.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])')];
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${narrow ? ' narrow' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} tabIndex={-1}>
        <div className="modal-head">
          <h2 id={id}>{title}</h2>
          <button className="icon-btn" data-close onClick={onClose} aria-label="關閉">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- 確認對話框（危險操作） ----------
export function useConfirm(): [(msg: string, opts?: { okText?: string; danger?: boolean }) => Promise<boolean>, ReactNode] {
  const [state, setState] = useState<{ msg: string; okText: string; danger: boolean; resolve: (b: boolean) => void } | null>(null);
  const ask = (msg: string, opts?: { okText?: string; danger?: boolean }) =>
    new Promise<boolean>((resolve) => setState({ msg, okText: opts?.okText ?? '確定', danger: opts?.danger ?? false, resolve }));
  const close = (b: boolean) => {
    state?.resolve(b);
    setState(null);
  };
  const node = state ? (
    <Modal
      title="請確認"
      narrow
      onClose={() => close(false)}
      footer={
        <>
          <button className="btn" onClick={() => close(false)}>
            取消
          </button>
          <button className={`btn ${state.danger ? 'danger' : 'primary'}`} onClick={() => close(true)}>
            {state.okText}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{state.msg}</p>
    </Modal>
  ) : null;
  return [ask, node];
}

export function Toasts({ items }: { items: { id: number; text: string; kind: 'info' | 'error' }[] }) {
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function PageHead({ title, desc, actions }: { title: string; desc?: string; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {desc && <p>{desc}</p>}
      </div>
      {actions && <div className="toolbar">{actions}</div>}
    </div>
  );
}

export function useMedia(query: string): boolean {
  const [m, setM] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const h = () => setM(mq.matches);
    mq.addEventListener('change', h);
    h();
    return () => mq.removeEventListener('change', h);
  }, [query]);
  return m;
}
