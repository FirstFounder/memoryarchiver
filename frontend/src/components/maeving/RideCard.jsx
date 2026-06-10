import { useCallback, useEffect, useRef, useState } from 'react';
import { getActiveRide, getLegs, getConfig, startRide, finishRide, updateRide, getActiveRideLiveTelemetry } from '../../api/maeving.js';
import { SOCRoller, SOCSelector } from '../tesla/SOCRoller.jsx';
import { isMobile } from '../../lib/isMobile.js';

function windDirLabel(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((deg % 360) + 360) / 45) % 8];
}

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

  const [telemetry, setTelemetry] = useState(null);

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
    if (uiState !== 'active' || isMobile()) return;
    async function pollTelemetry() {
      try {
        const data = await getActiveRideLiveTelemetry();
        setTelemetry(data);
      } catch { /* silent */ }
    }
    pollTelemetry();
    const interval = setInterval(pollTelemetry, 15_000);
    return () => clearInterval(interval);
  }, [uiState]);

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
    const mobile = isMobile();
    return (
      <div className="mx-auto w-full max-w-5xl">
        {error && (
          <div className="mb-2 rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* ── Desktop live dashboard ─────────────────────────────────── */}
        {!mobile && (
          <section className="mb-3 rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-lg font-bold text-slate-100">{activeRide.trip_name}</p>
              <p className="text-sm text-slate-400">{stopped ? frozenElapsed : elapsed} elapsed</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {/* Left column: telemetry stats */}
              <div className="flex flex-col gap-3">
                <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3">
                  <p className="text-xs uppercase tracking-widest text-slate-500 mb-1">Speed</p>
                  <p className="text-2xl font-bold text-slate-100">
                    {telemetry?.ping?.vel != null
                      ? `${Math.round(telemetry.ping.vel)} km/h`
                      : '—'}
                  </p>
                </div>
                <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3">
                  <p className="text-xs uppercase tracking-widest text-slate-500 mb-1">Elevation</p>
                  <p className="text-2xl font-bold text-slate-100">
                    {telemetry?.ping?.alt != null
                      ? `${Math.round(telemetry.ping.alt)} m`
                      : '—'}
                  </p>
                </div>
                <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3">
                  <p className="text-xs uppercase tracking-widest text-slate-500 mb-1">Est. SOC</p>
                  <p className="text-2xl font-bold text-slate-100">
                    {(() => {
                      const startSocPct = telemetry?.start_soc_pct;
                      const avgWhMi = telemetry?.avg_wh_per_mile;
                      const distMi = activeRide?.trip_miles;
                      if (startSocPct == null || avgWhMi == null || !avgWhMi || !distMi) return '—';
                      const pingCount = telemetry?.ping_count ?? 0;
                      if (pingCount < 3) return '—';
                      const effectiveCapWh = 2880;
                      const whForLeg = distMi * avgWhMi;
                      const socDrop = (whForLeg / effectiveCapWh) * 100;
                      const estEndSoc = Math.max(0, startSocPct - socDrop);
                      return `~${Math.round(estEndSoc)}%`;
                    })()}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">at leg end</p>
                </div>
                <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3">
                  <p className="text-xs uppercase tracking-widest text-slate-500 mb-1">Pings</p>
                  <p className="text-2xl font-bold text-slate-100">
                    {telemetry?.ping_count ?? '—'}
                  </p>
                </div>
                <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3">
                  <p className="text-xs uppercase tracking-widest text-slate-500 mb-1">Weather</p>
                  {telemetry?.ping?.temp_f != null ? (
                    <div className="flex flex-col gap-1">
                      <p className="text-xl font-bold text-slate-100">
                        {Math.round(telemetry.ping.temp_f)}°F
                      </p>
                      {telemetry.ping.wind_speed_mph != null && (
                        <p className="text-sm text-slate-300">
                          {Math.round(telemetry.ping.wind_speed_mph)} mph
                          {telemetry.ping.wind_dir_deg != null &&
                            ` ${windDirLabel(telemetry.ping.wind_dir_deg)}`}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-2xl font-bold text-slate-100">—</p>
                  )}
                </div>
              </div>
              {/* Right column: map */}
              <div className="flex flex-col gap-3">
                {telemetry?.ping?.lat != null ? (
                  <>
                    <div className="overflow-hidden rounded-2xl border border-[color:var(--color-border)]" style={{ height: '340px' }}>
                      <iframe
                        key={`${telemetry.ping.lat.toFixed(4)},${telemetry.ping.lon.toFixed(4)}`}
                        title="Current location"
                        src={`https://www.openstreetmap.org/export/embed.html?bbox=${(telemetry.ping.lon - 0.005).toFixed(6)},${(telemetry.ping.lat - 0.003).toFixed(6)},${(telemetry.ping.lon + 0.005).toFixed(6)},${(telemetry.ping.lat + 0.003).toFixed(6)}&layer=mapnik&marker=${telemetry.ping.lat.toFixed(6)},${telemetry.ping.lon.toFixed(6)}`}
                        style={{ border: 'none', width: '100%', height: '100%' }}
                        loading="lazy"
                      />
                    </div>
                    <a
                      href={`https://www.openstreetmap.org/?mlat=${telemetry.ping.lat}&mlon=${telemetry.ping.lon}#map=15/${telemetry.ping.lat}/${telemetry.ping.lon}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-center text-xs text-slate-500 hover:text-slate-300 transition-colors"
                    >
                      Open in OpenStreetMap ↗
                    </a>
                  </>
                ) : (
                  <div className="flex h-full min-h-[200px] items-center justify-center rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)]">
                    <p className="text-sm text-slate-500">Awaiting location ping…</p>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {/* ── Mobile header (State C, mobile only) ──────────────────── */}
        {mobile && (
          <div className="mb-3 text-center">
            <p className="text-xl font-bold text-slate-100">{activeRide.trip_name}</p>
            <p className="text-sm text-slate-400 mt-1">
              {stopped ? frozenElapsed : elapsed} elapsed
            </p>
          </div>
        )}

        {/* ── Stop / Finish controls (both mobile and desktop) ──────── */}
        <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
          {!stopped ? (
            (() => {
              const socValid = endSoc < (activeRide.start_soc_pct ?? 101);
              return (
                <>
                  <button
                    type="button"
                    onClick={handleStop}
                    disabled={stopping || !socValid}
                    className={`flex min-h-[72px] w-full flex-col items-center justify-center rounded-[2rem] bg-red-700 px-6 py-5 text-white transition-colors ${
                      stopping ? 'opacity-60' : socValid ? 'opacity-100 hover:bg-red-600' : 'opacity-40 cursor-not-allowed'
                    }`}
                  >
                    <span className="text-xl font-bold">
                      {stopping ? 'Stopping…' : 'Stop'}
                    </span>
                  </button>
                  <div className="mt-3">
                    <SOCRoller min={0} max={95} value={endSoc} onChange={setEndSoc} label="Ending SOC" />
                  </div>
                </>
              );
            })()
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
              <div className="mt-5">
                {/* Windbreaker */}
                <label
                  onClick={e => e.stopPropagation()}
                  className="flex items-center gap-3 py-2 cursor-pointer select-none"
                >
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
                    style={{ color: 'var(--color-accent)' }}
                    className={`text-sm font-medium px-4 py-2 rounded-xl transition-colors bg-slate-200 hover:bg-white${sportyOpen ? ' ring-1 ring-blue-400' : ''}`}
                  >
                    {sportyLevel !== null ? `Sporty (${sportyLevel})` : 'Sporty'}
                  </button>
                </div>
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

  // State B — leg selector with Starting SOC selector
  const selectedLeg = legs.find(l => String(l.id) === String(selectedLegId));
  if (uiState === 'selecting') {
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
          {/* SOC selector + action buttons (shared mobile/desktop) */}
          <div className="mt-3 flex flex-col gap-3">
            <SOCSelector min={0} max={95} value={startSoc} onChange={setStartSoc} label="Starting SOC" />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleGo}
                disabled={!selectedLegId || starting}
                className="flex-1 flex min-h-[44px] items-center justify-center rounded-2xl bg-green-700 px-4 text-base font-semibold text-white transition-colors hover:bg-green-600 disabled:opacity-60"
              >
                {starting ? 'Starting…' : 'Start'}
              </button>
              <button
                type="button"
                onClick={() => { setUiState('idle'); setSelectedLegId(''); setError(''); }}
                className="flex min-h-[44px] items-center justify-center rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 text-sm text-slate-400 transition-colors hover:border-slate-500"
              >
                Cancel
              </button>
            </div>
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
