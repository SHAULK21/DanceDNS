import React, { useState } from 'react';
import { INITIAL_RULES, INITIAL_SERVERS, SAMPLE_QUERY_LOGS } from './data/initialData';
import { RoutingRule, UpstreamServer, QueryLogEntry } from './types';
import { RuleStudio } from './components/RuleStudio';
import { LiveDnsInspector } from './components/LiveDnsInspector';
import { DohServersView } from './components/DohServersView';
import { ProcessInterceptorGuide } from './components/ProcessInterceptorGuide';
import { RustCodeViewer } from './components/RustCodeViewer';
import { exportRustProjectZip } from './utils/exporter';
import { Download } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<
    'rules' | 'inspector' | 'servers' | 'architecture' | 'code'
  >('rules');

  const [rules, setRules] = useState<RoutingRule[]>(INITIAL_RULES);
  const [servers, setServers] = useState<UpstreamServer[]>(INITIAL_SERVERS);
  const [queryLogs, setQueryLogs] = useState<QueryLogEntry[]>(SAMPLE_QUERY_LOGS);

  // Inspector presets
  const [inspectorProcess, setInspectorProcess] = useState('chrome.exe');
  const [inspectorDomain, setInspectorDomain] = useState('github.com');
  const [isDownloadingZip, setIsDownloadingZip] = useState(false);

  const handleTestRuleInInspector = (processName: string, domain: string) => {
    setInspectorProcess(processName);
    setInspectorDomain(domain);
    setActiveTab('inspector');
  };

  const handleAddLog = (entry: QueryLogEntry) => {
    setQueryLogs((prev) => [entry, ...prev.slice(0, 99)]);
  };

  const handleAddServer = (newServer: UpstreamServer) => {
    setServers((prev) => [newServer, ...prev]);
  };

  const handleExportZip = async () => {
    setIsDownloadingZip(true);
    try {
      await exportRustProjectZip();
    } catch (e) {
      console.error(e);
    } finally {
      setIsDownloadingZip(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100 flex flex-col font-sans antialiased selection:bg-indigo-500 selection:text-white">
      {/* Top Bar Contract: Zone 1 (Wordmark) - Zone 2 (Nav Links) - Zone 3 (Primary Action) */}
      <header className="flex items-center justify-between gap-8 px-6 py-3.5 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur sticky top-0 z-50">
        {/* Zone 1: Wordmark */}
        <button
          onClick={() => setActiveTab('rules')}
          className="text-lg font-extrabold tracking-tight text-white whitespace-nowrap shrink-0 hover:opacity-90 transition-opacity flex items-center gap-2"
        >
          <span className="text-indigo-400">🦀</span>
          <span>RustyYoga DNS</span>
        </button>

        {/* Zone 2: 4-5 concise single-line nav links */}
        <nav className="hidden md:flex items-center gap-6 text-xs font-semibold text-slate-400">
          <button
            onClick={() => setActiveTab('rules')}
            className={`transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeTab === 'rules'
                ? 'text-white border-indigo-500'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            Rule Studio
          </button>

          <button
            onClick={() => setActiveTab('inspector')}
            className={`transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeTab === 'inspector'
                ? 'text-white border-indigo-500'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            Live DNS Inspector
          </button>

          <button
            onClick={() => setActiveTab('servers')}
            className={`transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeTab === 'servers'
                ? 'text-white border-indigo-500'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            DoH Upstream Pools
          </button>

          <button
            onClick={() => setActiveTab('architecture')}
            className={`transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeTab === 'architecture'
                ? 'text-white border-indigo-500'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            Process Interceptor
          </button>

          <button
            onClick={() => setActiveTab('code')}
            className={`transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeTab === 'code'
                ? 'text-white border-indigo-500'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            Rust Source Code
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={handleExportZip}
            disabled={isDownloadingZip}
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{isDownloadingZip ? 'Exporting...' : 'Export Cargo ZIP'}</span>
          </button>
        </div>
      </header>

      {/* Mobile nav bar fallback */}
      <div className="flex md:hidden items-center justify-around bg-slate-950 border-b border-slate-800 text-[11px] font-medium py-2 px-2 overflow-x-auto">
        <button
          onClick={() => setActiveTab('rules')}
          className={`px-2 py-1 rounded whitespace-nowrap ${
            activeTab === 'rules' ? 'bg-indigo-600 text-white' : 'text-slate-400'
          }`}
        >
          Rules
        </button>
        <button
          onClick={() => setActiveTab('inspector')}
          className={`px-2 py-1 rounded whitespace-nowrap ${
            activeTab === 'inspector' ? 'bg-indigo-600 text-white' : 'text-slate-400'
          }`}
        >
          Inspector
        </button>
        <button
          onClick={() => setActiveTab('servers')}
          className={`px-2 py-1 rounded whitespace-nowrap ${
            activeTab === 'servers' ? 'bg-indigo-600 text-white' : 'text-slate-400'
          }`}
        >
          Servers
        </button>
        <button
          onClick={() => setActiveTab('architecture')}
          className={`px-2 py-1 rounded whitespace-nowrap ${
            activeTab === 'architecture' ? 'bg-indigo-600 text-white' : 'text-slate-400'
          }`}
        >
          Architecture
        </button>
        <button
          onClick={() => setActiveTab('code')}
          className={`px-2 py-1 rounded whitespace-nowrap ${
            activeTab === 'code' ? 'bg-indigo-600 text-white' : 'text-slate-400'
          }`}
        >
          Rust Code
        </button>
      </div>

      {/* Main Content Viewport */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 lg:p-8 space-y-6">
        {activeTab === 'rules' && (
          <RuleStudio
            rules={rules}
            onUpdateRules={setRules}
            onTestRuleInInspector={handleTestRuleInInspector}
          />
        )}

        {activeTab === 'inspector' && (
          <LiveDnsInspector
            rules={rules}
            queryLogs={queryLogs}
            onAddLog={handleAddLog}
            presetProcess={inspectorProcess}
            presetDomain={inspectorDomain}
          />
        )}

        {activeTab === 'servers' && (
          <DohServersView
            servers={servers}
            onAddServer={handleAddServer}
            onUpdateServers={setServers}
          />
        )}

        {activeTab === 'architecture' && <ProcessInterceptorGuide />}

        {activeTab === 'code' && <RustCodeViewer />}
      </main>

      {/* Minimalistic quiet footer */}
      <footer className="border-t border-slate-800/80 bg-slate-950 py-4 px-6 text-xs text-slate-500">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span>RustyYoga DNS Engine</span>
            <span aria-hidden="true">·</span>
            <span>YogaDNS Analogue in Rust</span>
            <span aria-hidden="true">·</span>
            <span>RFC 8484 DNS-over-HTTPS</span>
          </div>
          <div>
            Built with Tokio, Hickory-DNS, and Win32/procfs socket attribution.
          </div>
        </div>
      </footer>
    </div>
  );
}
