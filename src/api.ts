import type { Config, LogEntry, Status, SysDnsStatus } from './types';

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  status: () => call<Status>('GET', '/api/status'),
  config: () => call<Config>('GET', '/api/config'),
  defaultConfig: () => call<Config>('GET', '/api/config/default'),
  saveConfig: (c: Config) => call<{ ok: boolean; restart_required: boolean }>('PUT', '/api/config', c),
  logs: (after: number) => call<{ entries: LogEntry[] }>('GET', `/api/logs?after=${after}&limit=1000`),
  clearLogs: () => call('POST', '/api/logs/clear'),
  clearCache: () => call('POST', '/api/cache/clear'),
  resolve: (r: { domain: string; qtype: string; process: string; process_path: string }) => call<LogEntry>('POST', '/api/resolve', r),
  benchmark: () =>
    call<{ results: { id: string; ok: boolean; latency_ms: number | null; first_ms: number | null; error: string | null }[] }>('POST', '/api/benchmark'),
  sysDns: () => call<SysDnsStatus>('GET', '/api/system-dns'),
  setSysDns: (enable: boolean) => call<SysDnsStatus>('POST', '/api/system-dns', { enable }),
  shutdown: () => call('POST', '/api/shutdown'),
};
