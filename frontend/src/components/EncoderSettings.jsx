import { useState } from 'react';
import { useAppConfigStore } from '../store/appConfigStore.js';

export function EncoderSettings() {
  const squatEnabled = useAppConfigStore(s => s.squatEnabled);
  const squatHost    = useAppConfigStore(s => s.squatHost);
  const squatPort    = useAppConfigStore(s => s.squatPort);
  const squatQuality = useAppConfigStore(s => s.squatQuality);
  const [open, setOpen] = useState(false);

  if (!squatEnabled) return null;

  return (
    <div className="border border-slate-700 rounded-xl overflow-hidden mt-4">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 transition-colors"
      >
        <span className="font-medium">Encoder</span>
        <span className="text-slate-600 text-xs">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-slate-700 bg-slate-800/20">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <span className="text-slate-500">Host</span>
            <span className="text-slate-300 font-mono">{squatHost}:{squatPort}</span>

            <span className="text-slate-500">Quality (-q:v)</span>
            <span className="text-slate-300 font-mono">{squatQuality}</span>

            <span className="text-slate-500">Codec</span>
            <span className="text-slate-300 font-mono">hevc_videotoolbox</span>
          </div>
          <p className="text-slate-600 text-xs leading-relaxed">
            Higher quality values produce larger files with more detail preserved.
            68 is recommended for archival use. Range: 0–100.
          </p>
        </div>
      )}
    </div>
  );
}
