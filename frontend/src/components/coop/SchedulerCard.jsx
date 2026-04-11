import { schedulerStart, schedulerStop } from '../../api/coop.js';
import { useCoopStore } from '../../store/coopStore.js';

function formatTime12(timeStr) {
  // "08:00" → "8:00 AM", "19:00" → "7:00 PM"
  if (!timeStr) return null;
  const [hStr, mStr] = timeStr.split(':');
  const h = parseInt(hStr, 10);
  const m = mStr ?? '00';
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${suffix}`;
}

function formatTimestamp(isoString) {
  if (!isoString) return null;
  const d = new Date(isoString);
  return d.toLocaleString('en-US', {
    timeZone:     'America/Chicago',
    month:        'short',
    day:          'numeric',
    hour:         'numeric',
    minute:       '2-digit',
    hour12:       true,
    timeZoneName: 'short',
  });
}

function SchedulerBadge({ schedulerActive }) {
  if (schedulerActive === true) {
    return (
      <span className="px-3 py-1 rounded-full text-sm font-semibold bg-green-900/50 text-green-400">
        SCHEDULE ACTIVE
      </span>
    );
  }
  if (schedulerActive === false) {
    return (
      <span className="px-3 py-1 rounded-full text-sm font-semibold bg-amber-900/50 text-amber-300">
        SCHEDULE OFF
      </span>
    );
  }
  return (
    <span className="px-3 py-1 rounded-full text-sm font-semibold bg-slate-800 text-slate-500">
      UNKNOWN
    </span>
  );
}

function LastCheckFooter({ lastCheck }) {
  if (!lastCheck) return null;

  const ts = formatTimestamp(lastCheck.checkedAt);

  let detail;
  if (lastCheck.janusError) {
    detail = 'janus unreachable — alert sent';
  } else if (lastCheck.mismatch) {
    detail = `expected ${lastCheck.expectedState}, got ${lastCheck.actualState}${lastCheck.alertSent ? ' — alert sent' : ''}`;
  } else {
    detail = `door was ${lastCheck.actualState} ✓`;
  }

  return (
    <p className="text-xs text-slate-500 mt-2">
      Last check: {ts} · {detail}
    </p>
  );
}

export function SchedulerCard() {
  const schedulerActive = useCoopStore(s => s.schedulerActive);
  const openAt          = useCoopStore(s => s.openAt);
  const closeAt         = useCoopStore(s => s.closeAt);
  const lastCheck       = useCoopStore(s => s.lastCheck);
  const applyStatus     = useCoopStore(s => s.applyStatus);

  async function handleStart() {
    try {
      const result = await schedulerStart();
      applyStatus(result);
    } catch {
      applyStatus({ error: 'unreachable' });
    }
  }

  async function handleStop() {
    try {
      const result = await schedulerStop();
      applyStatus(result);
    } catch {
      applyStatus({ error: 'unreachable' });
    }
  }

  return (
    <div className="flex-1 bg-slate-900 border border-slate-700 rounded-xl p-5 flex flex-col gap-4">
      <h3 className="text-slate-200 font-semibold text-sm">Scheduler</h3>

      {/* Scheduler badge */}
      <SchedulerBadge schedulerActive={schedulerActive} />

      {/* Toggle button */}
      {schedulerActive === false && (
        <button
          onClick={handleStart}
          className="text-sm px-3 py-2 rounded-lg bg-green-900/40 border border-green-800 text-green-300 hover:bg-green-900/60 transition-colors"
        >
          Start Schedule
        </button>
      )}
      {schedulerActive === true && (
        <button
          onClick={handleStop}
          className="text-sm px-3 py-2 rounded-lg bg-amber-900/40 border border-amber-800 text-amber-300 hover:bg-amber-900/60 transition-colors"
        >
          Stop Schedule
        </button>
      )}

      {/* Schedule times */}
      <div className="text-sm space-y-1">
        <div className={openAt ? 'text-slate-300' : 'text-slate-600'}>
          Opens:&nbsp;&nbsp; {formatTime12(openAt) ?? '—'}
        </div>
        <div className={closeAt ? 'text-slate-300' : 'text-slate-600'}>
          Closes: {formatTime12(closeAt) ?? '—'}
        </div>
      </div>

      {/* Last check footer */}
      <LastCheckFooter lastCheck={lastCheck} />
    </div>
  );
}
