import { useEffect, useRef, useState } from 'react';
import { getCoopStatus, coopOpen, coopClose } from '../../api/coop.js';
import { useCoopStore } from '../../store/coopStore.js';

function formatTimestamp(date) {
  if (!date) return null;
  return date.toLocaleString('en-US', {
    timeZone:    'America/Chicago',
    month:       'short',
    day:         'numeric',
    hour:        'numeric',
    minute:      '2-digit',
    hour12:      true,
    timeZoneName: 'short',
  });
}

function StateBadge({ doorState, unreachable }) {
  if (unreachable) {
    return (
      <span className="px-3 py-1 rounded-full text-sm font-semibold bg-red-900/50 text-red-400">
        UNREACHABLE
      </span>
    );
  }
  if (doorState === 'open') {
    return (
      <span className="px-3 py-1 rounded-full text-sm font-semibold bg-green-900/50 text-green-400">
        OPEN
      </span>
    );
  }
  if (doorState === 'closed') {
    return (
      <span className="px-3 py-1 rounded-full text-sm font-semibold bg-amber-900/50 text-amber-300">
        CLOSED
      </span>
    );
  }
  if (doorState === 'moving') {
    return (
      <span className="animate-pulse px-3 py-1 rounded-full text-sm font-semibold bg-sky-900/50 text-sky-300">
        MOVING…
      </span>
    );
  }
  return (
    <span className="px-3 py-1 rounded-full text-sm font-semibold bg-slate-800 text-slate-500">
      UNKNOWN
    </span>
  );
}

export function DoorCard() {
  const doorState      = useCoopStore(s => s.doorState);
  const unreachable    = useCoopStore(s => s.unreachable);
  const lastPolledAt   = useCoopStore(s => s.lastPolledAt);
  const isMoving       = useCoopStore(s => s.isMoving);
  const moveAction     = useCoopStore(s => s.moveAction);
  const moveStartedAt  = useCoopStore(s => s.moveStartedAt);
  const applyStatus    = useCoopStore(s => s.applyStatus);
  const startMove      = useCoopStore(s => s.startMove);
  const clearMove      = useCoopStore(s => s.clearMove);

  const [elapsed, setElapsed] = useState(0);
  const timerRef  = useRef(null);
  const poll45Ref = useRef(null);
  const poll95Ref = useRef(null);

  // Elapsed timer when moving
  useEffect(() => {
    if (isMoving && moveStartedAt) {
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - moveStartedAt.getTime()) / 1000));
      }, 1000);
    } else {
      clearInterval(timerRef.current);
      setElapsed(0);
    }
    return () => clearInterval(timerRef.current);
  }, [isMoving, moveStartedAt]);

  // Clear post-action poll timeouts on unmount
  useEffect(() => {
    return () => {
      clearTimeout(poll45Ref.current);
      clearTimeout(poll95Ref.current);
    };
  }, []);

  function schedulePostActionPolls() {
    clearTimeout(poll45Ref.current);
    clearTimeout(poll95Ref.current);
    poll45Ref.current = setTimeout(() => {
      getCoopStatus().then(applyStatus).catch(() => applyStatus({ error: 'unreachable' }));
    }, 45_000);
    poll95Ref.current = setTimeout(() => {
      getCoopStatus()
        .then(applyStatus)
        .catch(() => applyStatus({ error: 'unreachable' }))
        .finally(() => clearMove());
    }, 95_000);
  }

  async function handleCheckStatus() {
    try {
      const status = await getCoopStatus();
      applyStatus(status);
    } catch {
      applyStatus({ error: 'unreachable' });
    }
  }

  async function handleOpen() {
    try {
      const result = await coopOpen();
      applyStatus(result);
      if (!result?.error) {
        startMove('open');
        schedulePostActionPolls();
      }
    } catch {
      applyStatus({ error: 'unreachable' });
    }
  }

  async function handleClose() {
    try {
      const result = await coopClose();
      applyStatus(result);
      if (!result?.error) {
        startMove('close');
        schedulePostActionPolls();
      }
    } catch {
      applyStatus({ error: 'unreachable' });
    }
  }

  return (
    <div className="flex-1 bg-slate-900 border border-slate-700 rounded-xl p-5 flex flex-col gap-4">
      <h3 className="text-slate-200 font-semibold text-sm">Door</h3>

      {/* State badge */}
      <div className="flex flex-col gap-1">
        <StateBadge doorState={doorState} unreachable={unreachable} />
        {lastPolledAt && (
          <span className="text-xs text-slate-500">
            Last checked: {formatTimestamp(lastPolledAt)}
          </span>
        )}
      </div>

      {/* Moving indicator */}
      {isMoving && (
        <div className="bg-sky-900/20 border border-sky-800/40 rounded-lg px-3 py-2 text-sm text-sky-300">
          {moveAction === 'open' ? 'Opening…' : 'Closing…'}
          <span className="ml-2 text-sky-500 tabular-nums">{elapsed}s</span>
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-col gap-2">
        <button
          onClick={handleCheckStatus}
          disabled={isMoving}
          className="text-sm px-3 py-2 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-slate-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Check Status
        </button>
        <div className="flex gap-2">
          <button
            onClick={handleOpen}
            disabled={isMoving || doorState === 'open'}
            className="flex-1 text-sm px-3 py-2 rounded-lg bg-green-900/40 border border-green-800 text-green-300 hover:bg-green-900/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Open Door
          </button>
          <button
            onClick={handleClose}
            disabled={isMoving || doorState === 'closed'}
            className="flex-1 text-sm px-3 py-2 rounded-lg bg-amber-900/40 border border-amber-800 text-amber-300 hover:bg-amber-900/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Close Door
          </button>
        </div>
      </div>
    </div>
  );
}
