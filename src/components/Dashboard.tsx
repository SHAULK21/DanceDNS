import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Globe, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import type { Config, Status, SysDnsStatus } from '../types';
import { fmtMs, toast } from './ui';

function uptime(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} ч ${m} мин` : m ? `${m} мин` : `${s} с`;
}

export function Dashboard({ status, config, onNavigate }: { status: Status; config: Config; onNavigate: (t: any) => void }) {
  const [sys, setSys] = useState<SysDnsStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const loadSys = () => api.sysDns().then(setSys).catch((e) => toast(e.message, 'error'));
  useEffect(() => {
    loadSys();
  }, []);

  const toggleSys = async (enable: boolean) => {
    setBusy(true);
    try {
      setSys(await api.setSysDns(enable));
      toast(enable ? 'Системный DNS переключён на DanceDNS' : 'Системный DNS восстановлен', 'ok');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const c = status.counters;
  const tiles = [
    { label: 'Запросов', value: c.total, cls: 'text-slate-100' },
    { label: 'Через DoH', value: c.resolved, cls: 'text-indigo-300' },
    { label: 'Из кэша', value: c.cached, cls: 'text-sky-300' },
    { label: 'Заблокировано', value: c.blocked, cls: 'text-rose-300' },
    { label: 'Ошибок', value: c.errors, cls: c.errors ? 'text-red-400' : 'text-slate-500' },
  ];
  const listenErr = status.listeners.filter((l) => l.error);
  const active = sys?.active ?? status.system_dns_active;

  return (
    <div className="space-y-5">
      {status.admin === false && (
        <div className="card border-amber-800 bg-amber-950/30 p-4 flex gap-3 text-sm text-amber-200">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <div>DanceDNS запущен без прав администратора. Для порта 53 и смены системного DNS запустите его от имени администратора.</div>
        </div>
      )}
      {listenErr.length > 0 && (
        <div className="card border-rose-800 bg-rose-950/30 p-4 flex gap-3 text-sm text-rose-200">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <div>
            <div className="font-semibold mb-1">Не удалось открыть DNS-порт</div>
            {listenErr.map((l) => (
              <div key={l.addr} className="font-mono text-xs">
                {l.addr}: {l.error}
              </div>
            ))}
            <div className="text-xs mt-2 text-rose-300/80">
              Порт 53 может быть занят другой программой (например, другим DNS-клиентом, «Общим доступом к Интернету» или Docker). Закройте её
              или укажите другой адрес в настройках.
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {tiles.map((t) => (
          <div key={t.label} className="card p-4">
            <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">{t.label}</div>
            <div className={`text-2xl font-bold mt-1 tabular-nums ${t.cls}`}>{t.value.toLocaleString('ru')}</div>
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        <div className="card p-5 space-y-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className={`w-5 h-5 ${active ? 'text-emerald-400' : 'text-slate-500'}`} />
            <h2 className="font-bold">Системный DNS</h2>
            <button onClick={loadSys} className="ml-auto text-slate-500 hover:text-slate-200" title="Обновить">
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
          <p className="text-sm text-slate-400">
            {active
              ? 'Windows отправляет DNS-запросы в DanceDNS. Предыдущие настройки сохранены и вернутся при выключении или выходе из программы.'
              : 'Чтобы весь компьютер пользовался DanceDNS, переключите DNS сетевых подключений на 127.0.0.1. Старые настройки сохранятся.'}
          </p>
          {sys?.interfaces?.length ? (
            <div className="space-y-1">
              {sys.interfaces.map((i) => (
                <div key={i.alias} className="flex justify-between gap-3 text-xs bg-slate-950/60 rounded-md px-3 py-1.5">
                  <span className="text-slate-300 truncate">{i.alias}</span>
                  <span className="font-mono text-slate-400 truncate">{i.servers.join(', ') || 'авто (DHCP)'}</span>
                </div>
              ))}
            </div>
          ) : null}
          {sys?.note && <p className="text-xs text-slate-500">{sys.note}</p>}
          <div className="flex gap-2">
            {sys?.supported !== false &&
              (active ? (
                <button disabled={busy} onClick={() => toggleSys(false)} className="btn-ghost">
                  Вернуть прежний DNS
                </button>
              ) : (
                <button disabled={busy} onClick={() => toggleSys(true)} className="btn-primary">
                  Направить систему на DanceDNS
                </button>
              ))}
          </div>
        </div>

        <div className="card p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Globe className="w-5 h-5 text-indigo-400" />
            <h2 className="font-bold">Состояние</h2>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-slate-500">Работает</dt>
            <dd>{uptime(status.uptime_s)}</dd>
            <dt className="text-slate-500">DNS-адреса</dt>
            <dd className="space-y-0.5">
              {status.listeners.map((l) => (
                <div key={l.addr} className="flex items-center gap-1.5 font-mono text-xs">
                  {l.udp ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />}
                  {l.addr}
                  <span className="text-slate-500">{[l.udp && 'UDP', l.tcp && 'TCP'].filter(Boolean).join('+')}</span>
                </div>
              ))}
            </dd>
            <dt className="text-slate-500">Кэш</dt>
            <dd>{config.cache.enabled ? `${status.cache_entries} записей` : 'выключен'}</dd>
            <dt className="text-slate-500">Пул по умолчанию</dt>
            <dd className="font-mono text-xs pt-0.5">{config.default_pool}</dd>
            <dt className="text-slate-500">Правил</dt>
            <dd>
              {config.rules.filter((r) => r.enabled).length} активных из {config.rules.length}
            </dd>
            <dt className="text-slate-500">Процессы</dt>
            <dd>{status.process_attribution ? 'определяются' : 'недоступно в этой ОС'}</dd>
          </dl>
          {status.os === 'windows' && (
            <p className="text-xs text-slate-500 border-t border-slate-800 pt-3">
              Важно: большинство программ Windows отправляют DNS-запросы через системную службу «DNS-клиент». В журнале они будут
              видны как <span className="font-mono">svchost.exe</span>. Правила по именам процессов срабатывают для программ, которые
              обращаются к DNS сами, например браузеры со встроенным DNS-клиентом, игры, curl.
            </p>
          )}
        </div>
      </div>

      <div className="card p-5">
        <div className="flex items-center mb-3">
          <h2 className="font-bold">DoH-серверы</h2>
          <button onClick={() => onNavigate('servers')} className="ml-auto text-xs text-indigo-300 hover:text-indigo-200">
            Управление →
          </button>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {status.upstreams.map((u) => {
            const health = u.ok === 0 && u.fail === 0 ? 'idle' : u.healthy ? 'ok' : 'bad';
            return (
              <div key={u.id} className="flex items-center gap-3 bg-slate-950/60 rounded-lg px-3 py-2">
                <span className={`w-2 h-2 rounded-full ${health === 'ok' ? 'bg-emerald-400' : health === 'bad' ? 'bg-rose-400' : 'bg-slate-600'}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">{u.name}</div>
                  <div className="text-[11px] text-slate-500">
                    {u.ok} ок · {u.fail} ошибок
                  </div>
                </div>
                <div className="text-xs font-mono text-slate-300" title={u.last_error || ''}>{health === 'bad' ? 'ошибка' : fmtMs(u.latency_ms)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
