import { useCallback, useEffect, useRef, useState } from 'react';
import { getActiveRide, getLegs, getConfig, startRide, finishRide, updateRide } from '../../api/maeving.js';
import { SOCRoller } from '../tesla/SOCRoller.jsx';
import { isMobile } from '../../lib/isMobile.js';

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
  const [stopping, setStopping] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState('');
  const [startSoc, setStartSoc] = useState(50);
  const [endSoc, setEndSoc] = useState(50);
  const timerRef = useRef(null);

  // Post-stop state
  const [stopped, setStopped] = useState(false);
  const [frozenElapsed, setFrozenElapsed] = useState('0:00');
  const [windbreaker, setWindbreaker] = useState(false);
  const [overheatOpen, setOverheatOpen] = useState(false);
  const [sportyOpen, setSportyOpen] = useState(false);
  const [overheatPack, setOverheatPack] = useState(true);
  const [overheatMotor, setOverheatMotor] = useState(false);
  const [overheatLevel, setOverheatLevel] = useState(2);
  const [sportyLevel, setSportyLevel] = useState(null);

  function resetMetadata() {
    setStopped(false);
    setWindbreaker(false);
    setOverheatOpen(false);
    setSportyOpen(false);
    setOverheatPack(true);
    setOverheatMotor(false);
    setOverheatLevel(2);
    setSportyLevel(null);
  }

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

  async function handleStop() {
    if (!activeRide || stopping) return;
    setStopping(true);
    setError('');
    try {
      await finishRide(activeRide.id, { end_soc_pct: endSoc });
      setFrozenElapsed(elapsed);
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setStopped(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setStopping(false);
    }
  }

  async function handleFinish() {
    if (!activeRide || finishing) return;
    setFinishing(true);
    setError('');
    try {
      const payload = {};
      payload.windbreaker = windbreaker ? 1 : null;
      if (overheatOpen) {
        payload.overheat_pack  = overheatPack  ? 1 : 0;
        payload.overheat_motor = overheatMotor ? 1 : 0;
        payload.overheat_level = overheatLevel;
      }
      if (sportyLevel !== null) payload.sporty_level = sportyLevel;
      await updateRide(activeRide.id, payload);
      setActiveRide(null);
      setUiState('idle');
      setSelectedLegId('');
      resetMetadata();
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

  // State C — active ride
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
            <p className="text-sm text-slate-400 mt-1">
              {stopped ? frozenElapsed : elapsed} elapsed
            </p>
          </div>

          {!stopped ? (
            <>
              <div className="mb-3">
                <SOCRoller min={0} max={100} value={endSoc} onChange={setEndSoc} label="Ending SOC" />
              </div>
              <button
                type="button"
                onClick={handleStop}
                disabled={stopping}
                className="flex min-h-[72px] w-full flex-col items-center justify-center rounded-[2rem] bg-red-700 px-6 py-5 text-white transition-colors hover:bg-red-600 disabled:opacity-60"
              >
                <span className="text-xl font-bold">
                  {stopping ? 'Stopping…' : 'Stop'}
                </span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={handleFinish}
                disabled={finishing}
                className="flex min-h-[56px] w-full items-center justify-center rounded-[2rem] bg-red-700 px-6 py-4 text-white transition-colors hover:bg-red-600 disabled:opacity-60"
              >
                <span className="text-lg font-bold">
                  {finishing ? 'Finishing…' : 'Finish'}
                </span>
              </button>

              <div className="mt-4">
                {/* Windbreaker */}
                <label className="flex items-center gap-3 py-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={windbreaker}
                    onChange={e => setWindbreaker(e.target.checked)}
                    className="h-5 w-5 accent-blue-500"
                  />
                  <span className="text-sm text-slate-200">Windbreaker</span>
                </label>

                {/* Overheat + Sporty buttons */}
                <div className="flex gap-3 mt-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (sportyOpen) setSportyOpen(false);
                      setOverheatOpen(prev => !prev);
                    }}
                    className={`bg-orange-700 hover:bg-orange-600 text-white text-sm font-medium px-4 py-2 rounded-xl transition-colors${overheatOpen ? ' ring-1 ring-orange-500' : ''}`}
                  >
                    Overheat
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (overheatOpen) setOverheatOpen(false);
                      setSportyOpen(prev => !prev);
                    }}
                    className={`text-sm font-medium px-4 py-2 rounded-xl transition-colors bg-slate-200 hover:bg-white text-slate-800${sportyOpen ? ' ring-1 ring-blue-400' : ''}`}
                  >
                    {sportyLevel !== null ? `Sporty (${sportyLevel})` : 'Sporty'}
                  </button>
                </div>

                {/* Overheat expanded panel */}
                {overheatOpen && (
                  <div className="mt-3 flex flex-col gap-3">
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={overheatPack}
                          onChange={e => {
                            if (!e.target.checked && !overheatMotor) return;
                            setOverheatPack(e.target.checked);
                          }}
                          className="h-4 w-4 accent-orange-500"
                        />
                        <span className="text-sm text-slate-200">Pack</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={overheatMotor}
                          onChange={e => {
                            if (!e.target.checked && !overheatPack) return;
                            setOverheatMotor(e.target.checked);
                          }}
                          className="h-4 w-4 accent-orange-500"
                        />
                        <span className="text-sm text-slate-200">Motor</span>
                      </label>
                    </div>
                    <div className="flex gap-2">
                      {[1, 2, 3].map(level => (
                        <button
                          key={level}
                          type="button"
                          onClick={() => setOverheatLevel(level)}
                          className={`px-3 py-1 rounded-full text-sm transition-colors${
                            overheatLevel === level
                              ? ' bg-orange-600 text-white'
                              : ' border border-slate-600 text-slate-400'
                          }`}
                        >
                          {level}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Sporty expanded panel */}
                {sportyOpen && (
                  <div className="mt-3 flex gap-2">
                    {[1, 2, 3].map(level => (
                      <button
                        key={level}
                        type="button"
                        onClick={() => setSportyLevel(level)}
                        className={`px-3 py-1 rounded-full text-sm transition-colors${
                          sportyLevel === level
                            ? ' bg-blue-600 text-white'
                            : ' border border-slate-600 text-slate-400'
                        }`}
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    );
  }

  // State B — leg selector with Starting SOC roller
  const selectedLeg = legs.find(l => String(l.id) === String(selectedLegId));
  if (uiState === 'selecting') {
    const mobile = isMobile();
    return (
      <div className="mx-auto w-full max-w-5xl">
        <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
          {/* Leg select row — full width on both mobile and desktop */}
          <div className="relative w-full">
            <select
              className="w-full min-h-[56px] appearance-none rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] pl-4 pr-10 text-base text-slate-200 focus:outline-none"
              value={selectedLegId}
              onChange={e => setSelectedLegId(e.target.value)}
            >
              <option value="">Select Leg</option>
              {legs.map(leg => (
                <option key={leg.id} value={leg.id}>
                  {leg.description} ({leg.distance_miles} mi)
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">▾</span>
          </div>
          {mobile ? (
            /* Mobile: three-column layout — SOC roller | Start | Cancel */
            <div className="mt-2 flex gap-2">
              <div className="w-1/3 overflow-hidden">
                <div className="scale-75 origin-top-left">
                  <SOCRoller min={0} max={100} value={startSoc} onChange={setStartSoc} label="Starting SOC" />
                </div>
              </div>
              <button
                type="button"
                onClick={handleGo}
                disabled={!selectedLegId || starting}
                className="w-1/3 min-h-[180px] flex flex-col items-center justify-center rounded-[2rem] bg-green-700 px-4 py-5 text-white transition-colors hover:bg-green-600 disabled:opacity-60"
              >
                <span className="text-xl font-bold">
                  {starting ? 'Starting…' : 'Start'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => { setUiState('idle'); setSelectedLegId(''); setError(''); }}
                className="w-1/3 min-h-[180px] flex flex-col items-center justify-center rounded-[2rem] border border-[color:var(--color-border)] bg-transparent px-4 py-5 text-slate-400 transition-colors hover:border-slate-500"
              >
                <span className="text-base font-medium">Cancel</span>
              </button>
            </div>
          ) : (
            /* Desktop: Cancel appended to select row, then full-width Start button below */
            <>
              <div className="mt-2 flex">
                <div className="relative flex-1">
                  {/* cancel lives beside select on desktop */}
                </div>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => { setUiState('idle'); setSelectedLegId(''); setError(''); }}
                  className="rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 min-h-[56px] text-sm text-slate-400 transition-colors hover:border-slate-500"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleGo}
                  disabled={!selectedLegId || starting}
                  className="flex-1 flex min-h-[72px] items-center justify-center rounded-[2rem] bg-green-700 px-6 py-5 text-xl font-bold text-white transition-colors hover:bg-green-600 disabled:opacity-60"
                >
                  {starting ? 'Starting…' : 'Start'}
                </button>
              </div>
              <div className="mt-4">
                <SOCRoller min={0} max={100} value={startSoc} onChange={setStartSoc} label="Starting SOC" />
              </div>
            </>
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
