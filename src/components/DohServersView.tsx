import React, { useState } from 'react';
import { UpstreamServer } from '../types';
import { Server, Zap, Plus, Globe, Check, ShieldCheck, Activity, X } from 'lucide-react';

interface DohServersViewProps {
  servers: UpstreamServer[];
  onAddServer: (server: UpstreamServer) => void;
  onUpdateServers: (servers: UpstreamServer[]) => void;
}

export const DohServersView: React.FC<DohServersViewProps> = ({
  servers,
  onAddServer,
  onUpdateServers,
}) => {
  const [isPinging, setIsPinging] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  // Form states
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('');
  const [url, setUrl] = useState('');
  const [bootstrapIps, setBootstrapIps] = useState('');
  const [description, setDescription] = useState('');

  const handleBenchmarkAll = async () => {
    setIsPinging(true);
    try {
      const res = await fetch('/api/doh/ping-servers');
      const data = await res.json();
      if (data.servers) {
        const pingMap = new Map<string, number>();
        data.servers.forEach((s: any) => {
          pingMap.set(s.id, s.latencyMs);
        });

        const updated = servers.map((srv) => ({
          ...srv,
          latencyMs: pingMap.has(srv.id) ? pingMap.get(srv.id) : srv.latencyMs,
          online: true,
        }));
        onUpdateServers(updated);
      }
    } catch (e) {
      console.error('Benchmark failed', e);
    } finally {
      setIsPinging(false);
    }
  };

  const handleSaveCustom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !url.trim()) return;

    const ips = bootstrapIps
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const newServer: UpstreamServer = {
      id: `custom-${Date.now()}`,
      name: name.trim(),
      provider: provider.trim() || 'Custom Provider',
      url: url.trim(),
      bootstrapIps: ips.length > 0 ? ips : ['1.1.1.1'],
      features: ['Custom DoH', 'HTTP/2', 'RFC 8484'],
      description: description.trim() || 'User configured custom DNS-over-HTTPS endpoint.',
      latencyMs: 25,
      online: true,
    };

    onAddServer(newServer);
    setName('');
    setProvider('');
    setUrl('');
    setBootstrapIps('');
    setDescription('');
    setIsAdding(false);
  };

  return (
    <div className="space-y-6">
      {/* Top Banner with Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 bg-slate-900/60 rounded-xl border border-slate-800">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
            <Server className="w-5 h-5 text-indigo-400" />
            DNS-over-HTTPS (DoH) Upstream Servers
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Standard YogaDNS compatible resolvers connecting via encrypted RFC 8484 HTTP/2 pools with bootstrap IP discovery.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={handleBenchmarkAll}
            disabled={isPinging}
            className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 disabled:opacity-50 border border-slate-700 rounded-lg transition-colors whitespace-nowrap"
          >
            <Activity className={`w-4 h-4 text-emerald-400 ${isPinging ? 'animate-spin' : ''}`} />
            {isPinging ? 'Pinging Upstreams...' : 'Benchmark All Latencies'}
          </button>

          <button
            onClick={() => setIsAdding(!isAdding)}
            className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap"
          >
            {isAdding ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            {isAdding ? 'Cancel' : 'Add Custom Server'}
          </button>
        </div>
      </div>

      {/* Add Custom Server Modal / Form */}
      {isAdding && (
        <form
          onSubmit={handleSaveCustom}
          className="p-6 bg-slate-900 border border-indigo-500/30 rounded-xl space-y-4 shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h3 className="text-base font-semibold text-white">Add Custom DoH Upstream</h3>
            <span className="text-xs text-slate-400">Supports standard RFC 8484 endpoint</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Server Name
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. My NextDNS Profile / AdGuard Home"
                className="w-full px-3 py-2 text-sm bg-slate-950 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Provider / Organization
              </label>
              <input
                type="text"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                placeholder="e.g. Personal / Self-Hosted"
                className="w-full px-3 py-2 text-sm bg-slate-950 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                DoH Query URL (HTTPS)
              </label>
              <input
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://dns.nextdns.io/xxxxxx or https://my-resolver.domain/dns-query"
                className="w-full px-3 py-2 text-sm font-mono bg-slate-950 border border-slate-700 rounded-lg text-cyan-400 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Bootstrap IPs (comma-separated for initial TLS bootstrap)
              </label>
              <input
                type="text"
                value={bootstrapIps}
                onChange={(e) => setBootstrapIps(e.target.value)}
                placeholder="e.g. 45.90.28.0, 45.90.30.0"
                className="w-full px-3 py-2 text-sm font-mono bg-slate-950 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Description / Purpose
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Custom privacy blocklist for home network"
                className="w-full px-3 py-2 text-sm bg-slate-950 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={() => setIsAdding(false)}
              className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
            >
              <Check className="w-4 h-4" />
              Save Upstream
            </button>
          </div>
        </form>
      )}

      {/* Servers Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {servers.map((server) => {
          const latency = server.latencyMs ?? 20;
          let latencyColor = 'text-emerald-400';
          let barWidth = Math.min(100, Math.max(10, (latency / 60) * 100));

          if (latency > 40) latencyColor = 'text-amber-400';
          if (latency > 80) latencyColor = 'text-rose-400';

          return (
            <div
              key={server.id}
              className="p-5 bg-slate-900 border border-slate-800 rounded-xl hover:border-slate-700 transition-all flex flex-col justify-between"
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-base font-bold text-white">{server.name}</h3>
                    <div className="text-xs text-slate-400 mt-0.5">{server.provider}</div>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs font-mono font-semibold">
                    <span className={`tabular-nums ${latencyColor}`}>{latency} ms</span>
                  </div>
                </div>

                {/* Latency meter bar */}
                <div className="w-full h-1 bg-slate-800 rounded-full mt-3 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-500 ${
                      latency <= 40 ? 'bg-emerald-500' : latency <= 80 ? 'bg-amber-500' : 'bg-rose-500'
                    }`}
                    style={{ width: `${barWidth}%` }}
                  />
                </div>

                <p className="text-xs text-slate-400 mt-3 line-clamp-2 leading-relaxed">
                  {server.description}
                </p>

                {/* URL */}
                <div className="mt-3 p-2 bg-slate-950 rounded border border-slate-800/80 font-mono text-[11px] text-cyan-400 truncate">
                  {server.url}
                </div>
              </div>

              {/* Badges / Features list */}
              <div className="mt-4 pt-3 border-t border-slate-800/80 flex flex-wrap gap-1.5">
                {server.features.map((feat) => (
                  <span
                    key={feat}
                    className="text-[11px] font-medium text-slate-300 bg-slate-800/80 px-2 py-0.5 rounded"
                  >
                    {feat}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
