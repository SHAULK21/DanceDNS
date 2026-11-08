import { useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Pencil, Play, Plus, Trash2, X } from 'lucide-react';
import type { ActionKind, Config, RuleConfig } from '../types';
import { ACTION_LABEL, Field, Toggle } from './ui';

const EMPTY: RuleConfig = {
  name: '',
  enabled: true,
  process: '',
  process_path: '',
  domain: '',
  qtype: '',
  action: 'route',
  pool: '',
  sinkhole: '0.0.0.0',
  ip: '127.0.0.1',
  description: '',
};

const ACTION_CLS: Record<ActionKind, string> = {
  route: 'text-indigo-300 bg-indigo-950 border-indigo-800',
  block: 'text-rose-300 bg-rose-950 border-rose-800',
  direct: 'text-amber-300 bg-amber-950 border-amber-800',
  local: 'text-violet-300 bg-violet-950 border-violet-800',
};

export function RulesView({
  config,
  onSave,
  onTest,
}: {
  config: Config;
  onSave: (c: Config) => Promise<boolean>;
  onTest: (process: string, domain: string) => void;
}) {
  const [editing, setEditing] = useState<{ index: number | null; rule: RuleConfig } | null>(null);
  const rules = config.rules;

  const save = (next: RuleConfig[]) => onSave({ ...config, rules: next });

  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= rules.length) return;
    const next = [...rules];
    [next[i], next[j]] = [next[j], next[i]];
    save(next);
  };

  const submit = async () => {
    if (!editing) return;
    const r = { ...editing.rule, name: editing.rule.name.trim() || 'Без названия' };
    if (r.action !== 'route') r.pool = '';
    if (r.action !== 'block') r.sinkhole = '';
    if (r.action !== 'local') r.ip = '';
    const next = [...rules];
    if (editing.index === null) next.push(r);
    else next[editing.index] = r;
    if (await save(next)) setEditing(null);
  };

  const set = (patch: Partial<RuleConfig>) => editing && setEditing({ ...editing, rule: { ...editing.rule, ...patch } });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-bold">Правила</h1>
          <p className="text-sm text-slate-400">
            Правила проверяются сверху вниз, срабатывает первое подходящее. Если ни одно не подошло, запрос идёт через пул{' '}
            <span className="font-mono text-slate-200">{config.default_pool}</span>.
          </p>
        </div>
        <button
          className="btn-primary ml-auto"
          onClick={() => setEditing({ index: null, rule: { ...EMPTY, pool: config.default_pool } })}
        >
          <Plus className="w-4 h-4" /> Новое правило
        </button>
      </div>

      {editing && (
        <div className="card p-5 border-indigo-800 space-y-4">
          <div className="flex items-center">
            <h2 className="font-bold">{editing.index === null ? 'Новое правило' : 'Изменить правило'}</h2>
            <button className="ml-auto text-slate-500 hover:text-white" onClick={() => setEditing(null)}>
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <Field label="Название">
              <input className="input w-full" value={editing.rule.name} onChange={(e) => set({ name: e.target.value })} autoFocus />
            </Field>
            <Field label="Описание">
              <input className="input w-full" value={editing.rule.description} onChange={(e) => set({ description: e.target.value })} />
            </Field>
            <Field label="Процесс (имя exe)" hint="Через запятую, можно * и ?: chrome.exe, *fox*. Пусто = любой процесс.">
              <input className="input w-full font-mono" value={editing.rule.process} onChange={(e) => set({ process: e.target.value })} placeholder="chrome.exe, firefox.exe" />
            </Field>
            <Field label="Путь к программе" hint="Например C:\Games\* . Пусто = любой путь.">
              <input className="input w-full font-mono" value={editing.rule.process_path} onChange={(e) => set({ process_path: e.target.value })} placeholder="C:\Program Files\*" />
            </Field>
            <Field label="Домены" hint="example.com — сам домен и все поддомены; *ads* — по шаблону. Через запятую. Пусто = любой домен.">
              <input className="input w-full font-mono" value={editing.rule.domain} onChange={(e) => set({ domain: e.target.value })} placeholder="doubleclick.net, *telemetry*" />
            </Field>
            <Field label="Типы запросов" hint="A, AAAA, HTTPS… Пусто = любой.">
              <input className="input w-full font-mono" value={editing.rule.qtype} onChange={(e) => set({ qtype: e.target.value })} placeholder="ANY" />
            </Field>
            <Field label="Действие">
              <select className="input w-full" value={editing.rule.action} onChange={(e) => set({ action: e.target.value as ActionKind })}>
                {(Object.keys(ACTION_LABEL) as ActionKind[]).map((a) => (
                  <option key={a} value={a}>
                    {ACTION_LABEL[a]}
                  </option>
                ))}
              </select>
            </Field>
            {editing.rule.action === 'route' && (
              <Field label="Пул DoH">
                <select className="input w-full" value={editing.rule.pool} onChange={(e) => set({ pool: e.target.value })}>
                  {config.pools.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id} ({p.servers.join(', ')})
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {editing.rule.action === 'block' && (
              <Field label="Ответ при блокировке" hint="Пусто = NXDOMAIN (домен не существует). Или адрес-заглушка, например 0.0.0.0.">
                <input className="input w-full font-mono" value={editing.rule.sinkhole} onChange={(e) => set({ sinkhole: e.target.value })} />
              </Field>
            )}
            {editing.rule.action === 'local' && (
              <Field label="IP-адрес ответа" hint="IPv4 отвечает на A-запросы, IPv6 — на AAAA.">
                <input className="input w-full font-mono" value={editing.rule.ip} onChange={(e) => set({ ip: e.target.value })} />
              </Field>
            )}
            {editing.rule.action === 'direct' && (
              <div className="text-xs text-slate-400 self-end pb-2">
                Запрос уйдёт обычным незашифрованным DNS на <span className="font-mono">{config.direct_dns}</span> (меняется в настройках).
              </div>
            )}
          </div>
          <div className="flex gap-2 justify-end">
            <button className="btn-ghost" onClick={() => setEditing(null)}>
              Отмена
            </button>
            <button className="btn-primary" onClick={submit}>
              Сохранить
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {rules.length === 0 && <div className="card p-6 text-center text-slate-500 text-sm">Правил нет: все запросы идут через пул по умолчанию.</div>}
        {rules.map((r, i) => (
          <div key={i} className={`card p-4 flex flex-wrap items-center gap-4 ${r.enabled ? '' : 'opacity-50'}`}>
            <span className="text-xs font-mono text-slate-600 w-5 text-right">{i + 1}</span>
            <Toggle checked={r.enabled} onChange={(v) => save(rules.map((x, j) => (j === i ? { ...x, enabled: v } : x)))} title="Включить/выключить" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{r.name}</span>
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${ACTION_CLS[r.action]}`}>
                  {r.action === 'route' ? `→ ${r.pool}` : r.action === 'block' ? `блок${r.sinkhole ? ' → ' + r.sinkhole : ' (NXDOMAIN)'}` : r.action === 'local' ? `→ ${r.ip}` : 'напрямую'}
                </span>
              </div>
              <div className="text-xs text-slate-400 mt-1 flex flex-wrap gap-x-4 gap-y-0.5 font-mono">
                <span>процесс: {r.process || '*'}</span>
                {r.process_path && <span>путь: {r.process_path}</span>}
                <span>домен: {r.domain || '*'}</span>
                {r.qtype && <span>тип: {r.qtype}</span>}
              </div>
              {r.description && <div className="text-xs text-slate-500 mt-1">{r.description}</div>}
            </div>
            <div className="flex gap-1">
              <button className="btn-ghost !px-2" title="Проверить" onClick={() => onTest(r.process.split(',')[0]?.trim().replace(/\*/g, '') || '', r.domain.split(',')[0]?.trim().replace(/\*\.?/g, '') || 'example.com')}>
                <Play className="w-3.5 h-3.5" />
              </button>
              <button className="btn-ghost !px-2" title="Вверх" onClick={() => move(i, -1)} disabled={i === 0}>
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <button className="btn-ghost !px-2" title="Вниз" onClick={() => move(i, 1)} disabled={i === rules.length - 1}>
                <ArrowDown className="w-3.5 h-3.5" />
              </button>
              <button className="btn-ghost !px-2" title="Изменить" onClick={() => setEditing({ index: i, rule: { ...EMPTY, ...r } })}>
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button className="btn-ghost !px-2" title="Копировать" onClick={() => setEditing({ index: null, rule: { ...r, name: r.name + ' (копия)' } })}>
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button
                className="btn-ghost !px-2 hover:!bg-rose-700"
                title="Удалить"
                onClick={() => confirm(`Удалить правило «${r.name}»?`) && save(rules.filter((_, j) => j !== i))}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
