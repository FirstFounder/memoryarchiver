/**
 * ProgressSection — sequential (one bar) or parallel (two bars) progress display.
 *
 * Sequential destinations (iolo, jaana, iron):
 *   `progress` is 0–100, already scaled by hub worker.
 *   Fam occupies 0–50, Vault 50–100.
 *
 * Parallel destinations (bang):
 *   `progress` is null; `progressFam` and `progressVault` are independent 0–100.
 *   Detected by checking for non-null progressFam / progressVault.
 */

const PHASE_LABELS = {
  manifest_check:   'Checking for changes…',
  mounting:         'Mounting…',
  rsync_fam:        'Syncing Fam',
  rsync_vault:      'Syncing Vault',
  unmounting:       'Unmounting…',
  writing_manifest: 'Saving manifest…',
  disk_sleep:       'Spinning down disks…',
};

function Bar({ value, color = 'bg-sky-400' }) {
  const pct = Math.min(100, Math.max(0, Math.round(value ?? 0)));
  return (
    <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-300 ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function ProgressSection({ live }) {
  const isParallel =
    live?.progressFam != null || live?.progressVault != null;

  const phaseLabel = PHASE_LABELS[live?.phase] ?? live?.phase ?? '';

  if (isParallel) {
    const famPct   = live?.progressFam   ?? 0;
    const vaultPct = live?.progressVault ?? 0;
    const bothActive = live?.progressFam != null && live?.progressVault != null;

    return (
      <div className="space-y-2">
        <p className="text-slate-400 text-xs">
          {bothActive ? 'Syncing Fam + Vault' : phaseLabel}
        </p>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-slate-500 text-xs w-10 shrink-0">Fam</span>
            <Bar value={famPct} />
            <span className="text-slate-400 text-xs w-8 text-right shrink-0">{famPct}%</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-500 text-xs w-10 shrink-0">Vault</span>
            <Bar value={vaultPct} />
            <span className="text-slate-400 text-xs w-8 text-right shrink-0">{vaultPct}%</span>
          </div>
        </div>
      </div>
    );
  }

  const pct = live?.progress ?? 0;

  return (
    <div className="space-y-1.5">
      <Bar value={pct} />
      <div className="flex justify-between text-xs text-slate-500">
        <span>{phaseLabel}</span>
        <span>{pct}%</span>
      </div>
    </div>
  );
}
