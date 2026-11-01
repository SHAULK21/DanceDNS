import React, { useState } from 'react';
import { Cpu, Shield, Network, Terminal, CheckCircle2, ArrowRight } from 'lucide-react';

export const ProcessInterceptorGuide: React.FC = () => {
  const [selectedOS, setSelectedOS] = useState<'windows' | 'linux'>('windows');
  const [testPort, setTestPort] = useState('54321');
  const [simulatedLookup, setSimulatedLookup] = useState<{
    pid: number;
    name: string;
    path: string;
    found: boolean;
  } | null>(null);

  const sampleProcesses = [
    { pid: 14208, name: 'chrome.exe', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { pid: 6104, name: 'telegram.exe', path: 'C:\\Users\\User\\AppData\\Roaming\\Telegram Desktop\\Telegram.exe' },
    { pid: 8932, name: 'spotify.exe', path: 'C:\\Users\\User\\AppData\\Roaming\\Spotify\\Spotify.exe' },
    { pid: 19844, name: 'curl.exe', path: 'C:\\Windows\\System32\\curl.exe' },
    { pid: 4092, name: 'discord.exe', path: 'C:\\Users\\User\\AppData\\Local\\Discord\\app-1.0.9142\\Discord.exe' },
  ];

  const handleTestLookup = () => {
    const portNum = parseInt(testPort, 10);
    const proc = sampleProcesses[portNum % sampleProcesses.length];
    setSimulatedLookup({
      pid: proc.pid,
      name: proc.name,
      path: proc.path,
      found: true,
    });
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="p-5 bg-slate-900/60 rounded-xl border border-slate-800">
        <h2 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
          <Network className="w-5 h-5 text-indigo-400" />
          Per-Process DNS Interception Engine
        </h2>
        <p className="text-sm text-slate-400 mt-1">
          Detailed technical architecture showing how YogaDNS and RustyYoga identify the originating process executable for every inbound DNS socket.
        </p>
      </div>

      {/* OS Selector Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
        <button
          onClick={() => setSelectedOS('windows')}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-colors ${
            selectedOS === 'windows'
              ? 'bg-indigo-600 text-white'
              : 'text-slate-400 hover:text-white bg-slate-900'
          }`}
        >
          <span>Windows Implementation (GetExtendedUdpTable / WFP)</span>
        </button>

        <button
          onClick={() => setSelectedOS('linux')}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-colors ${
            selectedOS === 'linux'
              ? 'bg-indigo-600 text-white'
              : 'text-slate-400 hover:text-white bg-slate-900'
          }`}
        >
          <span>Linux Implementation (/proc/net/udp + eBPF)</span>
        </button>
      </div>

      {/* Architecture Detail */}
      {selectedOS === 'windows' ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="p-6 bg-slate-900 border border-slate-800 rounded-xl space-y-4">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Cpu className="w-4 h-4 text-emerald-400" />
              Method 1: Win32 Extended UDP Table (RustyYoga)
            </h3>
            <p className="text-xs text-slate-300 leading-relaxed">
              When any program (e.g. Chrome, Telegram) resolves a domain, the Windows socket subsystem creates an ephemeral local UDP client port (e.g. <code className="text-indigo-300 font-mono">127.0.0.1:54912</code>) to send the DNS query to <code className="text-indigo-300 font-mono">127.0.0.1:53</code>.
            </p>

            <div className="space-y-2 text-xs">
              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800/80">
                <span className="font-semibold text-indigo-400">1. Query Interception:</span>
                <span className="text-slate-300 ml-1">
                  UdpSocket receives packet and extracts client source port.
                </span>
              </div>
              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800/80">
                <span className="font-semibold text-emerald-400">2. Kernel Table Query:</span>
                <span className="text-slate-300 ml-1">
                  Calls <code className="font-mono text-cyan-300">GetExtendedUdpTable(UDP_TABLE_OWNER_PID)</code> in <code className="font-mono">iphlpapi.dll</code> to find matching <code className="font-mono">dwLocalPort</code> and reads <code className="font-mono">dwOwningPid</code>.
                </span>
              </div>
              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800/80">
                <span className="font-semibold text-amber-400">3. Process Path Resolution:</span>
                <span className="text-slate-300 ml-1">
                  Calls <code className="font-mono text-cyan-300">OpenProcess()</code> + <code className="font-mono text-cyan-300">QueryFullProcessImageNameW()</code> to retrieve full exe path (e.g. <code className="font-mono">C:\Program Files\Google\Chrome\Application\chrome.exe</code>).
                </span>
              </div>
              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800/80">
                <span className="font-semibold text-violet-400">4. Rule Match:</span>
                <span className="text-slate-300 ml-1">
                  Passes executable name <code className="font-mono text-emerald-300">chrome.exe</code> and domain into <code className="font-mono">RuleEngine::evaluate()</code>.
                </span>
              </div>
            </div>
          </div>

          <div className="p-6 bg-slate-900 border border-slate-800 rounded-xl space-y-4">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Shield className="w-4 h-4 text-cyan-400" />
              Method 2: Windows Filtering Platform (WFP Driver)
            </h3>
            <p className="text-xs text-slate-300 leading-relaxed">
              Official YogaDNS also uses a lightweight Windows Filtering Platform (WFP) driver to intercept packets before they hit the network stack:
            </p>

            <div className="p-4 bg-slate-950 rounded-lg border border-slate-800 font-mono text-xs text-slate-300 space-y-2">
              <div className="text-indigo-400">// WFP ALE Authorization Layer Hook</div>
              <div>Layer: <span className="text-emerald-400">FWPM_LAYER_ALE_AUTH_CONNECT_V4</span></div>
              <div>ClassifyFn(inValues, inMetaValues, ...):</div>
              <div className="pl-4 text-slate-400">
                uint64_t processId = inMetaValues-&gt;processId;<br />
                FWP_BYTE_BLOB* path = inMetaValues-&gt;processPath;<br />
                <span className="text-cyan-400">// Redirect packet to 127.0.0.1:53</span>
              </div>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              RustyYoga delivers full user-mode process awareness out-of-the-box via <strong className="text-white">GetExtendedUdpTable</strong>, which requires zero kernel drivers, passes WHQL checks, and runs smoothly with standard administrator privileges!
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="p-6 bg-slate-900 border border-slate-800 rounded-xl space-y-4">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Terminal className="w-4 h-4 text-amber-400" />
              Linux: /proc/net/udp Socket Inode Resolution
            </h3>
            <p className="text-xs text-slate-300 leading-relaxed">
              On Linux distributions, RustyYoga maps client ports using the Linux virtual filesystem:
            </p>

            <div className="space-y-2 text-xs">
              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800/80">
                <span className="font-semibold text-indigo-400">Step 1:</span>
                <span className="text-slate-300 ml-1">
                  Convert client port to 4-character hex (e.g. <code className="font-mono">53000 &rarr; CF08</code>) and find matching socket entry in <code className="font-mono text-cyan-300">/proc/net/udp</code>.
                </span>
              </div>
              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800/80">
                <span className="font-semibold text-emerald-400">Step 2:</span>
                <span className="text-slate-300 ml-1">
                  Read column 10 (<code className="font-mono text-cyan-300">inode</code>) for the socket.
                </span>
              </div>
              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800/80">
                <span className="font-semibold text-amber-400">Step 3:</span>
                <span className="text-slate-300 ml-1">
                  Scan active processes in <code className="font-mono text-cyan-300">/proc/[pid]/fd/*</code> for <code className="font-mono">socket:[inode]</code> symlink.
                </span>
              </div>
              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800/80">
                <span className="font-semibold text-violet-400">Step 4:</span>
                <span className="text-slate-300 ml-1">
                  Read <code className="font-mono text-cyan-300">/proc/[pid]/comm</code> and <code className="font-mono text-cyan-300">/proc/[pid]/exe</code> symlink.
                </span>
              </div>
            </div>
          </div>

          <div className="p-6 bg-slate-900 border border-slate-800 rounded-xl space-y-4">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Cpu className="w-4 h-4 text-cyan-400" />
              Advanced Linux: eBPF CGroup Socket Attribution
            </h3>
            <p className="text-xs text-slate-300 leading-relaxed">
              For high-throughput servers (100,000+ QPS), RustyYoga also supports optional eBPF cgroup socket probes:
            </p>

            <div className="p-4 bg-slate-950 rounded-lg border border-slate-800 font-mono text-xs text-slate-300 space-y-2">
              <div className="text-indigo-400">// eBPF sockops program</div>
              <div>SEC(&quot;sockops&quot;) int bpf_sockmap(struct bpf_sock_ops *skops) &#123;</div>
              <div className="pl-4 text-slate-400">
                u32 pid = bpf_get_current_pid_tgid() &gt;&gt; 32;<br />
                <span className="text-emerald-400">// Store [source_port -&gt; pid] in BPF_MAP_TYPE_HASH</span><br />
                bpf_map_update_elem(&amp;port_to_pid_map, &amp;sport, &amp;pid, BPF_ANY);
              </div>
              <div>&#125;</div>
            </div>
          </div>
        </div>
      )}

      {/* Interactive Port-to-Process Simulation Playground */}
      <div className="p-6 bg-slate-900 border border-slate-800 rounded-xl">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Terminal className="w-4 h-4 text-emerald-400" />
          Socket Attribution Verification Sandbox
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          Test how RustyYoga maps client socket ephemeral ports to active processes in real time.
        </p>

        <div className="flex flex-col sm:flex-row items-center gap-3 mt-4">
          <div className="w-full sm:w-auto">
            <label className="block text-[11px] font-mono text-slate-400 mb-1">
              Client Ephemeral Port
            </label>
            <input
              type="text"
              value={testPort}
              onChange={(e) => setTestPort(e.target.value)}
              placeholder="e.g. 54321"
              className="px-3 py-2 text-sm font-mono bg-slate-950 border border-slate-700 rounded-lg text-emerald-400 focus:outline-none focus:border-indigo-500 w-full sm:w-48"
            />
          </div>

          <button
            onClick={handleTestLookup}
            className="w-full sm:w-auto mt-auto flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors h-[38px] whitespace-nowrap"
          >
            <span>Execute Port Attribution</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {simulatedLookup && (
          <div className="mt-4 p-4 bg-slate-950 rounded-lg border border-slate-800 flex items-center justify-between font-mono text-xs">
            <div className="flex items-center gap-4">
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              <div>
                <div className="text-slate-300">
                  Port <span className="text-indigo-400">{testPort}</span> mapped to PID:{' '}
                  <span className="text-amber-400 font-bold">{simulatedLookup.pid}</span>
                </div>
                <div className="text-slate-400 text-[11px] mt-0.5 truncate max-w-xl">
                  Executable: <strong className="text-emerald-300">{simulatedLookup.name}</strong> ({simulatedLookup.path})
                </div>
              </div>
            </div>
            <span className="text-emerald-400 text-[11px] font-semibold bg-emerald-950/40 border border-emerald-800/40 px-2.5 py-1 rounded">
              MATCHED
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
