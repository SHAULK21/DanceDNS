import { useCallback, useEffect, useState } from 'react';
import { Activity, Gauge, ListTree, Power, Search, Server, Settings } from 'lucide-react';
import { api } from './api';
import type { Config, Status } from './types';
import { Dashboard } from './components/Dashboard';
import { RulesView } from './components/RulesView';
import { LogView } from './components/LogView';
import { ServersView } from './components/ServersView';
import { TestView } from './components/TestView';
import { SettingsView } from './components/SettingsView';
import { Toasts, toast } from './components/ui';

type Tab = 'dash' | 'rules' | 'log' | 'servers' | 'test' | 'settings';

const TABS: { id: Tab; label: string; icon: typeof Gauge }[] = [
  { id: 'dash', label: 'Обзор', icon: Gauge },
  { id: 'rules', label: 'Правила', icon: ListTree },
  { id: 'log', label: 'Журнал', icon: Activity },
  { id: 'servers', label: 'Серверы и пулы', icon: Server },
  { id: 'test', label: 'Проверка', icon: Search },
  { id: 'settings', label: 'Настройки', icon: Settings },
];

export default function App() {
  const [tab, setTab] = useState<Tab>(() => (TABS.some((x) => x.id === location.hash.slice(1)) ? (location.hash.slice(1) as Tab) : 'dash'));
  const [status, setStatus] = useState<Status | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [offline, setOffline] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [testPreset, setTestPreset] = useState<{ process: string; domain: string } | null>(null);

  useEffect(() => {
    if (location.hash.slice(1) !== tab) location.hash = tab;
  }, [tab]);

  useEffect(() => {
    const onHash = () => {
      const t = location.hash.slice(1) as Tab;
      if (TABS.some((x) => x.id === t)) setTab(t);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    api.config().then(setConfig).catch(() => setOffline(true));
    const t = setInterval(refreshStatus, 2000);
    return () => clearInterval(t);
  }, [refreshStatus]);

  const saveConfig = useCallback(async (next: Config): Promise<boolean> => {
    try {
      const r = await api.saveConfig(next);
      setConfig(next);
      toast(r.restart_required ? 'Сохранено. Новые адреса начнут работать после перезапуска DanceDNS.' : 'Сохранено и применено', 'ok');
      refreshStatus();
      return true;
    } catch (e: any) {
      toast(e.message, 'error');
      return false;
    }
  }, [refreshStatus]);

  const stop = async () => {
    if (!confirm('Остановить DanceDNS? Если системный DNS направлен на DanceDNS, он будет восстановлен.')) return;
    try {
      await api.shutdown();
    } catch {}
    setStopped(true);
  };

  if (stopped) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-300">
        <div className="card p-8 text-center max-w-md">
          <div className="text-4xl mb-3">💤</div>
          <h1 className="text-lg font-bold mb-2">DanceDNS остановлен</h1>
          <p className="text-sm text-slate-400">Чтобы снова включить его, запустите dancedns.exe. Эту вкладку можно закрыть.</p>
        </div>
      </div>
    );
  }

  const running = status && status.listeners.some((l) => l.udp);

  return (
    <div className="min-h-screen flex flex-col antialiased">
      <header className="flex items-center gap-6 px-5 py-3 border-b border-slate-800 bg-slate-950/90 backdrop-blur sticky top-0 z-40">
        <button onClick={() => setTab('dash')} className="flex items-center gap-2 text-lg font-extrabold tracking-tight shrink-0">
          <span>💃</span>
          <span>DanceDNS</span>
        </button>
        <nav className="flex items-center gap-1 overflow-x-auto text-xs font-semibold">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
                tab === id ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 shrink-0">
          <span
            className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border ${
              offline
                ? 'border-rose-700 text-rose-300 bg-rose-950/50'
                : running
                  ? 'border-emerald-700 text-emerald-300 bg-emerald-950/40'
                  : 'border-amber-700 text-amber-300 bg-amber-950/40'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${offline ? 'bg-rose-400' : running ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
            {offline ? 'нет связи' : running ? 'работает' : 'DNS не запущен'}
          </span>
          <button onClick={stop} title="Остановить DanceDNS" className="btn-ghost !px-2">
            <Power className="w-4 h-4" />
          </button>
        </div>
      </header>

      {offline && (
        <div className="bg-rose-950/60 border-b border-rose-900 text-rose-200 text-sm px-5 py-2">
          Нет связи с DanceDNS. Проверьте, что программа запущена.
        </div>
      )}

      <main className="flex-1 w-full max-w-7xl mx-auto p-4 md:p-6">
        {!config || !status ? (
          <div className="text-slate-500 text-sm">Загрузка…</div>
        ) : (
          <>
            {tab === 'dash' && <Dashboard status={status} config={config} onNavigate={setTab} />}
            {tab === 'rules' && (
              <RulesView
                config={config}
                onSave={saveConfig}
                onTest={(process, domain) => {
                  setTestPreset({ process, domain });
                  setTab('test');
                }}
              />
            )}
            {tab === 'log' && <LogView config={config} onSave={saveConfig} />}
            {tab === 'servers' && <ServersView config={config} status={status} onSave={saveConfig} />}
            {tab === 'test' && <TestView preset={testPreset} />}
            {tab === 'settings' && <SettingsView config={config} status={status} onSave={saveConfig} />}
          </>
        )}
      </main>

      <footer className="border-t border-slate-800 px-5 py-3 text-[11px] text-slate-500 flex flex-wrap gap-x-4 gap-y-1 justify-between">
        <span>DanceDNS {status?.version} · DNS-over-HTTPS (RFC 8484) · правила по процессам</span>
        <span className="font-mono truncate">{status?.config_path}</span>
      </footer>
      <Toasts />
    </div>
  );
}
