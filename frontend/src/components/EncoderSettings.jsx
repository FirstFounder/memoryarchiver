import { useState } from 'react';
import { useAppConfigStore } from '../store/appConfigStore.js';
import { useJobStore } from '../store/jobStore.js';
import { formatNightLong } from '../lib/nightLabel.js';

/** "1 AM" / "11 PM" from a 24-hour hour number. */
function formatHour(hour) {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${hour < 12 ? 'AM' : 'PM'}`;
}

export function EncoderSettings() {
  const squatEnabled = useAppConfigStore(s => s.squatEnabled);
  const squatHost    = useAppConfigStore(s => s.squatHost);
  const squatPort    = useAppConfigStore(s => s.squatPort);
  const squatQuality = useAppConfigStore(s => s.squatQuality);
  const nightQueue   = useAppConfigStore(s => s.nightQueue);
  const jobs         = useJobStore(s => s.jobs);
  const [open, setOpen] = useState(false);

  // Upcoming nights and how many jobs each one holds.
  const nights = new Map();
  for (const job of jobs.values()) {
    if (job.status !== 'scheduled' || !job.scheduled_for) continue;
    nights.set(job.scheduled_for, (nights.get(job.scheduled_for) ?? 0) + 1);
  }
  const upcoming = [...nights.entries()].sort((a, b) => a[0] - b[0]);

  const windowEnd = (nightQueue.startHour + nightQueue.windowHours) % 24;

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
            {squatEnabled ? (
              <>
                <span className="text-slate-500">Host</span>
                <span className="text-slate-300 font-mono">{squatHost}:{squatPort}</span>

                <span className="text-slate-500">Quality (-q:v)</span>
                <span className="text-slate-300 font-mono">{squatQuality}</span>

                <span className="text-slate-500">Codec</span>
                <span className="text-slate-300 font-mono">hevc_videotoolbox</span>
              </>
            ) : (
              <>
                <span className="text-slate-500">Host</span>
                <span className="text-slate-300 font-mono">local</span>

                <span className="text-slate-500">Codec</span>
                <span className="text-slate-300 font-mono">libx265</span>
              </>
            )}

            <span className="text-slate-500">Night window</span>
            <span className="text-slate-300 font-mono">
              {formatHour(nightQueue.startHour)} – {formatHour(windowEnd)}
            </span>

            <span className="text-slate-500">Jobs per night</span>
            <span className="text-slate-300 font-mono">{nightQueue.perNight}</span>
          </div>

          {upcoming.length > 0 && (
            <div className="space-y-1 pt-1 border-t border-slate-700/60">
              {upcoming.map(([night, count]) => (
                <div key={night} className="flex justify-between text-xs">
                  <span className="text-slate-500">{formatNightLong(night, nightQueue.tz)}</span>
                  <span className="text-slate-400 font-mono">
                    {count} / {nightQueue.perNight}
                  </span>
                </div>
              ))}
            </div>
          )}

          <p className="text-slate-600 text-xs leading-relaxed">
            {squatEnabled
              ? 'Higher quality values produce larger files with more detail preserved. 68 is recommended for archival use. Range: 0–100.'
              : `Scheduled jobs start at ${formatHour(nightQueue.startHour)} and run one at a time. Anything still waiting when the window closes rolls to the next night.`}
          </p>
        </div>
      )}
    </div>
  );
}
