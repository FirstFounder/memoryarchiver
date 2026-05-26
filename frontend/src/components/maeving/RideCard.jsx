import { useCallback, useEffect, useRef, useState } from 'react';
import { getActiveRide, getLegs, getConfig, startRide, finishRide } from '../../api/maeving.js';
import { SOCRoller } from '../tesla/SOCRoller.jsx';

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
  const [startSoc, setStartSoc] = useState(50);
  const [endSoc, setEndSoc] = useState(50);
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
        setEndSoc(ride.start_soc_pct ?? 50);
        setUiState('active');
      } else {
        setActiveRide(null);
        setUiState(prev => (prev === 'active' || prev === 'loading') ? 'idle' : prev);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    getLegs().then(setLegs).catch(() => {});
    getConfig().then((cfg) => {
      setStartSoc(cfg.prev_max_soc_pct ?? 50);
    }).catch(() => {});
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
      const ride = await startRide({ trip_id: Number(selectedLegId), start_soc_pct: startSoc });
      setActiveRide(ride);
      setEndSoc(startSoc);
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
      await finishRide(activeRide.id, { end_soc_pct: endSoc });
      setActiveRide(null);
      setUiState('idle');
      setSelectedLegId('');
      // Reload config so startSoc reflects the updated prev_max_soc_pct
      getConfig().then((cfg) => {
        setStartSoc(cfg.prev_max_soc_pct ?? 50);
      }).catch(() => {});
    } catch (err) {
      setError(err.message);
    } finally {
      setFinishing(false);
    }
  }

  if (uiState === 'loading') return null;

  // State C — card with Ending SOC roller + Finish button
  if (uiState === 'active' && activeRide) {
    return (
      <div className="mx-auto w-full max-w-5xl">
        {error && (
          <div className="mb-2 rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}
        <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
          <div className="mb-4 text-center">
            <p className="text-xl font-bold text-slate-100">{activeRide.trip_name}</p>
            <p className="text-sm text-slate-400 mt-1">{elapsed} elapsed</p>
          </div>
          <SOCRoller min={0} max={100} value={endSoc} onChange={setEndSoc} label="Ending SOC" />
          <button
            type="button"
            onClick={handleFinish}
            disabled={finishing}
            className="mt-4 flex min-h-[72px] w-full flex-col items-center justify-center rounded-[2rem] bg-red-700 px-6 py-5 text-white transition-colors hover:bg-red-600 disabled:opacity-60"
          >
            <span className="text-xl font-bold">
              {finishing ? 'Finishing…' : 'Finish Ride'}
            </span>
          </button>
        </section>
      </div>
    );
  }

  // State B — leg selector with Starting SOC roller
  if (uiState === 'selecting') {
    return (
      <div className="mx-auto w-full max-w-5xl">
        <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
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
          <div className="mt-4">
            <SOCRoller min={0} max={100} value={startSoc} onChange={setStartSoc} label="Starting SOC" />
          </div>
          {error && (
            <div className="mt-3 rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}
        </section>
      </div>
    );
  }

  // State A — full-card green button (idle)
  return (
    <div className="mx-auto w-full max-w-5xl">
      <button
        type="button"
        onClick={() => { setUiState('selecting'); setError(''); }}
        className="flex min-h-[80px] w-full items-center justify-center rounded-[2rem] bg-green-700 px-6 py-5 text-xl font-bold text-white transition-colors hover:bg-green-600"
      >
        New Ride
      </button>
    </div>
  );
}
