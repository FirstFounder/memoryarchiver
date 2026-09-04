import { useState } from 'react';
import { submitJob } from '../api/jobs.js';
import { useJobStore } from '../store/jobStore.js';
import { useAppConfigStore } from '../store/appConfigStore.js';

/** "1 AM" / "11 PM" from a 24-hour hour number. */
function formatHour(hour) {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${hour < 12 ? 'AM' : 'PM'}`;
}

/**
 * Form for tagging a batch of source files and adding the job to the queue.
 *
 * Props:
 *   files      — array of file metadata objects (tempPath or path, plus probed info)
 *   onSuccess  — called with { jobId, outputFilename } after a successful submit
 *   onClear    — called to reset the file selection in the parent
 */
export function JobForm({ files, onSuccess, onClear }) {
  const upsertJob = useJobStore(s => s.upsertJob);
  const nightQueue = useAppConfigStore(s => s.nightQueue);

  const [shortDesc,  setShortDesc]  = useState('');
  const [longDesc,   setLongDesc]   = useState('');
  const [outputDest, setOutputDest] = useState('fam');
  const [schedule,   setSchedule]   = useState('night');
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState(null);
  const [preview,    setPreview]    = useState(null);

  const canSubmit = files.length > 0 && shortDesc.trim().length > 0 && !submitting;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const payload = {
        files:      files.map((f, idx) => ({
          path:      f.tempPath ?? f.path,
          duration:  f.duration  ?? undefined,
          width:     f.width     ?? undefined,
          height:    f.height    ?? undefined,
          fps:       f.fps       ?? undefined,
          createdTs: f.createdTs ?? undefined,
        })),
        shortDesc:  shortDesc.trim(),
        longDesc:   longDesc.trim(),
        outputDest,
        schedule,
      };
      const result = await submitJob(payload);
      setPreview({ filename: result.outputFilename, night: result.scheduledLabel });
      // Immediately seed the store so the card renders before the first SSE event
      upsertJob({
        id:              result.jobId,
        status:          result.status,
        scheduled_for:   result.scheduledFor,
        output_filename: result.outputFilename,
        short_desc:      shortDesc.trim(),
        long_desc:       longDesc.trim(),
        output_dest:     outputDest,
        progress:        0,
        created_at:      Math.floor(Date.now() / 1000),
      });
      onSuccess?.(result);
      onClear?.();
      setShortDesc('');
      setLongDesc('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 mt-4">
      {/* Short description */}
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">
          Short Description <span className="text-slate-600">(used in filename)</span>
        </label>
        <input
          type="text"
          maxLength={100}
          value={shortDesc}
          onChange={e => setShortDesc(e.target.value)}
          placeholder="e.g. Easter Hunt"
          className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
        />
      </div>

      {/* Long description */}
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">
          Notes <span className="text-slate-600">(stored as MP4 comment metadata)</span>
        </label>
        <textarea
          maxLength={500}
          rows={2}
          value={longDesc}
          onChange={e => setLongDesc(e.target.value)}
          placeholder="e.g. Easter morning egg hunt in the backyard, 2026"
          className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors resize-none"
        />
      </div>

      {/* Destination toggle */}
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-2">Destination</label>
        <div className="flex rounded-lg overflow-hidden border border-slate-600 w-fit">
          {['fam', 'vault'].map(dest => (
            <button
              key={dest}
              type="button"
              onClick={() => setOutputDest(dest)}
              className={`px-5 py-1.5 text-sm font-medium transition-colors ${
                outputDest === dest
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {dest === 'fam' ? 'Fam' : 'Vault'}
            </button>
          ))}
        </div>
      </div>

      {/* When to encode */}
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-2">Encode</label>
        <div className="flex rounded-lg overflow-hidden border border-slate-600 w-fit">
          {[
            { value: 'night', label: 'Tonight' },
            { value: 'now',   label: 'Now' },
          ].map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setSchedule(opt.value)}
              className={`px-5 py-1.5 text-sm font-medium transition-colors ${
                schedule === opt.value
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-slate-600 text-xs mt-1.5">
          {schedule === 'night'
            ? `Runs overnight from ${formatHour(nightQueue.startHour)}, ${nightQueue.perNight} jobs per night.`
            : 'Starts as soon as the encoder is free.'}
        </p>
      </div>

      {/* Preview */}
      {files.length > 0 && (
        <p className="text-slate-500 text-xs">
          {files.length} clip{files.length > 1 ? 's' : ''} → encoded as one file
        </p>
      )}

      {/* Last queued filename */}
      {preview && (
        <p className="text-green-400 text-xs font-mono break-all">
          ✓ {preview.night ? `Scheduled ${preview.night}` : 'Queued'}: {preview.filename}
        </p>
      )}

      {/* Error */}
      {error && (
        <p className="text-red-400 text-xs">{error}</p>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {submitting
          ? 'Adding to queue…'
          : schedule === 'night' ? 'Schedule for Tonight' : 'Add to Queue'}
      </button>
    </form>
  );
}
