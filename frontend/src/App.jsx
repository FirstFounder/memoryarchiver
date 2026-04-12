import { useState, useEffect, useCallback } from 'react';
import { useSSE } from './hooks/useSSE.js';
import { DropZone } from './components/DropZone.jsx';
import { FileBrowser } from './components/FileBrowser.jsx';
import { FileList } from './components/FileList.jsx';
import { JobForm } from './components/JobForm.jsx';
import { JobQueue } from './components/JobQueue.jsx';
import { SyncQueue } from './components/SyncQueue.jsx';
import { HubPanel } from './components/hub/HubPanel.jsx';
import { CoopPanel } from './components/coop/CoopPanel.jsx';
import { getAppConfig } from './api/appConfig.js';
import { useAppConfigStore } from './store/appConfigStore.js';

function useComEdPricing() {
  const [state, setState] = useState({ currentPrice: null, hourlyAvg: null, trend: 'neutral' });
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [feedRes, avgRes] = await Promise.all([
        fetch('https://hourlypricing.comed.com/api?type=5minutefeed&format=json'),
        fetch('https://hourlypricing.comed.com/api?type=currenthouraverage&format=json'),
      ]);
      const [feedData, avgData] = await Promise.all([feedRes.json(), avgRes.json()]);

      const currentPrice = parseFloat(feedData[0]?.price);
      const hourlyAvg    = parseFloat(avgData[0]?.price);

      let trend = 'neutral';
      const readings = feedData.slice(0, 12).map(r => parseFloat(r.price));
      if (readings.length >= 2) {
        const older  = readings.slice(6, 12);
        const recent = readings.slice(0, 6);
        if (older.length && recent.length) {
          const avgOlder  = older.reduce((s, v) => s + v, 0) / older.length;
          const avgRecent = recent.reduce((s, v) => s + v, 0) / recent.length;
          if      (avgRecent < avgOlder) trend = 'down';
          else if (avgRecent > avgOlder) trend = 'up';
        }
      }

      setState({
        currentPrice: isNaN(currentPrice) ? null : currentPrice,
        hourlyAvg:    isNaN(hourlyAvg)    ? null : hourlyAvg,
        trend,
      });
    } catch {
      setState({ currentPrice: null, hourlyAvg: null, trend: 'neutral' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { ...state, loading, refresh };
}

export default function App() {
  // Hook the SSE stream for the lifetime of the app
  useSSE();

  // Fetch server config once on mount and populate the store
  const setConfig    = useAppConfigStore(s => s.setConfig);
  const deviceRole   = useAppConfigStore(s => s.deviceRole);
  const configLoaded = useAppConfigStore(s => s.loaded);
  const coopEnabled  = useAppConfigStore(s => s.coopEnabled);
  useEffect(() => {
    getAppConfig().then(setConfig).catch(() => { /* retain defaults on error */ });
  }, []);

  const isHub  = configLoaded && deviceRole === 'hub';
  const isCoop = configLoaded && coopEnabled;

  const { currentPrice, hourlyAvg, trend, loading: comedLoading, refresh: refreshComed } = useComEdPricing();

  const tabs = [
    { id: 'queues', label: 'Queues' },
    ...(isHub  ? [{ id: 'hub',  label: 'Hub'  }] : []),
    ...(isCoop ? [{ id: 'coop', label: 'Coop' }] : []),
  ];
  const showTabBar = tabs.length > 1;

  const [activeTab, setActiveTab] = useState('queues');

  // Selected source files (uploaded or NAS-picked)
  const [files, setFiles] = useState([]);

  // Whether the NAS file browser modal is open
  const [browserOpen, setBrowserOpen] = useState(false);

  // Merge newly uploaded/selected files into the current list
  const addFiles = (incoming) => {
    setFiles(prev => {
      const existingPaths = new Set(prev.map(f => f.tempPath ?? f.path));
      const deduped = incoming.filter(f => !existingPaths.has(f.tempPath ?? f.path));
      return [...prev, ...deduped];
    });
  };

  // Called when the NAS browser returns a list of subpaths (relative to SCRATCH_ROOT).
  // The backend resolves them against NAS_SCRATCH_ROOT and validates they are allowed.
  const handleNasSelect = (subpaths) => {
    addFiles(subpaths.map(p => ({
      path:     p,               // subpath — backend resolves to absolute NAS path
      origName: p.split('/').pop(),
    })));
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="border-b border-slate-800 px-6 py-4 flex items-center gap-3">
        <span className="text-xl">🎬</span>
        <h1 className="text-slate-100 font-semibold tracking-tight">Memory Archiver</h1>
        <span className="text-slate-600 text-xs ml-auto flex items-center gap-2">
          H.265 · {'{Fam|Vault}'} · {isHub ? 'Synology DS423+' : 'Synology DS220+'}
          <span className="text-slate-600">·</span>
          <span className="text-slate-100">
            {currentPrice != null ? `${currentPrice.toFixed(1)}¢` : '—'}
          </span>
          <span className={trend === 'down' ? 'text-green-400' : trend === 'up' ? 'text-red-400' : 'text-slate-400'}>
            {hourlyAvg != null
              ? `${trend === 'down' ? '↓ ' : trend === 'up' ? '↑ ' : ''}${hourlyAvg.toFixed(1)}¢`
              : '—'}
          </span>
          <button
            onClick={refreshComed}
            className={`text-slate-500 hover:text-slate-300 transition-colors leading-none${comedLoading ? ' opacity-50' : ''}`}
            disabled={comedLoading}
            aria-label="Refresh ComEd price"
          >↻</button>
        </span>
      </header>

      {/* ── Main two-column layout ─────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col lg:flex-row gap-0 overflow-hidden">

        {/* ── Left panel: source + form ───────────────────────────────────── */}
        <div className="lg:w-96 xl:w-[28rem] shrink-0 border-b lg:border-b-0 lg:border-r border-slate-800 p-6 overflow-y-auto flex flex-col gap-6">

          {/* Source section */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-slate-200 font-semibold text-sm">Source Clips</h2>
              <button
                onClick={() => setBrowserOpen(true)}
                className="text-xs text-indigo-400 hover:text-indigo-300 border border-indigo-800 hover:border-indigo-600 px-2.5 py-1 rounded-lg transition-colors"
              >
                Browse NAS
              </button>
            </div>

            <DropZone onUploaded={addFiles} disabled={browserOpen} />
            <FileList files={files} onChange={setFiles} />
          </section>

          {/* Job form */}
          <section>
            <h2 className="text-slate-200 font-semibold text-sm mb-1">Details</h2>
            <JobForm
              files={files}
              onSuccess={() => {}}
              onClear={() => setFiles([])}
            />
          </section>
        </div>

        {/* ── Right panel: queues / hub ───────────────────────────────────── */}
        <div className="flex-1 p-6 overflow-y-auto flex flex-col">

          {/* Tab bar — shown when there is more than one tab */}
          {showTabBar && (
            <div className="flex gap-1 mb-4 border-b border-slate-800 pb-0 -mx-1">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-4 py-2 text-sm rounded-t-lg border-b-2 transition-colors ${
                    activeTab === tab.id
                      ? 'border-indigo-500 text-indigo-300 bg-slate-800/40'
                      : 'border-transparent text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}

          {/* Queues tab — always rendered when active */}
          {activeTab === 'queues' && (
            <>
              <JobQueue />
              {!isHub && <SyncQueue />}
            </>
          )}

          {/* Hub tab */}
          {isHub && activeTab === 'hub' && (
            <HubPanel />
          )}

          {/* Coop tab */}
          {isCoop && activeTab === 'coop' && (
            <CoopPanel />
          )}
        </div>
      </main>

      {/* ── NAS File Browser Modal ─────────────────────────────────────────── */}
      {browserOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setBrowserOpen(false); }}
        >
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-lg h-[70vh] flex flex-col p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-slate-100 font-semibold">Browse NAS Scratch</h3>
              <button
                onClick={() => setBrowserOpen(false)}
                className="text-slate-500 hover:text-slate-300 text-xl leading-none"
              >
                ×
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <FileBrowser
                onSelect={handleNasSelect}
                onClose={() => setBrowserOpen(false)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
