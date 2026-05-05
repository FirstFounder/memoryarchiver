import { useState, useEffect, useCallback, useRef } from 'react';
import { useSSE } from './hooks/useSSE.js';
import { DropZone } from './components/DropZone.jsx';
import { FileBrowser } from './components/FileBrowser.jsx';
import { FileList } from './components/FileList.jsx';
import { JobForm } from './components/JobForm.jsx';
import { JobQueue } from './components/JobQueue.jsx';
import { SyncQueue } from './components/SyncQueue.jsx';
import { EncoderSettings } from './components/EncoderSettings.jsx';
import { HubPanel } from './components/hub/HubPanel.jsx';
import { CaPanel } from './components/ca/CaPanel.jsx';
import { CoopPanel } from './components/coop/CoopPanel.jsx';
import { TeslaPanel } from './components/tesla/TeslaPanel.jsx';
import { GaragePanel } from './components/tesla/GaragePanel.jsx';
import { TeslaSettingsModal } from './components/tesla/TeslaSettingsModal.jsx';
import { AudioTab } from './components/audio/AudioTab.jsx';
import { getAppConfig } from './api/appConfig.js';
import { useAppConfigStore } from './store/appConfigStore.js';

const FIXED_RATE_CENTS = 7.8;

function useComEdPricing() {
  const [state, setState] = useState({ currentPrice: null, hourlyAvg: null, priceTrend: 'same', avgTrend: 'same' });
  const [loading, setLoading] = useState(false);
  const prevFiveMinPrice = useRef(null);
  const prevHourlyAvg = useRef(null);

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
      const nextCurrentPrice = isNaN(currentPrice) ? null : currentPrice;
      const nextHourlyAvg = isNaN(hourlyAvg) ? null : hourlyAvg;

      let priceTrend = 'same';
      if (nextCurrentPrice != null && prevFiveMinPrice.current != null) {
        if (nextCurrentPrice > prevFiveMinPrice.current) priceTrend = 'up';
        else if (nextCurrentPrice < prevFiveMinPrice.current) priceTrend = 'down';
      }

      let avgTrend = 'same';
      if (nextHourlyAvg != null && prevHourlyAvg.current != null) {
        if (nextHourlyAvg > prevHourlyAvg.current) avgTrend = 'up';
        else if (nextHourlyAvg < prevHourlyAvg.current) avgTrend = 'down';
      }

      prevFiveMinPrice.current = nextCurrentPrice;
      prevHourlyAvg.current = nextHourlyAvg;

      setState({
        currentPrice: nextCurrentPrice,
        hourlyAvg: nextHourlyAvg,
        priceTrend,
        avgTrend,
      });
    } catch {
      prevFiveMinPrice.current = null;
      prevHourlyAvg.current = null;
      setState({ currentPrice: null, hourlyAvg: null, priceTrend: 'same', avgTrend: 'same' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { ...state, loading, refresh };
}

function getTrendProps(trend, fallbackArrow) {
  if (trend === 'down') {
    return { arrow: '↓', className: 'text-green-400' };
  }
  if (trend === 'up') {
    return { arrow: '↑', className: 'text-red-400' };
  }
  return { arrow: fallbackArrow, className: 'text-slate-100' };
}

function getHourlyAvgClass(hourlyAvg) {
  if (hourlyAvg == null) {
    return { className: 'text-slate-400', isFlashing: false };
  }
  if (hourlyAvg < 0) {
    return { className: 'text-green-400', isFlashing: true };
  }
  if (hourlyAvg < 2) {
    return { className: 'text-green-400', isFlashing: false };
  }
  if (hourlyAvg <= FIXED_RATE_CENTS) {
    return { className: 'text-slate-100', isFlashing: false };
  }
  if (hourlyAvg <= 10) {
    return { className: 'text-amber-400', isFlashing: false };
  }
  if (hourlyAvg <= 20) {
    return { className: 'text-red-400', isFlashing: false };
  }
  return { className: 'text-red-400', isFlashing: true };
}

export default function App() {
  // Hook the SSE stream for the lifetime of the app
  useSSE();

  // Fetch server config once on mount and populate the store
  const setConfig    = useAppConfigStore(s => s.setConfig);
  const deviceRole   = useAppConfigStore(s => s.deviceRole);
  const configLoaded = useAppConfigStore(s => s.loaded);
  const coopEnabled  = useAppConfigStore(s => s.coopEnabled);
  const teslaEnabled = useAppConfigStore(s => s.teslaEnabled);
  const caEnabled    = useAppConfigStore(s => s.caEnabled);
  const audioEnabled = useAppConfigStore(s => s.audioEnabled);
  useEffect(() => {
    getAppConfig().then(setConfig).catch(() => { /* retain defaults on error */ });
  }, []);

  const isHub   = configLoaded && deviceRole === 'hub';
  const isCoop  = configLoaded && coopEnabled;
  const isTesla = configLoaded && teslaEnabled;
  const isCa    = configLoaded && caEnabled;
  const isAudio = configLoaded && audioEnabled;

  const { currentPrice, hourlyAvg, priceTrend, avgTrend, loading: comedLoading, refresh: refreshComed } = useComEdPricing();
  const lastPriceArrow = useRef('↑');
  const lastAvgArrow = useRef('↑');
  if (priceTrend !== 'same') {
    lastPriceArrow.current = priceTrend === 'up' ? '↑' : '↓';
  }
  if (avgTrend !== 'same') {
    lastAvgArrow.current = avgTrend === 'up' ? '↑' : '↓';
  }

  const priceTrendProps = getTrendProps(priceTrend, lastPriceArrow.current);
  const avgTrendProps = getTrendProps(avgTrend, lastAvgArrow.current);
  const { className: currentPriceClass, isFlashing: currentPriceFlashing } = getHourlyAvgClass(currentPrice);
  const { className: hourlyAvgClass, isFlashing: hourlyAvgFlashing } = getHourlyAvgClass(hourlyAvg);

  const tabs = [
    { id: 'queues', label: 'Queues' },
    ...(isHub  ? [{ id: 'hub',  label: 'Hub'  }] : []),
    ...(isCa ? [{ id: 'ca', label: 'CA' }] : []),
    ...(isCoop ? [{ id: 'coop', label: 'Coop' }] : []),
    ...(isTesla ? [{ id: 'garage', label: 'Garage' }, { id: 'tesla', label: 'Tesla' }] : []),
    ...(isAudio ? [{ id: 'audio', label: 'Audio' }] : []),
  ];
  const showTabBar = tabs.length > 1;

  const [activeTab, setActiveTab] = useState('queues');
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (!tabs.some(tab => tab.id === activeTab)) {
      setActiveTab('queues');
    }
  }, [activeTab, tabs]);

  // Selected source files (uploaded or NAS-picked)
  const [files, setFiles] = useState([]);

  // Whether the NAS file browser modal is open
  const [browserOpen, setBrowserOpen] = useState(false);

  // Probe error shown when NAS file probe fails
  const [probeError, setProbeError] = useState(null);

  // Merge newly uploaded/selected files into the current list
  const addFiles = (incoming) => {
    setFiles(prev => {
      const existingPaths = new Set(prev.map(f => f.tempPath ?? f.path));
      const deduped = incoming.filter(f => !existingPaths.has(f.tempPath ?? f.path));
      return [...prev, ...deduped];
    });
  };

  // Called when the NAS browser returns a list of subpaths (relative to SCRATCH_ROOT).
  // Probes each file immediately so metadata is available before the user submits,
  // matching the behaviour of the local upload path.
  const handleNasSelect = async (subpaths) => {
    setProbeError(null);
    setBrowserOpen(false);
    try {
      const res = await fetch('/api/probe', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ paths: subpaths }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Probe failed: HTTP ${res.status}`);
      }
      const meta = await res.json();
      addFiles(meta);
    } catch (err) {
      setProbeError(err.message || 'Could not read file metadata — please try again.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <style>{'@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }'}</style>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="border-b border-slate-800 px-6 py-4 flex items-center gap-3">
        <span className="text-xl">🎬</span>
        <h1 className="text-slate-100 font-semibold tracking-tight">Memory Archiver</h1>
        <span className="text-slate-600 text-xs ml-auto flex items-center gap-2">
          H.265 · {'{Fam|Vault}'} · {isHub ? 'Synology DS423+' : 'Synology DS220+'}
          <span className="text-slate-600">·</span>
          <span className={`${priceTrendProps.className} text-base`} style={{ fontSize: '1.2em' }}>
            {priceTrendProps.arrow}
          </span>
          <span
            className={`${currentPriceClass} text-base`}
            style={{
              fontSize: '1.2em',
              ...(currentPriceFlashing ? { animation: 'blink 1s step-start infinite' } : {}),
            }}
          >
            {currentPrice != null ? `${currentPrice.toFixed(1)}¢` : '—'}
          </span>
          <span className={`${avgTrendProps.className} text-base`} style={{ fontSize: '1.2em' }}>
            {avgTrendProps.arrow}
          </span>
          <span
            className={`${hourlyAvgClass} text-base`}
            style={hourlyAvgFlashing ? { animation: 'blink 1s step-start infinite' } : undefined}
          >
            {hourlyAvg != null ? `${hourlyAvg.toFixed(1)}¢` : '—'}
          </span>
          <button
            onClick={refreshComed}
            className={`text-slate-500 hover:text-slate-300 transition-colors leading-none${comedLoading ? ' opacity-50' : ''}`}
            disabled={comedLoading}
            aria-label="Refresh ComEd price"
          >↻</button>
          {isTesla && (
            <button
              onClick={() => setSettingsOpen(true)}
              className="ml-2 rounded-lg border border-slate-700 px-2.5 py-1 text-slate-300 transition-colors hover:border-slate-500 hover:text-slate-100"
              aria-label="Tesla settings"
            >
              Settings
            </button>
          )}
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
            {probeError && (
              <p className="mt-2 text-red-400 text-xs">{probeError}</p>
            )}
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
              <EncoderSettings />
            </>
          )}

          {/* Hub tab */}
          {isHub && activeTab === 'hub' && (
            <HubPanel />
          )}

          {isCa && activeTab === 'ca' && (
            <CaPanel />
          )}

          {/* Coop tab */}
          {isCoop && activeTab === 'coop' && (
            <CoopPanel />
          )}

          {isTesla && activeTab === 'garage' && (
            <GaragePanel />
          )}

          {isTesla && activeTab === 'tesla' && (
            <TeslaPanel />
          )}

          {isAudio && activeTab === 'audio' && (
            <AudioTab />
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

      {settingsOpen && isTesla && (
        <TeslaSettingsModal onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
