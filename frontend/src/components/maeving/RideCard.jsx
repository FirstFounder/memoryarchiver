import { useCallback, useEffect, useRef, useState } from 'react';
import { getActiveRide, getLegs, startRide, finishRide } from '../../api/maeving.js';

function getElapsed(startedAt) {
  const ms = Date.now() - new Date(startedAt).getTime();
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

export function RideCard() {
  // 'loading' | 'idle' | 'selecting' | 'active'
  const [uiState, setUiState] = useState('loading');
  const [activeRide, setActiveRide] = useState(null);
  const [legs, setLegs] = useState([]);
  const [selectedLegId, setSelectedLegId] = useState('');
  const [elapsed, setElapsed] = useState('0:00');
  const [starting, setStarting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState('');
  const timerRef = useRef(null);

  // Manage the live elapsed timer
  useEffect(() => {
    if (!activeRide) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }
    setElapsed(getElapsed(activeRide.started_at));
    timerRef.current = setInterval(
      () => setElapsed(getElapsed(activeRide.started_at)),
      1000,
    );
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  }, [activeRide?.id]);

  const syncRide = useCallback(async () => {
    try {
      const ride = await getActiveRide();
      if (ride) {
        setActiveRide(ride);
        setUiState('active');
      } else {
        setActiveRide(null);
        setUiState(prev => (prev === 'active' || prev === 'loading') ? 'idle' : prev);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    getLegs().then(setLegs).catch(() => {});
    syncRide();
    const poll = setInterval(syncRide, 30_000);
    return () => {
      clearInterval(poll);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [syncRide]);

  async function handleGo() {
    if (!selectedLegId || starting) return;
    setStarting(true);
    setError('');
    try {
      const ride = await startRide({ trip_id: Number(selectedLegId) });
      setActiveRide(ride);
      setUiState('active');
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  }

  async function handleFinish() {
    if (!activeRide || finishing) return;
    setFinishing(true);
    setError('');
    try {
      await finishRide(activeRide.id);
      setActiveRide(null);
      setUiState('idle');
      setSelectedLegId('');
    } catch (err) {
      setError(err.message);
    } finally {
      setFinishing(false);
    }
  }

  if (uiState === 'loading') return null;

  if (uiState === 'active' && activeRide) {
    return (
      <div className="mx-auto w-full max-w-5xl">
        <section className="rounded-[2rem] border border-emerald-700/60 bg-emerald-950/20 p-5 sm:p-6">
          <p className="mb-4 text-sm font-semibold uppercase tracking-[0.28em] text-emerald-400">
            Ride in Progress
          </p>
          <div className="mb-4 rounded-2xl border border-emerald-800/40 bg-emerald-900/10 px-4 py-3">
            <p className="text-sm font-semibold text-slate-100">{activeRide.trip_name}</p>
            <p className="mt-0.5 text-sm text-emerald-300">{elapsed} elapsed</p>
          </div>
          {error && (
            <div className="mb-3 rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}
          <button
            type="button"
            onClick={handleFinish}
            disabled={finishing}
            className="min-h-12 w-full rounded-2xl border border-red-700/60 bg-red-900/30 px-6 text-base font-semibold text-red-300 transition-colors hover:bg-red-900/60 disabled:opacity-60"
          >
            {finishing ? 'Finishing…' : 'Finish ■'}
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
        <p className="mb-4 text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">
          New Ride
        </p>
        {uiState === 'idle' ? (
          <button
            type="button"
            onClick={() => { setUiState('selecting'); setError(''); }}
            className="rounded-xl border border-[color:var(--color-border)] px-4 py-2 text-sm text-slate-300 transition-colors hover:border-slate-500"
          >
            New Ride ▶
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <select
              className="flex-1 rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-3 py-2 text-sm text-slate-200 focus:outline-none"
              value={selectedLegId}
              onChange={e => setSelectedLegId(e.target.value)}
            >
              <option value="">— select leg —</option>
              {legs.map(leg => (
                <option key={leg.id} value={leg.id}>
                  {leg.description} ({leg.distance_miles} mi)
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleGo}
              disabled={!selectedLegId || starting}
              className="rounded-xl bg-[color:var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[color:var(--color-accent-hover)] disabled:opacity-60"
            >
              {starting ? 'Starting…' : 'Go ▶'}
            </button>
            <button
              type="button"
              onClick={() => { setUiState('idle'); setSelectedLegId(''); setError(''); }}
              className="rounded-xl border border-[color:var(--color-border)] px-3 py-2 text-sm text-slate-400 transition-colors hover:border-slate-500"
            >
              ✕
            </button>
          </div>
        )}
        {error && (
          <div className="mt-3 rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}
      </section>
    </div>
  );
}
