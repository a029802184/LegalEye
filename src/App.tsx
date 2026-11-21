import { useEffect } from 'react';
import { Layout, pageTitle, useHashPath } from './ui/Layout';
import { Toasts } from './ui/components';
import { useApp } from './state/store';
import { HomePage } from './pages/Home';
import { PatentsPage } from './pages/Patents';
import { CheckPage } from './pages/Check';
import { RulesPage } from './pages/Rules';
import { HelpPage } from './pages/Help';
import type { FlowId } from './core/types';

export function App() {
  const route = useHashPath();
  const [path, query = ''] = route.split('?');
  const { toasts } = useApp();
  useEffect(() => {
    const t = pageTitle(path);
    document.title = `${t ? t + '｜' : ''}法眼 LegalEye｜法務室智慧作業輔助系統`;
    window.scrollTo(0, 0);
  }, [path, query]);

  let page;
  if (path.startsWith('/patents')) page = <PatentsPage key={query} query={query} />;
  else if (path.startsWith('/check')) {
    const f = path.slice(7, 8) as FlowId;
    page = <CheckPage flow={['A', 'B', 'C', 'D'].includes(f) ? f : undefined} />;
  } else if (path.startsWith('/rules')) page = <RulesPage />;
  else if (path.startsWith('/help')) page = <HelpPage />;
  else page = <HomePage />;

  return (
    <Layout path={path}>
      {page}
      <Toasts items={toasts} />
    </Layout>
  );
}
