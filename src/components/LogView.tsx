import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Ban, Pause, Play, Trash2 } from 'lucide-react';
import { api } from '../api';
import type { Config, LogEntry, LogStatus } from '../types';
import { Badge, STATUS_STYLE, fmtMs, toast } from './ui';

const MAX = 2000;

export function LogView({ config, onSave }: { config: Config; onSave: (c: Config) => Promise<boolean> }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<LogStatus | 'all'>('all');
  const [open, setOpen] = useState<number | null>(null);
  const last = useRef(0);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (pausedRef.current) return;
      try {
        const { entries: fresh } = await api.logs(last.current);
        if (!alive || fresh.length === 0) return;
        last.current = fresh[fresh.length - 1].seq;
        setEntries((prev) => [...fresh.reverse(), ...prev].slice(0, MAX));
      } catch {}
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries.filter(
      (e) =>
        (status === 'all' || e.status === status) &&
        (!needle || e.domain.toLowerCase().includes(needle) || e.process.toLowerCase().includes(needle) || e.rule.toLowerCase().includes(needle)),
    );
  }, [entries, q, status]);

  const topProcesses = useMemo(() => {
    const m = new Map<string, number>();
    entries.forEach((e) => m.set(e.process, (m.get(e.process) || 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [entries]);

  const blockDomain = async (domain: string) => {
    const base = domain.split('.').slice(-2).join('.');
    const target = prompt('Блокировать домен (вместе с поддоменами):', base);
    if (!target) return;
    await onSave({
      ...config,
      rules: [{ name: `Блок ${target}`, enabled: true, process: '', process_path: '', domain: target, qtype: '', action: 'block', pool: '', sinkhole: '0.0.0.0', ip: '', description: 'Добавлено из журнала' }, ...config.rules],
    });
  };

  const routeProcess = async (process: string) => {
    const pool = prompt(`Через какой пул направлять ${process}? (${config.pools.map((p) => p.id).join(', ')})`, config.pools[0]?.id);
    if (!pool) return;
    await onSave({
      ...config,
      rules: [...config.rules, { name: `${process} → ${pool}`, enabled: true, process, process_path: '', domain: '', qtype: '', action: 'route', pool, sinkhole: '', ip: '', description: 'Добавлено из журнала' }],
    });
  };

  const clear = async () => {
    await api.clearLogs().catch((e) => toast(e.message, 'error'));
    setEntries([]);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold mr-auto">Журнал запросов</h1>
        <input className="input w-64" placeholder="Поиск: домен, процесс, правило" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value as any)}>
          <option value="all">Все</option>
          {(Object.keys(STATUS_STYLE) as LogStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_STYLE[s].label}
            </option>
          ))}
        </select>
        <button className="btn-ghost" onClick={() => setPaused(!paused)}>
          {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          {paused ? 'Продолжить' : 'Пауза'}
        </button>
        <button className="btn-ghost" onClick={clear}>
          <Trash2 className="w-3.5 h-3.5" /> Очистить
        </button>
      </div>

      {topProcesses.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {topProcesses.map(([p, n]) => (
            <button key={p} onClick={() => setQ(p)} className="text-xs bg-slate-900 border border-slate-800 hover:border-indigo-600 rounded-full px-3 py-1">
              {p} <span className="text-slate-500">{n}</span>
            </button>
          ))}
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-slate-500 border-b border-slate-800">
            <tr>
              <th className="px-3 py-2 font-semibold">Время</th>
              <th className="px-3 py-2 font-semibold">Процесс</th>
              <th className="px-3 py-2 font-semibold">Домен</th>
              <th className="px-3 py-2 font-semibold">Тип</th>
              <th className="px-3 py-2 font-semibold">Итог</th>
              <th className="px-3 py-2 font-semibold">Правило</th>
              <th className="px-3 py-2 font-semibold">Сервер</th>
              <th className="px-3 py-2 font-semibold text-right">Время отв.</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-slate-500">
                  {entries.length === 0 ? 'Запросов пока нет. Направьте системный DNS на DanceDNS на вкладке «Обзор» или выполните проверку.' : 'Ничего не найдено'}
                </td>
              </tr>
            )}
            {filtered.slice(0, 500).map((e) => (
              <Fragment key={e.seq}>
                <tr onClick={() => setOpen(open === e.seq ? null : e.seq)} className="border-b border-slate-800/60 hover:bg-slate-800/40 cursor-pointer">
                  <td className="px-3 py-1.5 font-mono text-slate-500 whitespace-nowrap">{new Date(e.ts).toLocaleTimeString('ru')}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap" title={e.process_path}>
                    {e.process}
                    {e.pid ? <span className="text-slate-600"> · {e.pid}</span> : null}
                  </td>
                  <td className="px-3 py-1.5 font-mono max-w-xs truncate" title={e.domain}>
                    {e.domain}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-slate-400">{e.qtype}</td>
                  <td className="px-3 py-1.5">
                    <Badge cls={STATUS_STYLE[e.status].cls}>{STATUS_STYLE[e.status].label}</Badge>
                    {e.rcode && e.rcode !== 'No Error' && e.status !== 'error' && <span className="ml-1 text-slate-500">{e.rcode}</span>}
                  </td>
                  <td className="px-3 py-1.5 text-slate-300 max-w-[12rem] truncate">{e.rule}</td>
                  <td className="px-3 py-1.5 text-slate-400 font-mono">{e.upstream || (e.pool ? e.pool : '')}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-400">{fmtMs(e.latency_ms)}</td>
                </tr>
                {open === e.seq && (
                  <tr className="bg-slate-950/70 border-b border-slate-800">
                    <td colSpan={8} className="px-4 py-3 space-y-2">
                      {e.error && <div className="text-red-300 font-mono break-all">{e.error}</div>}
                      <div className="text-slate-400">
                        Клиент <span className="font-mono">{e.client}</span> ({e.transport}) · путь <span className="font-mono">{e.process_path || '—'}</span>
                        {e.pool && <> · пул <span className="font-mono">{e.pool}</span></>}
                        {e.dnssec && <> · DNSSEC ✓</>}
                      </div>
                      {e.answers.length > 0 ? (
                        <div className="font-mono space-y-0.5">
                          {e.answers.map((a, i) => (
                            <div key={i}>
                              <span className="text-slate-500">{a.name}</span> <span className="text-slate-600">{a.ttl}</span> <span className="text-indigo-300">{a.type}</span> {a.data}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-slate-500">Нет записей в ответе ({e.rcode || '—'})</div>
                      )}
                      <div className="flex gap-2 pt-1">
                        <button className="btn-ghost" onClick={() => blockDomain(e.domain)}>
                          <Ban className="w-3.5 h-3.5" /> Блокировать домен
                        </button>
                        {e.pid !== null && (
                          <button className="btn-ghost" onClick={() => routeProcess(e.process)}>
                            Правило для {e.process}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length > 500 && <div className="text-xs text-slate-500">Показаны последние 500 из {filtered.length}</div>}
    </div>
  );
}
