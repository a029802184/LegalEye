// 全域狀態：規則設定、專利清單、各流程核對工作階段、提示訊息。
// 上傳的法律文件只存在記憶體；關閉或重新整理頁面即消失。

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { loadSettings, saveSettings, type Settings } from '../core/rules';
import type { ChromePageText, ExtractedDoc, FieldCorrection, FlowId, FlowResult, ManualPair } from '../core/types';
import type { SkippedEntry } from '../core/zip';
import { DEFAULT_STATUSES, type Patent, type StatusDef } from '../patent/model';
import type { ServiceManualInput } from '../flows/flowB';

export interface CheckSession {
  flow: FlowId;
  batchName: string;
  docs: ExtractedDoc[];
  skipped: SkippedEntry[];
  folders: string[];
  errors: string[];
  result?: FlowResult;
  service: Record<string, ServiceManualInput>;
  manualPairs: Record<string, ManualPair>;
  corrections?: Record<string, FieldCorrection>;
  chromePages?: ChromePageText[];
}

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

interface AppState {
  settings: Settings;
  setSettings: (s: Settings) => void;
  patents: Patent[];
  setPatents: (p: Patent[], opts?: { dirty?: boolean }) => void;
  statuses: StatusDef[];
  setStatuses: (s: StatusDef[]) => void;
  patentDirty: boolean;
  markExported: () => void;
  persistPatents: boolean;
  setPersistPatents: (b: boolean) => void;
  sessions: Partial<Record<FlowId, CheckSession>>;
  setSession: (flow: FlowId, s: CheckSession | undefined) => void;
  toast: (text: string, kind?: 'info' | 'error') => void;
  toasts: Toast[];
}

const Ctx = createContext<AppState | null>(null);

const PATENT_KEY = 'legaleye.patents.v1';
const PERSIST_KEY = 'legaleye.patents.persist';
const STATUS_KEY = 'legaleye.patent.statuses.v1';

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 儲存空間不足或私密瀏覽 */
  }
}
function remove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState<Settings>(() => loadSettings());
  const [persistPatents, setPersistState] = useState<boolean>(() => readJson(PERSIST_KEY, false));
  const [patents, setPatentsState] = useState<Patent[]>(() => (readJson(PERSIST_KEY, false) ? readJson<Patent[]>(PATENT_KEY, []) : []));
  const [statuses, setStatusesState] = useState<StatusDef[]>(() => readJson(STATUS_KEY, DEFAULT_STATUSES));
  const [patentDirty, setDirty] = useState(false);
  const [sessions, setSessions] = useState<Partial<Record<FlowId, CheckSession>>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const setSettings = useCallback((s: Settings) => {
    setSettingsState(s);
    saveSettings(s);
  }, []);

  const setPatents = useCallback((p: Patent[], opts?: { dirty?: boolean }) => {
    setPatentsState(p);
    setDirty(opts?.dirty ?? true);
  }, []);

  useEffect(() => {
    if (persistPatents) writeJson(PATENT_KEY, patents);
  }, [patents, persistPatents]);

  const setPersistPatents = useCallback(
    (b: boolean) => {
      setPersistState(b);
      writeJson(PERSIST_KEY, b);
      if (b) writeJson(PATENT_KEY, patents);
      else remove(PATENT_KEY);
    },
    [patents],
  );

  const setStatuses = useCallback((s: StatusDef[]) => {
    setStatusesState(s);
    writeJson(STATUS_KEY, s);
  }, []);

  const setSession = useCallback((flow: FlowId, s: CheckSession | undefined) => {
    setSessions((prev) => ({ ...prev, [flow]: s }));
  }, []);

  const toast = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3800);
  }, []);

  // 未匯出就離開時提醒
  const hasSession = Object.values(sessions).some((s) => s?.result);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if ((patentDirty && !persistPatents) || hasSession) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [patentDirty, persistPatents, hasSession]);

  const value = useMemo<AppState>(
    () => ({
      settings,
      setSettings,
      patents,
      setPatents,
      statuses,
      setStatuses,
      patentDirty,
      markExported: () => setDirty(false),
      persistPatents,
      setPersistPatents,
      sessions,
      setSession,
      toast,
      toasts,
    }),
    [settings, setSettings, patents, setPatents, statuses, setStatuses, patentDirty, persistPatents, setPersistPatents, sessions, setSession, toast, toasts],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppProvider missing');
  return v;
}
