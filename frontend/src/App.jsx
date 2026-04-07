import { useState, useEffect } from 'react';
import { useSSE } from './hooks/useSSE.js';
import { DropZone } from './components/DropZone.jsx';
import { FileBrowser } from './components/FileBrowser.jsx';
import { FileList } from './components/FileList.jsx';
import { JobForm } from './components/JobForm.jsx';
import { JobQueue } from './components/JobQueue.jsx';
import { SyncQueue } from './components/SyncQueue.jsx';
import { getAppConfig } from './api/appConfig.js';
import { useAppConfigStore } from './store/appConfigStore.js';

export default function App() {
  // Hook the SSE stream for the lifetime of the app
  useSSE();

  // Fetch server config once on mount and populate the store
  const setConfig = useAppConfigStore(s => s.setConfig);
  useEffect(() => {
    getAppConfig().then(setConfig).catch(() => { /* retain defaults on error */ });
  }, []);

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
        <span className="text-slate-600 text-xs ml-auto">
          H.265 · {'{Fam|Vault}'} · Synology DS220+
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

        {/* ── Right panel: encoding queue + sync queue ────────────────────── */}
        <div className="flex-1 p-6 overflow-y-auto flex flex-col">
          <JobQueue />
          <SyncQueue />
          {/* Hub-only panels (push sync, NFS status) mount here when deviceRole === 'hub' */}
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
