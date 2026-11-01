import React, { useState } from 'react';
import { RUST_PROJECT_FILES, RustFile } from '../rust_code/sources';
import { exportRustProjectZip } from '../utils/exporter';
import { FileCode, Copy, Check, Download, Terminal, ChevronRight, Sparkles } from 'lucide-react';

export const RustCodeViewer: React.FC = () => {
  const [selectedFile, setSelectedFile] = useState<RustFile>(RUST_PROJECT_FILES[1]); // main.rs
  const [copied, setCopied] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(selectedFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadZip = async () => {
    setIsExporting(true);
    try {
      await exportRustProjectZip();
    } catch (e) {
      console.error('Export failed', e);
    } finally {
      setIsExporting(false);
    }
  };

  const lines = selectedFile.content.split('\n');

  return (
    <div className="space-y-6">
      {/* Top Banner with Download ZIP CTA */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 bg-slate-900/60 rounded-xl border border-slate-800">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
            <FileCode className="w-5 h-5 text-indigo-400" />
            RustyYoga Standalone Rust Codebase
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Production-grade, compilable, multi-threaded Rust client. Build with standard <code className="text-indigo-300 font-mono">cargo build --release</code>.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={handleDownloadZip}
            disabled={isExporting}
            className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shadow-md"
          >
            <Download className={`w-4 h-4 ${isExporting ? 'animate-bounce' : ''}`} />
            {isExporting ? 'Generating ZIP...' : 'Download Project (.ZIP)'}
          </button>
        </div>
      </div>

      {/* Main File Browser & Code View */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Sidebar: File Tree */}
        <div className="lg:col-span-3 bg-slate-900 border border-slate-800 rounded-xl p-3 space-y-1">
          <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400 border-b border-slate-800/80 mb-2">
            Project Files
          </div>

          {RUST_PROJECT_FILES.map((file) => {
            const isSelected = selectedFile.path === file.path;
            return (
              <button
                key={file.path}
                onClick={() => setSelectedFile(file)}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs font-mono rounded-lg transition-colors text-left ${
                  isSelected
                    ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 font-semibold'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                }`}
              >
                <span className="truncate">{file.path}</span>
                {isSelected && <ChevronRight className="w-3.5 h-3.5 shrink-0 text-indigo-400" />}
              </button>
            );
          })}

          {/* Quick Terminal Guide */}
          <div className="mt-6 pt-4 border-t border-slate-800/80 px-2 space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Terminal className="w-3.5 h-3.5 text-emerald-400" />
              Build & Run Commands
            </div>
            <div className="p-2.5 bg-slate-950 rounded border border-slate-800 font-mono text-[11px] text-slate-300 space-y-1">
              <div className="text-slate-500"># 1. Compile release binary</div>
              <div className="text-emerald-400">cargo build --release</div>
              <div className="text-slate-500 mt-2"># 2. Run with config</div>
              <div className="text-cyan-400">sudo ./target/release/rusty-yoga-dns</div>
            </div>
          </div>
        </div>

        {/* Right Area: Code Display */}
        <div className="lg:col-span-9 bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm flex flex-col">
          {/* File Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-slate-950 border-b border-slate-800">
            <div>
              <div className="font-mono text-xs font-bold text-white flex items-center gap-2">
                <span>{selectedFile.path}</span>
                <span className="text-slate-500 font-normal">·</span>
                <span className="text-slate-400 font-normal">{lines.length} lines</span>
              </div>
              <div className="text-xs text-slate-400 mt-0.5">{selectedFile.description}</div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy File</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Code Content */}
          <div className="p-4 bg-slate-950 overflow-x-auto max-h-[640px] font-mono text-xs leading-relaxed text-slate-300 selection:bg-indigo-500 selection:text-white">
            <pre className="table w-full">
              {lines.map((line, idx) => (
                <div key={idx} className="table-row hover:bg-slate-900/60">
                  <span className="table-cell select-none text-right pr-4 text-slate-600 text-[11px] w-10 tabular-nums">
                    {idx + 1}
                  </span>
                  <span className="table-cell whitespace-pre">{line || ' '}</span>
                </div>
              ))}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
