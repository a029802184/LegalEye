import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, useMedia } from './components';
import { Logo } from './Logo';
import { FLOWS } from '../flows';

export function useHashPath(): string {
  const get = () => location.hash.slice(1) || '/';
  const [path, setPath] = useState(get);
  useEffect(() => {
    const update = () => setPath(get());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return path;
}

const NAV = [
  { href: '#/', label: '首頁', icon: 'home', match: (p: string) => p === '/' },
  { href: '#/check', label: '法律文件核對', icon: 'doc', match: (p: string) => p.startsWith('/check') },
  { href: '#/patents', label: '專利案件管理', icon: 'folder', match: (p: string) => p.startsWith('/patents') },
  { href: '#/rules', label: '規則與設定', icon: 'gear', match: (p: string) => p.startsWith('/rules') },
  { href: '#/help', label: '使用說明', icon: 'help', match: (p: string) => p.startsWith('/help') },
];

export function pageTitle(path: string): string {
  if (path.startsWith('/check/')) {
    const flow = FLOWS.find((f) => f.id === path.slice(7, 8));
    if (flow) return flow.short;
  }
  return NAV.find((n) => n.match(path))?.label ?? '';
}

function NavList({ path, onNavigate }: { path: string; onNavigate?: () => void }) {
  return (
    <>
      <a className="nav-brand" href="#/" onClick={onNavigate}>
        <Logo size={34} />
        <span>法眼 <span className="brand-latin">LegalEye</span></span>
      </a>
      <nav className="nav" aria-label="主要功能">
        {NAV.map((n) => (
          <div key={n.href} className={n.href === '#/rules' ? 'nav-divider' : undefined}>
            <a href={n.href} aria-current={n.match(path) && !(n.href === '#/check' && path.length > 6) ? 'page' : undefined} onClick={onNavigate}>
              <Icon name={n.icon} size={18} />{n.label}
            </a>
            {n.href === '#/check' && (
              <div className="nav-subgroup">
                {FLOWS.map((f) => (
                  <a key={f.id} className="sub" href={`#/check/${f.id}`} aria-current={path === `/check/${f.id}` ? 'page' : undefined} onClick={onNavigate}>{f.short}</a>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>
      <div className="nav-foot"><Icon name="lock" size={16} /><span>文件僅在本機瀏覽器處理</span></div>
    </>
  );
}

export function Layout({ path, children }: { path: string; children: ReactNode }) {
  const drawer = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const desktop = useMedia('(min-width: 1024px)');
  const close = () => drawer.current?.close();
  useEffect(() => drawer.current?.close(), [path, desktop]);

  return (
    <div className="app">
      <aside className="sidebar" aria-label="側邊導覽"><NavList path={path} /></aside>
      <div className="app-content">
        <header className="topbar">
          <button className="icon-btn menu-toggle" aria-label="開啟選單" aria-expanded={open} aria-controls="drawer" onClick={() => {
            drawer.current?.showModal();
            setOpen(true);
          }}><Icon name="menu" /></button>
          <a className="brand" href="#/" aria-label="法眼 LegalEye 首頁"><Logo size={28} /><span className="brand-text">法眼 <span className="brand-latin">LegalEye</span></span></a>
          <div className="top-path">
            <a href="#/">工作台</a>
            {path !== '/' && <><Icon name="chevron" size={13} /><span>{pageTitle(path)}</span></>}
          </div>
          {path !== '/help' && <a className="top-help" href="#/help" aria-label="使用說明"><Icon name="help" size={17} /><span>使用說明</span></a>}
        </header>
        <main className="main" id="main">{children}</main>
      </div>
      <dialog className="drawer" id="drawer" aria-label="選單" ref={drawer} onClose={() => setOpen(false)} onClick={(e) => {
        if (e.target === e.currentTarget && e.clientX > e.currentTarget.getBoundingClientRect().right) close();
      }}>
        <button className="icon-btn drawer-close" aria-label="關閉選單" onClick={close}><Icon name="close" /></button>
        <NavList path={path} onNavigate={close} />
      </dialog>
    </div>
  );
}
