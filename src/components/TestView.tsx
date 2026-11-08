import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '../api';
import type { LogEntry } from '../types';
import { Badge, Field, STATUS_STYLE, fmtMs } from './ui';

const TYPES = ['A', 'AAAA', 'HTTPS', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'SRV', 'PTR'];

export function TestView({ preset }: { preset: { process: string; domain: string } | null }) {
  const [domain, setDomain] = useState(preset?.domain || 'example.com');
  const [qtype, setQtype] = useState('A');
  const [process, setProcess] = useState(preset?.process || '');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LogEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (preset) {
      setDomain(preset.domain || 'example.com');
      setProcess(preset.process);
    }
  }, [preset]);

  const run = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await api.resolve({ domain, qtype, process, process_path: path }));
    } catch (err: any) {
      setError(err.message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <h1 className="text-xl font-bold">Проверка</h1>
        <p className="text-sm text-slate-400">
          Настоящий DNS-запрос через DanceDNS: те же правила, кэш и DoH-серверы. Можно указать процесс, от имени которого проверить правила.
        </p>
      </div>
      <form onSubmit={run} className="card p-5 grid md:grid-cols-[2fr_1fr] gap-4">
        <Field label="Домен">
          <input className="input w-full font-mono" value={domain} onChange={(e) => setDomain(e.target.value)} />
        </Field>
        <Field label="Тип">
          <select className="input w-full" value={qtype} onChange={(e) => setQtype(e.target.value)}>
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="Как будто от процесса" hint="Необязательно, например chrome.exe">
          <input className="input w-full font-mono" value={process} onChange={(e) => setProcess(e.target.value)} placeholder="(любой)" />
        </Field>
        <Field label="Путь к программе" hint="Необязательно">
          <input className="input w-full font-mono" value={path} onChange={(e) => setPath(e.target.value)} />
        </Field>
        <div className="md:col-span-2">
          <button className="btn-primary" disabled={busy || !domain.trim()}>
            <Search className="w-4 h-4" /> {busy ? 'Запрос…' : 'Выполнить запрос'}
          </button>
        </div>
      </form>

      {error && <div className="card p-4 border-rose-800 text-rose-300 text-sm">{error}</div>}
      {result && (
        <div className="card p-5 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Badge cls={STATUS_STYLE[result.status].cls}>{STATUS_STYLE[result.status].label}</Badge>
            <span className="font-mono">
              {result.domain} {result.qtype}
            </span>
            <span className="text-slate-400 text-sm">{result.rcode}</span>
            <span className="ml-auto font-mono text-sm text-slate-300">{fmtMs(result.latency_ms)}</span>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate-500">Правило</dt>
            <dd>{result.rule}</dd>
            {result.pool && (
              <>
                <dt className="text-slate-500">Пул</dt>
                <dd className="font-mono">{result.pool}</dd>
              </>
            )}
            {result.upstream && (
              <>
                <dt className="text-slate-500">Ответил</dt>
                <dd className="font-mono">{result.upstream}</dd>
              </>
            )}
            <dt className="text-slate-500">DNSSEC (AD)</dt>
            <dd>{result.dnssec ? 'да' : 'нет'}</dd>
          </dl>
          {result.error && <div className="text-red-300 font-mono text-xs break-all">{result.error}</div>}
          <div className="bg-slate-950 rounded-lg p-3 font-mono text-xs space-y-0.5">
            {result.answers.length === 0 ? (
              <span className="text-slate-500">Нет записей</span>
            ) : (
              result.answers.map((a, i) => (
                <div key={i}>
                  <span className="text-slate-500">{a.name}</span> <span className="text-slate-600">{a.ttl}</span> <span className="text-indigo-300">{a.type}</span> {a.data}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
