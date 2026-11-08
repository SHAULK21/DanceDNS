import { useEffect, useState, type ReactNode } from 'react';
import type { ActionKind, LogStatus } from '../types';

type ToastKind = 'ok' | 'error' | 'info';
type ToastItem = { id: number; text: string; kind: ToastKind };
let listeners: ((t: ToastItem) => void)[] = [];
let nextId = 1;

export function toast(text: string, kind: ToastKind = 'info') {
  const t = { id: nextId++, text, kind };
  listeners.forEach((l) => l(t));
}

export function Toasts() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const l = (t: ToastItem) => {
      setItems((p) => [...p, t]);
      setTimeout(() => setItems((p) => p.filter((x) => x.id !== t.id)), t.kind === 'error' ? 8000 : 3500);
    };
    listeners.push(l);
    return () => {
      listeners = listeners.filter((x) => x !== l);
    };
  }, []);
  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2 max-w-md">
      {items.map((t) => (
        <div
          key={t.id}
          className={`px-4 py-2.5 rounded-lg text-sm shadow-xl border ${
            t.kind === 'error'
              ? 'bg-rose-950 border-rose-800 text-rose-100'
              : t.kind === 'ok'
                ? 'bg-emerald-950 border-emerald-800 text-emerald-100'
                : 'bg-slate-900 border-slate-700 text-slate-100'
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

export const ACTION_LABEL: Record<ActionKind, string> = {
  route: 'Через пул DoH',
  block: 'Блокировать',
  direct: 'Напрямую (обычный DNS)',
  local: 'Свой IP',
};

export const STATUS_STYLE: Record<LogStatus, { label: string; cls: string }> = {
  resolved: { label: 'DoH', cls: 'bg-indigo-950 text-indigo-300 border-indigo-800' },
  cached: { label: 'кэш', cls: 'bg-sky-950 text-sky-300 border-sky-800' },
  blocked: { label: 'блок', cls: 'bg-rose-950 text-rose-300 border-rose-800' },
  local: { label: 'свой IP', cls: 'bg-violet-950 text-violet-300 border-violet-800' },
  direct: { label: 'напрямую', cls: 'bg-amber-950 text-amber-300 border-amber-800' },
  error: { label: 'ошибка', cls: 'bg-red-950 text-red-300 border-red-800' },
};

export function Badge({ children, cls }: { children: ReactNode; cls: string }) {
  return <span className={`inline-block px-1.5 py-0.5 text-[10px] font-semibold rounded border whitespace-nowrap ${cls}`}>{children}</span>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-500 mt-1">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, title }: { checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={() => onChange(!checked)}
      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${checked ? 'bg-emerald-500' : 'bg-slate-700'}`}
    >
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

export function fmtMs(v: number | null | undefined) {
  if (v == null) return '—';
  return v < 10 ? `${v.toFixed(1)} мс` : `${Math.round(v)} мс`;
}
