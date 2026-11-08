import { useState } from 'react';
import { Gauge, Pencil, Plus, Trash2, X } from 'lucide-react';
import { api } from '../api';
import type { Config, PoolConfig, PoolStrategy, ServerConfig, Status } from '../types';
import { Field, fmtMs, toast } from './ui';

const STRATEGY: Record<PoolStrategy, string> = {
  fastest: 'Самый быстрый',
  failover: 'По порядку (резерв)',
  round_robin: 'По очереди',
};

const PRESETS: ServerConfig[] = [
  { id: 'nextdns', name: 'NextDNS', url: 'https://dns.nextdns.io', bootstrap: ['45.90.28.0', '45.90.30.0'], timeout_ms: 3000 },
  { id: 'opendns', name: 'OpenDNS', url: 'https://doh.opendns.com/dns-query', bootstrap: ['208.67.222.222', '208.67.220.220'], timeout_ms: 3000 },
  { id: 'adguard-family', name: 'AdGuard Family', url: 'https://family.adguard-dns.com/dns-query', bootstrap: ['94.140.14.15', '94.140.15.16'], timeout_ms: 3000 },
  { id: 'cloudflare-family', name: 'Cloudflare Family', url: 'https://family.cloudflare-dns.com/dns-query', bootstrap: ['1.1.1.3', '1.0.0.3'], timeout_ms: 3000 },
  { id: 'yandex', name: 'Яндекс DNS', url: 'https://common.dot.dns.yandex.net/dns-query', bootstrap: ['77.88.8.8', '77.88.8.1'], timeout_ms: 3000 },
  { id: 'comss', name: 'Comss.one DNS', url: 'https://dns.comss.one/dns-query', bootstrap: ['83.220.169.155', '212.109.195.93'], timeout_ms: 3000 },
];

