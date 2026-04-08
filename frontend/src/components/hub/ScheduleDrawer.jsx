import { useState } from 'react';
import { patchDestination } from '../../api/hub.js';

const PRESETS = [
  { label: 'Nightly at 11:30 PM',        cron: '30 23 * * *' },
  { label: 'Weekly — Sunday at 11:30 PM', cron: '30 23 * * 0' },
  { label: 'Monthly — 1st at 11:30 PM',   cron: '30 23 1 * *' },
  { label: 'Manual only',                  cron: null           },
];

function matchPreset(cron) {
  return PRESETS.find(p => p.cron === cron) ?? null;
}

export function ScheduleDrawer({ destination, onClose, onSaved }) {
  const preset      = matchPreset(destination.schedule);
  const isEditable  = preset !== null;

  // Selected preset value: the cron string (or null for "manual only")
  const [selectedCron, setSelectedCron] = useState(destination.schedule);
  const [bwlimit, setBwlimit]           = useState(destination.bwlimit ?? '');
  const [saving, setSaving]             = useState(false);
  const [error, setError]               = useState(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const isManual = selectedCron === null;
      const body = {
        enabled:  !isManual,
        schedule: isManual ? destination.schedule : selectedCron,
        bwlimit:  bwlimit === '' ? null : Number(bwlimit),
      };
      await patchDestination(destination.id, body);
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
      />

      {/* Slide-over panel */}
      <div className="fixed inset-y-0 right-0 z-50 w-80 bg-slate-900 border-l border-slate-700 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h3 className="text-slate-100 font-semibold text-sm">
            Schedule — {destination.hostname}
          </h3>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-300 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {/* Schedule */}
          <div className="space-y-2">
            <label className="text-slate-400 text-xs font-medium uppercase tracking-wide">
              Schedule
            </label>

            {isEditable ? (
              <select
                value={selectedCron ?? '__manual__'}
                onChange={e => {
                  const v = e.target.value;
                  setSelectedCron(v === '__manual__' ? null : v);
                }}
                className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
              >
                {PRESETS.map(p => (
                  <option key={p.label} value={p.cron ?? '__manual__'}>
                    {p.label}
                  </option>
                ))}
              </select>
            ) : (
              <div className="space-y-1">
                <div className="w-full bg-slate-800 border border-slate-700 text-slate-500 text-sm rounded-lg px-3 py-2">
                  Custom
                </div>
                <p className="text-slate-600 text-xs font-mono px-1">
                  {destination.schedule}
                </p>
              </div>
            )}
          </div>

          {/* Bandwidth limit */}
          <div className="space-y-2">
            <label className="text-slate-400 text-xs font-medium uppercase tracking-wide">
              Bandwidth limit
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                value={bwlimit}
                onChange={e => setBwlimit(e.target.value)}
                placeholder="Uncapped"
                className="flex-1 bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 placeholder-slate-600"
              />
              <span className="text-slate-500 text-xs shrink-0">KB/s</span>
            </div>
            <p className="text-slate-600 text-xs">Leave empty to uncap.</p>
          </div>

          {error && (
            <p className="text-red-400 text-xs bg-red-950/40 rounded p-2">{error}</p>
          )}
        </div>

        {/* Footer */}
        {isEditable && (
          <div className="px-5 py-4 border-t border-slate-800 flex justify-end gap-3">
            <button
              onClick={onClose}
              className="text-sm text-slate-400 hover:text-slate-200 px-4 py-2 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="text-sm px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
