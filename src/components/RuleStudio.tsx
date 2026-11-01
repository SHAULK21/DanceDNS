import React, { useState } from 'react';
import { RoutingRule, RuleActionType } from '../types';
import { Plus, ArrowUp, ArrowDown, Trash2, Shield, Globe, Cpu, Check, Play, Edit3, X } from 'lucide-react';

interface RuleStudioProps {
  rules: RoutingRule[];
  onUpdateRules: (newRules: RoutingRule[]) => void;
  onTestRuleInInspector: (processName: string, domain: string) => void;
}

export const RuleStudio: React.FC<RuleStudioProps> = ({
  rules,
  onUpdateRules,
  onTestRuleInInspector,
}) => {
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form states
  const [name, setName] = useState('');
  const [processPattern, setProcessPattern] = useState('*');
  const [domainPattern, setDomainPattern] = useState('*');
  const [qtype, setQtype] = useState('ANY');
  const [action, setAction] = useState<RuleActionType>('route');
  const [pool, setPool] = useState('default');
  const [sinkholeIp, setSinkholeIp] = useState('0.0.0.0');
  const [localIp, setLocalIp] = useState('127.0.0.1');
  const [description, setDescription] = useState('');

  const resetForm = () => {
    setName('');
    setProcessPattern('*');
    setDomainPattern('*');
    setQtype('ANY');
    setAction('route');
    setPool('default');
    setSinkholeIp('0.0.0.0');
    setLocalIp('127.0.0.1');
    setDescription('');
    setIsAdding(false);
    setEditingId(null);
  };

  const handleStartEdit = (rule: RoutingRule) => {
    setEditingId(rule.id);
    setName(rule.name);
    setProcessPattern(rule.processPattern);
    setDomainPattern(rule.domainPattern);
    setQtype(rule.qtype);
    setAction(rule.action);
    setPool(rule.pool);
    setSinkholeIp(rule.sinkholeIp || '0.0.0.0');
    setLocalIp(rule.localIp || '127.0.0.1');
    setDescription(rule.description || '');
    setIsAdding(true);
  };

  const handleSaveRule = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    if (editingId) {
      // Edit existing
      const updated = rules.map((r) =>
        r.id === editingId
          ? {
              ...r,
              name: name.trim(),
              processPattern: processPattern.trim(),
              domainPattern: domainPattern.trim(),
              qtype,
              action,
              pool,
              sinkholeIp: action === 'block' ? sinkholeIp : undefined,
              localIp: action === 'local' ? localIp : undefined,
              description: description.trim(),
            }
          : r
      );
      onUpdateRules(updated);
    } else {
      // Add new at top or before default
      const newRule: RoutingRule = {
        id: `rule-${Date.now()}`,
        name: name.trim(),
        enabled: true,
        processPattern: processPattern.trim() || '*',
        domainPattern: domainPattern.trim() || '*',
        qtype,
        action,
        pool,
        sinkholeIp: action === 'block' ? sinkholeIp : undefined,
        localIp: action === 'local' ? localIp : undefined,
        description: description.trim(),
      };
      // Insert before the last rule if it is catch-all
      if (rules.length > 0 && rules[rules.length - 1].name.includes('Fallback')) {
        const next = [...rules.slice(0, rules.length - 1), newRule, rules[rules.length - 1]];
        onUpdateRules(next);
      } else {
        onUpdateRules([...rules, newRule]);
      }
    }
    resetForm();
  };

  const toggleEnabled = (id: string) => {
    onUpdateRules(
      rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))
    );
  };

  const moveRule = (index: number, direction: 'up' | 'down') => {
    const targetIdx = direction === 'up' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= rules.length) return;
    const next = [...rules];
    const temp = next[index];
    next[index] = next[targetIdx];
    next[targetIdx] = temp;
    onUpdateRules(next);
  };

  const deleteRule = (id: string) => {
    onUpdateRules(rules.filter((r) => r.id !== id));
  };

  return (
    <div className="space-y-6">
      {/* Top Banner with description and CTA */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 bg-slate-900/60 rounded-xl border border-slate-800">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
            <Cpu className="w-5 h-5 text-indigo-400" />
            Process & Traffic Routing Rules
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Rules are evaluated sequentially from top to bottom (first matching rule wins), matching client socket PID and domain masks.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => {
              resetForm();
              setIsAdding(!isAdding);
            }}
            className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap"
          >
            {isAdding ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            {isAdding ? 'Cancel' : 'Add Routing Rule'}
          </button>
        </div>
      </div>

      {/* Add / Edit Form Modal / Card */}
      {isAdding && (
        <form
          onSubmit={handleSaveRule}
          className="p-6 bg-slate-900 border border-indigo-500/30 rounded-xl space-y-5 shadow-xl transition-all"
        >
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h3 className="text-base font-semibold text-white">
              {editingId ? 'Edit Routing Rule' : 'Create New Process Routing Rule'}
            </h3>
            <span className="text-xs text-slate-400">
              Evaluated in Rust RuleEngine against <code className="text-indigo-300">glob::Pattern</code>
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Rule Name
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Chrome via Quad9 DNSSEC"
                className="w-full px-3 py-2 text-sm bg-slate-950 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Action Type
              </label>
              <select
                value={action}
                onChange={(e) => setAction(e.target.value as RuleActionType)}
                className="w-full px-3 py-2 text-sm bg-slate-950 border border-slate-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              >
                <option value="route">Route via DoH Upstream Pool</option>
                <option value="block">Block (Sinkhole 0.0.0.0 / NXDOMAIN)</option>
                <option value="local">Local Static IP Override</option>
                <option value="direct">Direct Bypass (System DNS)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Process Pattern (Wildcard or Name)
              </label>
              <input
                type="text"
                value={processPattern}
                onChange={(e) => setProcessPattern(e.target.value)}
                placeholder="e.g. *chrome.exe, telegram.exe, curl*"
                className="w-full px-3 py-2 text-sm font-mono bg-slate-950 border border-slate-700 rounded-lg text-emerald-400 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
              <div className="flex flex-wrap gap-1.5 mt-2">
                {['*chrome.exe', '*firefox.exe', '*telegram.exe', '*discord.exe', 'curl*', 'steam.exe', '*'].map(
                  (proc) => (
                    <button
                      key={proc}
                      type="button"
                      onClick={() => setProcessPattern(proc)}
                      className="px-2 py-0.5 text-xs font-mono bg-slate-800 text-slate-300 hover:text-white hover:bg-slate-700 rounded transition-colors"
                    >
                      {proc}
                    </button>
                  )
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Domain Pattern (Wildcard Mask)
              </label>
              <input
                type="text"
                value={domainPattern}
                onChange={(e) => setDomainPattern(e.target.value)}
                placeholder="e.g. *.doubleclick.net, *.ru, *"
                className="w-full px-3 py-2 text-sm font-mono bg-slate-950 border border-slate-700 rounded-lg text-cyan-400 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
              <div className="flex flex-wrap gap-1.5 mt-2">
                {['*', '*telemetry*', '*.doubleclick.net', '*.internal', '*.localdev', '*.ru'].map((dom) => (
                  <button
                    key={dom}
                    type="button"
                    onClick={() => setDomainPattern(dom)}
                    className="px-2 py-0.5 text-xs font-mono bg-slate-800 text-slate-300 hover:text-white hover:bg-slate-700 rounded transition-colors"
                  >
                    {dom}
                  </button>
                ))}
              </div>
            </div>

            {action === 'route' && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Target Upstream Pool
                </label>
                <select
                  value={pool}
                  onChange={(e) => setPool(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-slate-950 border border-slate-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
                >
                  <option value="default">Default Pool (Cloudflare 1.1.1.1 + Google 8.8.8.8)</option>
                  <option value="secure_privacy">Secure Privacy (Quad9 9.9.9.9 + Cloudflare Malware)</option>
                  <option value="adblock">AdBlock Pool (AdGuard DNS)</option>
                </select>
              </div>
            )}

            {action === 'block' && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Sinkhole IP (or leave 0.0.0.0)
                </label>
                <input
                  type="text"
                  value={sinkholeIp}
                  onChange={(e) => setSinkholeIp(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono bg-slate-950 border border-slate-700 rounded-lg text-rose-400 focus:outline-none focus:border-indigo-500"
                />
              </div>
            )}

            {action === 'local' && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Local Static IP
                </label>
                <input
                  type="text"
                  value={localIp}
                  onChange={(e) => setLocalIp(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono bg-slate-950 border border-slate-700 rounded-lg text-amber-400 focus:outline-none focus:border-indigo-500"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Query Record Type
              </label>
              <select
                value={qtype}
                onChange={(e) => setQtype(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-slate-950 border border-slate-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              >
                <option value="ANY">ANY (Match all DNS queries)</option>
                <option value="A">A (IPv4 Addresses)</option>
                <option value="AAAA">AAAA (IPv6 Addresses)</option>
                <option value="HTTPS">HTTPS / SVCB</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Description / Notes (Optional)
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Route Chrome through Swiss Quad9 with strict DNSSEC"
              className="w-full px-3 py-2 text-sm bg-slate-950 border border-slate-700 rounded-lg text-slate-300 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={resetForm}
              className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
            >
              <Check className="w-4 h-4" />
              {editingId ? 'Update Rule' : 'Save Rule'}
            </button>
          </div>
        </form>
      )}

      {/* Rules Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/50 text-xs font-medium text-slate-400">
                <th className="py-3 px-4 w-12 text-center">#</th>
                <th className="py-3 px-4">Rule Name</th>
                <th className="py-3 px-4">Process Name / Mask</th>
                <th className="py-3 px-4">Domain Mask</th>
                <th className="py-3 px-4">Action & Upstream</th>
                <th className="py-3 px-4 text-center">Active</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-sans">
              {rules.map((rule, idx) => {
                const isFirst = idx === 0;
                const isLast = idx === rules.length - 1;

                return (
                  <tr
                    key={rule.id}
                    className={`hover:bg-slate-800/40 transition-colors ${
                      !rule.enabled ? 'opacity-50' : ''
                    }`}
                  >
                    {/* Priority Order */}
                    <td className="py-3.5 px-4 text-center font-mono text-xs text-slate-500 tabular-nums">
                      {idx + 1}
                    </td>

                    {/* Rule Name */}
                    <td className="py-3.5 px-4">
                      <div className="font-medium text-slate-200">{rule.name}</div>
                      {rule.description && (
                        <div className="text-xs text-slate-400 truncate max-w-xs mt-0.5">
                          {rule.description}
                        </div>
                      )}
                    </td>

                    {/* Process */}
                    <td className="py-3.5 px-4 font-mono text-xs text-emerald-400">
                      <span className="bg-slate-950/70 border border-slate-800 px-2 py-1 rounded">
                        {rule.processPattern}
                      </span>
                    </td>

                    {/* Domain Pattern */}
                    <td className="py-3.5 px-4 font-mono text-xs text-cyan-400">
                      <span className="bg-slate-950/70 border border-slate-800 px-2 py-1 rounded">
                        {rule.domainPattern}
                      </span>
                    </td>

                    {/* Action & Upstream */}
                    <td className="py-3.5 px-4 text-xs">
                      {rule.action === 'route' && (
                        <div className="flex items-center gap-1.5 text-indigo-300">
                          <Globe className="w-3.5 h-3.5 text-indigo-400" />
                          <span>Pool: <strong>{rule.pool}</strong></span>
                        </div>
                      )}
                      {rule.action === 'block' && (
                        <div className="flex items-center gap-1.5 text-rose-400">
                          <Shield className="w-3.5 h-3.5 text-rose-400" />
                          <span>Block ({rule.sinkholeIp || '0.0.0.0'})</span>
                        </div>
                      )}
                      {rule.action === 'local' && (
                        <div className="text-amber-300">
                          Local: {rule.localIp || '127.0.0.1'}
                        </div>
                      )}
                      {rule.action === 'direct' && (
                        <div className="text-slate-400">
                          Direct System DNS
                        </div>
                      )}
                    </td>

                    {/* Enabled Toggle */}
                    <td className="py-3.5 px-4 text-center">
                      <button
                        onClick={() => toggleEnabled(rule.id)}
                        className={`w-9 h-5 rounded-full transition-colors relative inline-block p-0.5 ${
                          rule.enabled ? 'bg-indigo-600' : 'bg-slate-700'
                        }`}
                        title={rule.enabled ? 'Rule is active' : 'Rule is disabled'}
                      >
                        <span
                          className={`block w-4 h-4 rounded-full bg-white transition-transform ${
                            rule.enabled ? 'translate-x-4' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </td>

                    {/* Actions: Move Up, Move Down, Edit, Delete, Test */}
                    <td className="py-3.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() =>
                            onTestRuleInInspector(
                              rule.processPattern.replace('*', '') || 'chrome.exe',
                              rule.domainPattern.replace('*', '') || 'github.com'
                            )
                          }
                          title="Simulate this rule in DNS Inspector"
                          className="p-1.5 text-slate-400 hover:text-indigo-300 hover:bg-slate-800 rounded transition-colors"
                        >
                          <Play className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => moveRule(idx, 'up')}
                          disabled={isFirst}
                          title="Move priority up"
                          className="p-1.5 text-slate-400 hover:text-white disabled:opacity-30 disabled:hover:text-slate-400 hover:bg-slate-800 rounded transition-colors"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => moveRule(idx, 'down')}
                          disabled={isLast}
                          title="Move priority down"
                          className="p-1.5 text-slate-400 hover:text-white disabled:opacity-30 disabled:hover:text-slate-400 hover:bg-slate-800 rounded transition-colors"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleStartEdit(rule)}
                          title="Edit rule"
                          className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => deleteRule(rule.id)}
                          title="Delete rule"
                          className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