export function ServersView({ config, status, onSave }: { config: Config; status: Status; onSave: (c: Config) => Promise<boolean> }) {
  const [edit, setEdit] = useState<{ orig: string | null; s: ServerConfig; bootstrap: string } | null>(null);
  const [bench, setBench] = useState<Record<string, { ok: boolean; latency_ms: number | null; error: string | null }>>({});
  const [benching, setBenching] = useState(false);
  const [newPool, setNewPool] = useState('');

  const stats = Object.fromEntries(status.upstreams.map((u) => [u.id, u]));

  const runBench = async () => {
    setBenching(true);
    try {
      const r = await api.benchmark();
      setBench(Object.fromEntries(r.results.map((x) => [x.id, x])));
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBenching(false);
    }
  };

  const saveServer = async () => {
    if (!edit) return;
    const s: ServerConfig = {
      ...edit.s,
      id: edit.s.id.trim(),
      name: edit.s.name.trim(),
      bootstrap: edit.bootstrap.split(/[\s,]+/).filter(Boolean),
    };
    let servers = config.servers;
    let pools = config.pools;
    if (edit.orig === null) servers = [...servers, s];
    else {
      servers = servers.map((x) => (x.id === edit.orig ? s : x));
      if (edit.orig !== s.id) pools = pools.map((p) => ({ ...p, servers: p.servers.map((id) => (id === edit.orig ? s.id : id)) }));
    }
    if (await onSave({ ...config, servers, pools })) setEdit(null);
  };

  const removeServer = (id: string) => {
    const used = config.pools.filter((p) => p.servers.includes(id));
    if (used.some((p) => p.servers.length === 1)) {
      toast(`Сервер — единственный в пуле ${used.find((p) => p.servers.length === 1)!.id}. Сначала измените пул.`, 'error');
      return;
    }
    if (!confirm(`Удалить сервер ${id}?`)) return;
    onSave({
      ...config,
      servers: config.servers.filter((s) => s.id !== id),
      pools: config.pools.map((p) => ({ ...p, servers: p.servers.filter((x) => x !== id) })),
    });
  };

  const updatePool = (id: string, patch: Partial<PoolConfig>) =>
    onSave({ ...config, pools: config.pools.map((p) => (p.id === id ? { ...p, ...patch } : p)) });

  const movePoolServer = (p: PoolConfig, sid: string, d: number) => {
    const list = [...p.servers];
    const i = list.indexOf(sid);
    const j = i + d;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    updatePool(p.id, { servers: list });
  };

  const addPool = () => {
    const id = newPool.trim();
    if (!id || !config.servers[0]) return;
    onSave({ ...config, pools: [...config.pools, { id, servers: [config.servers[0].id], strategy: 'fastest' }] }).then((ok) => ok && setNewPool(''));
  };

  const removePool = (id: string) => {
    if (id === config.default_pool) return toast('Это пул по умолчанию — выберите другой в настройках', 'error');
    const users = config.rules.filter((r) => r.action === 'route' && r.pool === id);
    if (users.length) return toast(`Пул используется правилами: ${users.map((r) => r.name).join(', ')}`, 'error');
    if (confirm(`Удалить пул ${id}?`)) onSave({ ...config, pools: config.pools.filter((p) => p.id !== id) });
  };

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold mr-auto">DoH-серверы</h1>
          <button className="btn-ghost" onClick={runBench} disabled={benching}>
            <Gauge className="w-4 h-4" /> {benching ? 'Замер…' : 'Замерить скорость'}
          </button>
          <select
            className="input"
            value=""
            onChange={(e) => {
              const p = PRESETS.find((x) => x.id === e.target.value);
              if (p) setEdit({ orig: null, s: { ...p }, bootstrap: p.bootstrap.join(', ') });
            }}
          >
            <option value="">+ Из списка…</option>
            {PRESETS.filter((p) => !config.servers.some((s) => s.id === p.id)).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn-primary" onClick={() => setEdit({ orig: null, s: { id: '', name: '', url: 'https://', bootstrap: [], timeout_ms: 3000 }, bootstrap: '' })}>
            <Plus className="w-4 h-4" /> Свой сервер
          </button>
        </div>

        {edit && (
          <div className="card p-5 border-indigo-800 space-y-4">
            <div className="flex">
              <h2 className="font-bold">{edit.orig ? `Сервер ${edit.orig}` : 'Новый сервер'}</h2>
              <button className="ml-auto text-slate-500 hover:text-white" onClick={() => setEdit(null)}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              <Field label="ID" hint="Короткое имя латиницей, используется в пулах">
                <input className="input w-full font-mono" value={edit.s.id} onChange={(e) => setEdit({ ...edit, s: { ...edit.s, id: e.target.value } })} />
              </Field>
              <Field label="Название">
                <input className="input w-full" value={edit.s.name} onChange={(e) => setEdit({ ...edit, s: { ...edit.s, name: e.target.value } })} />
              </Field>
              <Field label="DoH URL" hint="Адрес в формате RFC 8484, например https://dns.example/dns-query">
                <input className="input w-full font-mono" value={edit.s.url} onChange={(e) => setEdit({ ...edit, s: { ...edit.s, url: e.target.value } })} />
              </Field>
              <Field label="Bootstrap IP" hint="IP-адреса сервера через запятую. Без них DanceDNS пришлось бы спрашивать системный DNS, то есть самого себя.">
                <input className="input w-full font-mono" value={edit.bootstrap} onChange={(e) => setEdit({ ...edit, bootstrap: e.target.value })} />
              </Field>
              <Field label="Таймаут, мс">
                <input type="number" className="input w-full" value={edit.s.timeout_ms} onChange={(e) => setEdit({ ...edit, s: { ...edit.s, timeout_ms: Number(e.target.value) } })} />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setEdit(null)}>
                Отмена
              </button>
              <button className="btn-primary" onClick={saveServer}>
                Сохранить
              </button>
            </div>
          </div>
        )}

        <div className="card divide-y divide-slate-800">
          {config.servers.map((s) => {
            const st = stats[s.id];
            const b = bench[s.id];
            return (
              <div key={s.id} className="p-4 flex flex-wrap items-center gap-4">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">
                    {s.name || s.id} <span className="text-xs font-mono text-slate-500">{s.id}</span>
                  </div>
                  <div className="text-xs font-mono text-slate-400 truncate">{s.url}</div>
                  <div className="text-[11px] font-mono text-slate-600">bootstrap: {s.bootstrap.join(', ') || '— (системный DNS)'}</div>
                  {(b?.error || (!b && st && !st.healthy && st.last_error)) && <div className="text-[11px] text-rose-400 mt-1 break-all">{b?.error || st?.last_error}</div>}
                </div>
                <div className="text-right text-xs">
                  <div className="font-mono text-sm">{b ? (b.ok ? fmtMs(b.latency_ms) : 'недоступен') : st && !st.healthy ? 'ошибка' : fmtMs(st?.latency_ms)}</div>
                  <div className="text-slate-500">{st ? `${st.ok} ок · ${st.fail} ошибок` : ''}</div>
                </div>
                <div className="flex gap-1">
                  <button className="btn-ghost !px-2" onClick={() => setEdit({ orig: s.id, s: { ...s }, bootstrap: s.bootstrap.join(', ') })}>
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button className="btn-ghost !px-2 hover:!bg-rose-700" onClick={() => removeServer(s.id)}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-auto">
            <h2 className="text-xl font-bold">Пулы</h2>
            <p className="text-sm text-slate-400">Пул — группа серверов. Правила направляют запросы в пул, а пул выбирает сервер.</p>
          </div>
          <input className="input w-40 font-mono" placeholder="id нового пула" value={newPool} onChange={(e) => setNewPool(e.target.value)} />
          <button className="btn-primary" onClick={addPool} disabled={!newPool.trim()}>
            <Plus className="w-4 h-4" /> Пул
          </button>
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          {config.pools.map((p) => (
            <div key={p.id} className="card p-4 space-y-3">
              <div className="flex items-center gap-2">
                <span className="font-mono font-semibold">{p.id}</span>
                {p.id === config.default_pool && <span className="text-[10px] text-emerald-300 border border-emerald-800 rounded px-1.5">по умолчанию</span>}
                <select className="input ml-auto !py-1 text-xs" value={p.strategy} onChange={(e) => updatePool(p.id, { strategy: e.target.value as PoolStrategy })}>
                  {(Object.keys(STRATEGY) as PoolStrategy[]).map((s) => (
                    <option key={s} value={s}>
                      {STRATEGY[s]}
                    </option>
                  ))}
                </select>
                <button className="text-slate-500 hover:text-rose-400" onClick={() => removePool(p.id)}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div className="space-y-1">
                {p.servers.map((sid, i) => (
                  <div key={sid} className="flex items-center gap-2 text-sm bg-slate-950/60 rounded px-2 py-1">
                    <span className="text-slate-600 text-xs w-4">{i + 1}</span>
                    <span className="flex-1">{config.servers.find((s) => s.id === sid)?.name || sid}</span>
                    <button className="text-slate-500 hover:text-white text-xs" onClick={() => movePoolServer(p, sid, -1)} disabled={i === 0}>
                      ↑
                    </button>
                    <button className="text-slate-500 hover:text-white text-xs" onClick={() => movePoolServer(p, sid, 1)} disabled={i === p.servers.length - 1}>
                      ↓
                    </button>
                    <button
                      className="text-slate-500 hover:text-rose-400"
                      disabled={p.servers.length === 1}
                      onClick={() => updatePool(p.id, { servers: p.servers.filter((x) => x !== sid) })}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <select
                className="input w-full text-xs"
                value=""
                onChange={(e) => e.target.value && updatePool(p.id, { servers: [...p.servers, e.target.value] })}
              >
                <option value="">+ добавить сервер в пул</option>
                {config.servers
                  .filter((s) => !p.servers.includes(s.id))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name || s.id}
                    </option>
                  ))}
              </select>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
