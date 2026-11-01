import React, { useState } from 'react';
import { RoutingRule, QueryLogEntry, DnsAnswerRecord, TraceStep } from '../types';
import { Play, CheckCircle2, AlertOctagon, Zap, Shield, Search, Terminal, ArrowRight, RefreshCw } from 'lucide-react';

interface LiveDnsInspectorProps {
  rules: RoutingRule[];
  queryLogs: QueryLogEntry[];
  onAddLog: (entry: QueryLogEntry) => void;
  presetProcess?: string;
  presetDomain?: string;
}

export const LiveDnsInspector: React.FC<LiveDnsInspectorProps> = ({
  rules,
  queryLogs,
  onAddLog,
  presetProcess = 'chrome.exe',
  presetDomain = 'github.com',
}) => {
  const [processName, setProcessName] = useState(presetProcess);
  const [domain, setDomain] = useState(presetDomain);
  const [qtype, setQtype] = useState('A');
  const [isLoading, setIsLoading] = useState(false);
  const [currentTrace, setCurrentTrace] = useState<TraceStep[] | null>(null);
  const [latestAnswer, setLatestAnswer] = useState<{
    answers: DnsAnswerRecord[];
    latencyMs: number;
    dnssec: boolean;
    server: string;
    action: string;
  } | null>(null);

  // Search & filter for audit logs
  const [searchFilter, setSearchFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Match rule logic (mirroring Rust RuleEngine)
  const evaluateRule = (proc: string, dom: string, type: string) => {
    const cleanDom = dom.trim().toLowerCase();
    const cleanProc = proc.trim().toLowerCase();

    for (const rule of rules) {
      if (!rule.enabled) continue;

      // 1. Process matching
      let procMatches = false;
      if (rule.processPattern === '*' || !rule.processPattern) {
        procMatches = true;
      } else {
        const patterns = rule.processPattern.split(',').map((p) => p.trim().toLowerCase());
        procMatches = patterns.some((p) => {
          if (p === cleanProc) return true;
          if (p.startsWith('*') && cleanProc.endsWith(p.slice(1))) return true;
          if (p.endsWith('*') && cleanProc.startsWith(p.slice(0, -1))) return true;
          return cleanProc.includes(p.replace(/\*/g, ''));
        });
      }
      if (!procMatches) continue;

      // 2. Domain matching
      let domMatches = false;
      if (rule.domainPattern === '*' || !rule.domainPattern) {
        domMatches = true;
      } else {
        const patterns = rule.domainPattern.split(',').map((p) => p.trim().toLowerCase());
        domMatches = patterns.some((p) => {
          if (p === cleanDom) return true;
          if (p.startsWith('*.')) {
            const suffix = p.slice(2);
            return cleanDom === suffix || cleanDom.endsWith(`.${suffix}`);
          }
          if (p.startsWith('*') && cleanDom.endsWith(p.slice(1))) return true;
          if (p.endsWith('*') && cleanDom.startsWith(p.slice(0, -1))) return true;
          return cleanDom.includes(p.replace(/\*/g, ''));
        });
      }
      if (!domMatches) continue;

      // 3. Qtype matching
      if (rule.qtype && rule.qtype !== 'ANY' && rule.qtype !== type) {
        continue;
      }

      return rule;
    }

    // Default catch-all
    return {
      id: 'fallback',
      name: 'Default Fallback (Cloudflare)',
      enabled: true,
      processPattern: '*',
      domainPattern: '*',
      qtype: 'ANY',
      action: 'route',
      pool: 'default',
    } as RoutingRule;
  };

  const handleRunQuery = async () => {
    if (!domain.trim()) return;
    setIsLoading(true);
    setCurrentTrace(null);
    setLatestAnswer(null);

    const cleanDomain = domain.trim().toLowerCase();
    const cleanProc = processName.trim() || 'unknown.exe';
    const fakePid = Math.floor(Math.random() * 20000) + 1000;
    const fakePort = Math.floor(Math.random() * 30000) + 30000;

    const matchedRule = evaluateRule(cleanProc, cleanDomain, qtype);

    const traceSteps: TraceStep[] = [
      {
        step: 1,
        title: 'Socket & Process Identification',
        description: `Source socket 127.0.0.1:${fakePort} mapped via OS socket attribution`,
        status: 'info',
        detail: `OS: Linux/Windows | PID: ${fakePid} | Executable: "${cleanProc}"`,
      },
      {
        step: 2,
        title: 'Rule Engine Evaluation',
        description: `Matched rule: "${matchedRule.name}"`,
        status: matchedRule.action === 'block' ? 'warning' : 'success',
        detail: `Process Pattern: "${matchedRule.processPattern}" | Domain Mask: "${matchedRule.domainPattern}" | Action: ${matchedRule.action.toUpperCase()}`,
      },
    ];

    try {
      if (matchedRule.action === 'block') {
        const sinkhole = matchedRule.sinkholeIp || '0.0.0.0';
        traceSteps.push({
          step: 3,
          title: 'Sinkhole Block Response',
          description: `Domain resolved to sinkhole address ${sinkhole}`,
          status: 'blocked',
          detail: `Synthesized RFC DNS A record: ${cleanDomain} -> ${sinkhole} (TTL 300s)`,
        });

        setCurrentTrace(traceSteps);
        const ans: DnsAnswerRecord[] = [
          { name: `${cleanDomain}.`, type: 1, TTL: 300, data: sinkhole },
        ];
        setLatestAnswer({
          answers: ans,
          latencyMs: 0.5,
          dnssec: false,
          server: 'Sinkhole 0.0.0.0',
          action: 'Block',
        });

        onAddLog({
          id: `log-${Date.now()}`,
          timestamp: new Date().toLocaleTimeString(),
          processName: cleanProc,
          pid: fakePid,
          domain: cleanDomain,
          qtype,
          matchedRule: matchedRule.name,
          action: 'block',
          pool: matchedRule.pool,
          upstreamServer: `Sinkhole (${sinkhole})`,
          latencyMs: 0.5,
          status: 'blocked',
          answers: ans,
          dnssec: false,
        });
      } else if (matchedRule.action === 'local') {
        const local = matchedRule.localIp || '127.0.0.1';
        traceSteps.push({
          step: 3,
          title: 'Local Static IP Override',
          description: `Internal developer override routed to ${local}`,
          status: 'success',
          detail: `Synthesized local record: ${cleanDomain} -> ${local}`,
        });

        setCurrentTrace(traceSteps);
        const ans: DnsAnswerRecord[] = [
          { name: `${cleanDomain}.`, type: 1, TTL: 300, data: local },
        ];
        setLatestAnswer({
          answers: ans,
          latencyMs: 0.6,
          dnssec: false,
          server: `Local Override (${local})`,
          action: 'Local',
        });

        onAddLog({
          id: `log-${Date.now()}`,
          timestamp: new Date().toLocaleTimeString(),
          processName: cleanProc,
          pid: fakePid,
          domain: cleanDomain,
          qtype,
          matchedRule: matchedRule.name,
          action: 'local',
          pool: matchedRule.pool,
          upstreamServer: `Local (${local})`,
          latencyMs: 0.6,
          status: 'resolved',
          answers: ans,
          dnssec: false,
        });
      } else {
        // Real DoH query to upstream
        let serverId = 'cloudflare';
        if (matchedRule.pool === 'secure_privacy') {
          serverId = 'quad9';
        } else if (matchedRule.pool === 'adblock') {
          serverId = 'adguard';
        }

        traceSteps.push({
          step: 3,
          title: 'DoH Upstream Dispatch',
          description: `Forwarding RFC 8484 wire message to pool "${matchedRule.pool}"`,
          status: 'info',
          detail: `Target resolver: ${serverId.toUpperCase()} DoH | HTTP/2 Multiplexed`,
        });

        const res = await fetch('/api/doh/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            serverId,
            domain: cleanDomain,
            recordType: qtype,
          }),
        });

        const data = await res.json();

        traceSteps.push({
          step: 4,
          title: 'DoH Resolution Success',
          description: `Received ${data.answers?.length || 0} answer records in ${data.latencyMs}ms`,
          status: 'success',
          detail: `Upstream: ${data.targetUrl} | Protocol: ${data.protocol || 'HTTP/2'} | DNSSEC: ${data.dnssec ? 'Validated' : 'Unchecked'}`,
        });

        setCurrentTrace(traceSteps);
        setLatestAnswer({
          answers: data.answers || [],
          latencyMs: data.latencyMs,
          dnssec: data.dnssec,
          server: data.targetUrl,
          action: 'Route',
        });

        onAddLog({
          id: `log-${Date.now()}`,
          timestamp: new Date().toLocaleTimeString(),
          processName: cleanProc,
          pid: fakePid,
          domain: cleanDomain,
          qtype,
          matchedRule: matchedRule.name,
          action: 'route',
          pool: matchedRule.pool,
          upstreamServer: data.targetUrl.replace('https://', '').split('/')[0],
          latencyMs: data.latencyMs,
          status: 'resolved',
          answers: data.answers || [],
          dnssec: data.dnssec,
        });
      }
    } catch (err: any) {
      traceSteps.push({
        step: 4,
        title: 'Resolution Error',
        description: err.message || 'Failed to query upstream',
        status: 'blocked',
        detail: 'Check internet connectivity or DNS endpoint response.',
      });
      setCurrentTrace(traceSteps);
    } finally {
      setIsLoading(false);
    }
  };

  // Filtered logs
  const filteredLogs = queryLogs.filter((log) => {
    const matchesSearch =
      log.domain.toLowerCase().includes(searchFilter.toLowerCase()) ||
      log.processName.toLowerCase().includes(searchFilter.toLowerCase()) ||
      log.matchedRule.toLowerCase().includes(searchFilter.toLowerCase());

    if (statusFilter === 'all') return matchesSearch;
    return matchesSearch && log.status === statusFilter;
  });

  // KPI computations
  const totalQueries = queryLogs.length;
  const blockedCount = queryLogs.filter((l) => l.status === 'blocked').length;
  const avgLatency =
    totalQueries > 0
      ? (
          queryLogs.reduce((acc, curr) => acc + curr.latencyMs, 0) / totalQueries
        ).toFixed(1)
      : '0.0';

  return (
    <div className="space-y-6">
      {/* Metrics Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl">
          <div className="text-xs text-slate-400 font-medium">Total Intercepted Queries</div>
          <div className="text-2xl font-bold font-mono text-white mt-1 tabular-nums">
            {totalQueries}
          </div>
          <div className="text-xs text-slate-500 mt-1">From active sockets</div>
        </div>

        <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl">
          <div className="text-xs text-slate-400 font-medium">Average DoH Latency</div>
          <div className="text-2xl font-bold font-mono text-emerald-400 mt-1 tabular-nums">
            {avgLatency} <span className="text-sm font-normal text-slate-400">ms</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">HTTP/2 pooled connections</div>
        </div>

        <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl">
          <div className="text-xs text-slate-400 font-medium">Blocked & Sinkholed</div>
          <div className="text-2xl font-bold font-mono text-rose-400 mt-1 tabular-nums">
            {blockedCount}
          </div>
          <div className="text-xs text-slate-500 mt-1">Telemetry & ad services</div>
        </div>

        <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl">
          <div className="text-xs text-slate-400 font-medium">Active Rule Count</div>
          <div className="text-2xl font-bold font-mono text-indigo-400 mt-1 tabular-nums">
            {rules.filter((r) => r.enabled).length} <span className="text-sm font-normal text-slate-400">/ {rules.length}</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">Evaluating per query</div>
        </div>
      </div>

      {/* Interactive Query Simulator Box */}
      <div className="p-6 bg-slate-900 border border-slate-800 rounded-xl shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Terminal className="w-5 h-5 text-indigo-400" />
              Live DNS Query & Pipeline Simulator
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Simulate an incoming DNS request from any application, observe real-time rule matching, and execute a live DoH upstream query.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
          {/* Process input */}
          <div className="md:col-span-4">
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Originating Process Name
            </label>
            <input
              type="text"
              value={processName}
              onChange={(e) => setProcessName(e.target.value)}
              placeholder="e.g. chrome.exe, telegram.exe, curl"
              className="w-full px-3 py-2 text-sm font-mono bg-slate-950 border border-slate-700 rounded-lg text-emerald-400 focus:outline-none focus:border-indigo-500"
            />
            <div className="flex flex-wrap gap-1 mt-2">
              {['chrome.exe', 'telegram.exe', 'curl', 'spotify.exe', 'discord.exe'].map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProcessName(p)}
                  className="px-2 py-0.5 text-xs font-mono bg-slate-800 text-slate-400 hover:text-white rounded transition-colors"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Domain input */}
          <div className="md:col-span-5">
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Domain to Resolve
            </label>
            <input
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="e.g. github.com, adservice.google.com"
              className="w-full px-3 py-2 text-sm font-mono bg-slate-950 border border-slate-700 rounded-lg text-cyan-400 focus:outline-none focus:border-indigo-500"
            />
            <div className="flex flex-wrap gap-1 mt-2">
              {['github.com', 'cloudflare.com', 'adservice.google.com', 'reddit.com', 'api.telegram.org'].map(
                (d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDomain(d)}
                    className="px-2 py-0.5 text-xs font-mono bg-slate-800 text-slate-400 hover:text-white rounded transition-colors"
                  >
                    {d}
                  </button>
                )
              )}
            </div>
          </div>

          {/* QType */}
          <div className="md:col-span-1">
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Type
            </label>
            <select
              value={qtype}
              onChange={(e) => setQtype(e.target.value)}
              className="w-full px-2 py-2 text-sm bg-slate-950 border border-slate-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
            >
              <option value="A">A</option>
              <option value="AAAA">AAAA</option>
              <option value="TXT">TXT</option>
              <option value="CNAME">CNAME</option>
            </select>
          </div>

          {/* Action button */}
          <div className="md:col-span-2">
            <button
              onClick={handleRunQuery}
              disabled={isLoading || !domain.trim()}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap h-[38px]"
            >
              {isLoading ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              {isLoading ? 'Resolving...' : 'Resolve & Trace'}
            </button>
          </div>
        </div>

        {/* Trace Visualizer */}
        {currentTrace && (
          <div className="mt-6 pt-5 border-t border-slate-800">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              Execution Trace Pipeline (YogaDNS Architecture)
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              {currentTrace.map((step) => {
                let badgeColor = 'border-slate-700 bg-slate-950 text-slate-300';
                if (step.status === 'success') {
                  badgeColor = 'border-emerald-500/30 bg-emerald-950/20 text-emerald-300';
                } else if (step.status === 'warning') {
                  badgeColor = 'border-amber-500/30 bg-amber-950/20 text-amber-300';
                } else if (step.status === 'blocked') {
                  badgeColor = 'border-rose-500/30 bg-rose-950/20 text-rose-300';
                }

                return (
                  <div
                    key={step.step}
                    className={`p-3.5 rounded-lg border ${badgeColor} transition-all`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-mono font-semibold">
                        Step {step.step}
                      </span>
                      {step.status === 'success' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                      {step.status === 'blocked' && <AlertOctagon className="w-3.5 h-3.5 text-rose-400" />}
                      {step.status === 'warning' && <Shield className="w-3.5 h-3.5 text-amber-400" />}
                    </div>
                    <div className="text-xs font-semibold text-white">{step.title}</div>
                    <div className="text-xs text-slate-400 mt-1">{step.description}</div>
                    <div className="text-[11px] font-mono text-slate-400/80 mt-2 pt-2 border-t border-slate-800/80 truncate">
                      {step.detail}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Answer Box */}
            {latestAnswer && (
              <div className="mt-4 p-4 bg-slate-950 rounded-lg border border-slate-800">
                <div className="flex items-center justify-between text-xs pb-2 border-b border-slate-800/80">
                  <span className="font-semibold text-slate-300 flex items-center gap-2">
                    <span>DNS Answer Records</span>
                    <span className="text-slate-500 font-normal">·</span>
                    <span className="text-slate-400 font-mono">
                      Latency: <strong className="text-emerald-400">{latestAnswer.latencyMs} ms</strong>
                    </span>
                    {latestAnswer.dnssec && (
                      <>
                        <span className="text-slate-500 font-normal">·</span>
                        <span className="text-cyan-400 font-mono text-[11px]">DNSSEC Validated</span>
                      </>
                    )}
                  </span>
                  <span className="text-[11px] font-mono text-slate-500 truncate max-w-xs">
                    {latestAnswer.server}
                  </span>
                </div>

                <div className="mt-2.5 space-y-1.5 font-mono text-xs">
                  {latestAnswer.answers.length > 0 ? (
                    latestAnswer.answers.map((rec, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between p-2 rounded bg-slate-900 border border-slate-800/60"
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-slate-400">{rec.name}</span>
                          <span className="text-indigo-400 font-semibold">{qtype}</span>
                          <span className="text-emerald-300 font-bold">{rec.data}</span>
                        </div>
                        <div className="text-slate-500 text-[11px]">TTL: {rec.TTL}s</div>
                      </div>
                    ))
                  ) : (
                    <div className="text-slate-400 text-xs py-1">
                      No answer records returned or domain not found (NXDOMAIN).
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Query Log Stream / Audit Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
        <div className="p-4 border-b border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Terminal className="w-4 h-4 text-emerald-400" />
              Real-Time Query Log & Inspection Audit
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Live stream of intercepted queries with process name, matching rule, upstream DoH, and latency.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {/* Search */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                placeholder="Filter domain, process..."
                className="pl-8 pr-3 py-1.5 text-xs bg-slate-950 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 w-44"
              />
            </div>

            {/* Status Tabs */}
            <div className="flex items-center gap-1 p-1 bg-slate-950 rounded-lg border border-slate-800">
              {['all', 'resolved', 'blocked', 'cached'].map((st) => (
                <button
                  key={st}
                  onClick={() => setStatusFilter(st)}
                  className={`px-2.5 py-1 text-xs font-medium rounded capitalize transition-colors ${
                    statusFilter === st
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/50 text-xs font-medium text-slate-400">
                <th className="py-2.5 px-4">Time</th>
                <th className="py-2.5 px-4">Process (PID)</th>
                <th className="py-2.5 px-4">Domain (QType)</th>
                <th className="py-2.5 px-4">Matched Rule</th>
                <th className="py-2.5 px-4">Upstream / Target</th>
                <th className="py-2.5 px-4 text-right">Latency</th>
                <th className="py-2.5 px-4 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-sans text-xs">
              {filteredLogs.map((log) => (
                <tr key={log.id} className="hover:bg-slate-800/30 transition-colors">
                  <td className="py-3 px-4 font-mono text-slate-400 tabular-nums">
                    {log.timestamp}
                  </td>

                  <td className="py-3 px-4 font-mono">
                    <span className="text-emerald-400 font-semibold">{log.processName}</span>
                    <span className="text-slate-500 ml-1.5">[{log.pid}]</span>
                  </td>

                  <td className="py-3 px-4 font-mono">
                    <div className="text-slate-200">{log.domain}</div>
                    <div className="text-[11px] text-slate-500">
                      {log.qtype} {log.answers[0]?.data && `-> ${log.answers[0].data}`}
                    </div>
                  </td>

                  <td className="py-3 px-4 text-slate-300">
                    <span className="truncate block max-w-xs">{log.matchedRule}</span>
                  </td>

                  <td className="py-3 px-4 font-mono text-slate-400">
                    {log.upstreamServer}
                  </td>

                  <td className="py-3 px-4 text-right font-mono text-slate-300 tabular-nums">
                    {log.latencyMs} ms
                  </td>

                  <td className="py-3 px-4 text-center">
                    {log.status === 'resolved' && (
                      <span className="text-emerald-400 font-mono font-medium">RESOLVED</span>
                    )}
                    {log.status === 'blocked' && (
                      <span className="text-rose-400 font-mono font-medium">BLOCKED</span>
                    )}
                    {log.status === 'cached' && (
                      <span className="text-cyan-400 font-mono font-medium">CACHED</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
