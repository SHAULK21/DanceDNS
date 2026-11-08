import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Config, Status } from '../types';
import { Field, Toggle, toast } from './ui';

export function SettingsView({ config, status, onSave }: { config: Config; status: Status; onSave: (c: Config) => Promise<boolean> }) {
  const [draft, setDraft] = useState(config);
  const [listen, setListen] = useState(config.listen.join(', '));
  useEffect(() => {
    setDraft(config);
    setListen(config.listen.join(', '));
  }, [config]);

  const save = () => onSave({ ...draft, listen: listen.split(/[\s,]+/).filter(Boolean) });

  const exportCfg = () => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dancedns-config.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importCfg = (file: File) => {
    file.text().then((t) => {
      try {
        onSave(JSON.parse(t));
      } catch (e: any) {
        toast('Файл не похож на конфигурацию DanceDNS: ' + e.message, 'error');
      }
    });
  };

  const reset = async () => {
    if (!confirm('Сбросить все правила, серверы и пулы к настройкам по умолчанию?')) return;
    onSave(await api.defaultConfig());
  };

  return (
    <div className="space-y-5 max-w-3xl">
      <h1 className="text-xl font-bold">Настройки</h1>
      {status.restart_required && (
        <div className="card border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-200">Адреса прослушивания изменены — перезапустите DanceDNS, чтобы они начали работать.</div>
      )}
      <div className="card p-5 grid md:grid-cols-2 gap-4">
        <Field label="DNS-адреса прослушивания" hint="Через запятую. Для системного DNS нужен 127.0.0.1:53. Применяется после перезапуска.">
          <input className="input w-full font-mono" value={listen} onChange={(e) => setListen(e.target.value)} />
        </Field>
        <Field label="Адрес панели управления" hint="Применяется после перезапуска.">
          <input className="input w-full font-mono" value={draft.ui_addr} onChange={(e) => setDraft({ ...draft, ui_addr: e.target.value })} />
        </Field>
        <Field label="Пул по умолчанию" hint="Для запросов, которым не подошло ни одно правило.">
          <select className="input w-full" value={draft.default_pool} onChange={(e) => setDraft({ ...draft, default_pool: e.target.value })}>
            {draft.pools.map((p) => (
              <option key={p.id}>{p.id}</option>
            ))}
          </select>
        </Field>
        <Field label="DNS для действия «напрямую»" hint="Обычный (незашифрованный) DNS, ip:порт.">
          <input className="input w-full font-mono" value={draft.direct_dns} onChange={(e) => setDraft({ ...draft, direct_dns: e.target.value })} />
        </Field>
        <div className="flex items-center gap-3">
          <Toggle checked={draft.open_browser} onChange={(v) => setDraft({ ...draft, open_browser: v })} />
          <span className="text-sm">Открывать панель в браузере при запуске</span>
        </div>
        <div className="flex items-center gap-3">
          <Toggle checked={draft.restore_dns_on_exit} onChange={(v) => setDraft({ ...draft, restore_dns_on_exit: v })} />
          <span className="text-sm">Возвращать прежний системный DNS при выходе</span>
        </div>
      </div>

      <div className="card p-5 space-y-4">
        <div className="flex items-center gap-3">
          <h2 className="font-bold">Кэш</h2>
          <Toggle checked={draft.cache.enabled} onChange={(v) => setDraft({ ...draft, cache: { ...draft.cache, enabled: v } })} />
          <span className="text-xs text-slate-500">{status.cache_entries} записей</span>
          <button className="btn-ghost ml-auto" onClick={() => api.clearCache().then(() => toast('Кэш очищен', 'ok'))}>
            Очистить кэш
          </button>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Макс. записей">
            <input type="number" className="input w-full" value={draft.cache.max_entries} onChange={(e) => setDraft({ ...draft, cache: { ...draft.cache, max_entries: Number(e.target.value) } })} />
          </Field>
          <Field label="Мин. TTL, с">
            <input type="number" className="input w-full" value={draft.cache.min_ttl} onChange={(e) => setDraft({ ...draft, cache: { ...draft.cache, min_ttl: Number(e.target.value) } })} />
          </Field>
          <Field label="Макс. TTL, с">
            <input type="number" className="input w-full" value={draft.cache.max_ttl} onChange={(e) => setDraft({ ...draft, cache: { ...draft.cache, max_ttl: Number(e.target.value) } })} />
          </Field>
        </div>
      </div>

      <div className="flex justify-end">
        <button className="btn-primary" onClick={save}>
          Сохранить настройки
        </button>
      </div>

      <div className="card p-5 space-y-3">
        <h2 className="font-bold">Конфигурация</h2>
        <p className="text-sm text-slate-400">
          Все настройки хранятся рядом с программой в файле <span className="font-mono text-slate-200">{status.config_path}</span>. Папку с
          DanceDNS можно переносить на флешку или другой компьютер вместе с настройками.
        </p>
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" onClick={exportCfg}>
            Экспорт в JSON
          </button>
          <label className="btn-ghost cursor-pointer">
            Импорт из JSON
            <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => e.target.files?.[0] && importCfg(e.target.files[0])} />
          </label>
          <button className="btn-danger ml-auto" onClick={reset}>
            Сбросить к умолчаниям
          </button>
        </div>
      </div>
    </div>
  );
}
