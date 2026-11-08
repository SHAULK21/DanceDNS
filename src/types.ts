export type ActionKind = 'route' | 'block' | 'direct' | 'local';
export type PoolStrategy = 'fastest' | 'round_robin' | 'failover';

export interface ServerConfig {
  id: string;
  name: string;
  url: string;
  bootstrap: string[];
  timeout_ms: number;
}

export interface PoolConfig {
  id: string;
  servers: string[];
  strategy: PoolStrategy;
}

export interface RuleConfig {
  name: string;
  enabled: boolean;
  process: string;
  process_path: string;
  domain: string;
  qtype: string;
  action: ActionKind;
  pool: string;
  sinkhole: string;
  ip: string;
  description: string;
}

export interface Config {
  listen: string[];
  ui_addr: string;
  open_browser: boolean;
  direct_dns: string;
  default_pool: string;
  restore_dns_on_exit: boolean;
  cache: { enabled: boolean; max_entries: number; min_ttl: number; max_ttl: number };
  servers: ServerConfig[];
  pools: PoolConfig[];
  rules: RuleConfig[];
}

export interface Answer {
  name: string;
  type: string;
  ttl: number;
  data: string;
}

export type LogStatus = 'resolved' | 'cached' | 'blocked' | 'local' | 'direct' | 'error';

export interface LogEntry {
  seq: number;
  ts: number;
  client: string;
  transport: string;
  pid: number | null;
  process: string;
  process_path: string;
  domain: string;
  qtype: string;
  rule: string;
  action: ActionKind;
  pool: string;
  upstream: string;
  status: LogStatus;
  rcode: string;
  latency_ms: number;
  answers: Answer[];
  dnssec: boolean;
  error: string | null;
}

export interface UpstreamStats {
  id: string;
  name: string;
  url: string;
  latency_ms: number | null;
  healthy: boolean;
  ok: number;
  fail: number;
  last_error: string | null;
}

export interface Status {
  version: string;
  os: string;
  admin: boolean | null;
  uptime_s: number;
  listeners: { addr: string; udp: boolean; tcp: boolean; error: string | null }[];
  counters: { total: number; resolved: number; cached: number; blocked: number; local: number; direct: number; errors: number };
  cache_entries: number;
  upstreams: UpstreamStats[];
  process_attribution: boolean;
  config_path: string;
  system_dns_active: boolean;
  restart_required: boolean;
}

export interface SysDnsStatus {
  supported: boolean;
  active: boolean;
  interfaces: { alias: string; servers: string[] }[];
  note: string | null;
}
