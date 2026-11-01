export type RuleActionType = 'route' | 'block' | 'direct' | 'local';

export interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  processPattern: string;       // e.g. "*chrome.exe", "curl*", "telegram.exe"
  processPathPattern?: string;  // e.g. "C:\\Program Files\\*"
  domainPattern: string;        // e.g. "*.doubleclick.net", "*.ru", "*"
  qtype: string;                // "ANY" | "A" | "AAAA" | "HTTPS"
  action: RuleActionType;
  pool: string;                 // "default" | "secure_privacy" | "adblock"
  sinkholeIp?: string;          // e.g. "0.0.0.0"
  localIp?: string;             // e.g. "127.0.0.1"
  description?: string;
}

export interface UpstreamServer {
  id: string;
  name: string;
  provider: string;
  url: string;
  bootstrapIps: string[];
  features: string[];
  description: string;
  latencyMs?: number;
  online?: boolean;
}

export interface DnsAnswerRecord {
  name: string;
  type: number | string;
  TTL: number;
  data: string;
}

export interface QueryLogEntry {
  id: string;
  timestamp: string;
  processName: string;
  pid: number;
  domain: string;
  qtype: string;
  matchedRule: string;
  action: RuleActionType;
  pool: string;
  upstreamServer: string;
  latencyMs: number;
  status: 'resolved' | 'blocked' | 'cached' | 'bypassed';
  answers: DnsAnswerRecord[];
  dnssec: boolean;
}

export interface TraceStep {
  step: number;
  title: string;
  description: string;
  status: 'success' | 'warning' | 'info' | 'blocked';
  detail: string;
}
