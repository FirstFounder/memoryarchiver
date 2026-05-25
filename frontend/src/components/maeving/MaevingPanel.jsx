import { useCallback, useEffect, useRef, useState } from 'react';
import {
  calibrateSession,
  getConfig,
  getDevices,
  getRebelCost,
  getSession,
  getSessions,
  getSessionTaper,
  getTrips,
  scheduleOvernight,
  skipCalibration,
  startSession,
  stopSession,
} from '../../api/maeving.js';
import { SOCRoller } from '../tesla/SOCRoller.jsx';

const TOTAL_WH = 2880; // fallback when config not yet loaded

function formatEta(session, summary, liveApower) {
  const whDelivered = summary?.wh_delivered ?? 0;
  const avgWatts = summary?.avg_watts ?? (liveApower > 10 ? liveApower : 250);
  const socStart = session.soc_start_pct ?? 0;
  const socTarget = session.soc_target_pct ?? 100;
  const estimatedSoc = Math.min(socTarget, socStart + (whDelivered / TOTAL_WH) * 100);
  const remainingWh = Math.max(0, ((socTarget - estimatedSoc) / 100) * TOTAL_WH);
  if (avgWatts < 10) return null;
  const etaMin = (remainingWh / avgWatts) * 60;
  const h = Math.floor(etaMin / 60);
  const m = Math.round(etaMin % 60);
  if (h === 0) return `~${m} min remaining`;
  if (m === 0) return `~${h} hr remaining`;
  return `~${h} hr ${m} min remaining`;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return (
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  );
}

function formatEnergy(wh) {
  if (wh == null) return '—';
  if (wh >= 1000) return (wh / 1000).toFixed(2) + ' kWh';
  return Math.round(wh) + ' Wh';
}

function formatCtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  });
}

function formatMinutes(min) {
  if (min == null) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatChargeTime(startedAt, endedAt) {
  if (!startedAt || !endedAt) return '—';
  const diffMin = (new Date(endedAt) - new Date(startedAt)) / 60000;
  return formatMinutes(diffMin);
}

function msUntilCtTime(targetHour, targetMinute) {
  const now = Date.now();
  const ctDateStr = (d) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(d));
  for (let day = 0; day <= 1; day++) {
    const base = now + day * 86_400_000;
    const dateStr = ctDateStr(base);
    for (const off of ['-06:00', '-05:00']) {
      const iso = `${dateStr}T${String(targetHour).padStart(2, '0')}:${String(targetMinute).padStart(2, '0')}:00${off}`;
      const candidate = new Date(iso);
      const checkHour = Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Chicago',
          hour: '2-digit',
          hour12: false,
        }).format(candidate),
      );
      if (checkHour === targetHour && candidate.getTime() > now) {
        return candidate.getTime() - now;
      }
    }
  }
  return null;
}

function computeLocalTripStats(legs, trips, config, socStart) {
  if (!config) return null;
  const validLegs = legs.filter((l) => l.trip_id !== '');
  if (!validLegs.length) return null;

  const aggregateDist = validLegs.reduce((sum, leg) => {
    const trip = trips.find((t) => t.id === Number(leg.trip_id));
    return sum + (trip?.distance_miles ?? 0);
  }, 0);

  if (aggregateDist === 0) return null;
  if (config.prev_max_soc_pct == null) return null;

  const effectiveCapacity = config.effective_capacity_wh ?? TOTAL_WH;
  const energyConsumedWh = ((config.prev_max_soc_pct - socStart) / 100) * effectiveCapacity;
  const whPerMile = energyConsumedWh / aggregateDist;

  return {
    aggregate_distance_miles: aggregateDist,
    energy_consumed_wh: energyConsumedWh,
    wh_per_mile: whPerMile,
    prev_max_soc_pct: config.prev_max_soc_pct,
  };
}


export function MaevingPanel() {
  const [devices, setDevices] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [activeSessions, setActiveSessions] = useState({});
  const [sessionDetails, setSessionDetails] = useState(null);
  const [recentSessions, setRecentSessions] = useState([]);
  const [trips, setTrips] = useState([]);
  const [config, setConfig] = useState(null);
  const [pendingCalibration, setPendingCalibration] = useState(null);
  const [socStart, setSocStart] = useState(50);
  const [socTarget, setSocTarget] = useState(90);
  const [legs, setLegs] = useState([{ trip_id: '', duration_min: '' }]);
  const [chargeMode, setChargeMode] = useState('now');
  const [departureTime, setDepartureTime] = useState('07:30');
  const [pendingPrices, setPendingPrices] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const [calibrateSOC, setCalibrateSOC] = useState(100);
  const [calibrationResult, setCalibrationResult] = useState(null);
  const [calibrating, setCalibrating] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [taperData, setTaperData] = useState(null);
  const [showCapacityHistory, setShowCapacityHistory] = useState(false);
  const [legRebelCosts, setLegRebelCosts] = useState({});
  const [rebelCostStale, setRebelCostStale] = useState(false);
  const detailsIntervalRef = useRef(null);
  const priceRetryRef = useRef(null);
  const pendingSessionIdRef = useRef(null);
  const taperIntervalRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const [devs, all, tripList, cfg] = await Promise.all([
        getDevices(),
        getSessions({}),
        getTrips(),
        getConfig(),
      ]);
      setDevices(devs);
      const activeDeviceId =
        all.find((s) => s.status === 'active' || s.status === 'scheduled')?.device_id ?? null;
      setSelectedId((prev) => prev ?? activeDeviceId ?? devs[0]?.id ?? null);
      setTrips(tripList);
      setConfig(cfg);
      setPendingCalibration(cfg.pendingSession ?? null);
      const map = {};
      for (const s of all.filter(
        (s) => s.status === 'active' || s.status === 'scheduled',
      )) {
        map[s.device_id] = s;
      }
      setActiveSessions(map);
      setRecentSessions(
        all.filter((s) => s.status !== 'active' && s.status !== 'scheduled').slice(0, 5),
      );
    } catch {
      // silent — stale data is fine
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Update calibrateSOC default when pending calibration changes
  useEffect(() => {
    if (pendingCalibration) {
      setCalibrateSOC(pendingCalibration.soc_target_pct ?? 100);
      setCalibrationResult(null);
    }
  }, [pendingCalibration?.id]);

  // Poll active session details for live Wh estimate
  const activeSession = activeSessions[selectedId] ?? null;

  useEffect(() => {
    if (detailsIntervalRef.current) {
      clearInterval(detailsIntervalRef.current);
      detailsIntervalRef.current = null;
    }
    if (!activeSession) {
      setSessionDetails(null);
      return;
    }

    async function fetchDetails() {
      try {
        setSessionDetails(await getSession(activeSession.id));
      } catch { /* ignore */ }
    }

    fetchDetails();
    detailsIntervalRef.current = setInterval(fetchDetails, 30_000);
    return () => clearInterval(detailsIntervalRef.current);
  }, [activeSession?.id]);

  // Poll taper data for active 100% target sessions
  useEffect(() => {
    if (taperIntervalRef.current) {
      clearInterval(taperIntervalRef.current);
      taperIntervalRef.current = null;
    }
    if (!activeSession || activeSession.soc_target_pct !== 100) {
      setTaperData(null);
      return;
    }

    async function fetchTaper() {
      try {
        const data = await getSessionTaper(activeSession.id);
        setTaperData(data);
      } catch { /* ignore */ }
    }

    fetchTaper();
    taperIntervalRef.current = setInterval(fetchTaper, 60_000);
    return () => {
      if (taperIntervalRef.current) clearInterval(taperIntervalRef.current);
    };
  }, [activeSession?.id, activeSession?.soc_target_pct]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (priceRetryRef.current) clearTimeout(priceRetryRef.current);
      if (taperIntervalRef.current) clearInterval(taperIntervalRef.current);
    };
  }, []);

  const selectedDevice = devices.find((d) => d.id === selectedId) ?? null;
  const liveState = selectedDevice?.live ?? null;
  const liveApower = liveState?.apower ?? 0;

  const isCalibrationBlocking =
    config?.calibration_mode === 1 && pendingCalibration != null;

  const tripStats = computeLocalTripStats(legs, trips, config, socStart);

  function resetPlugInForm() {
    setChargeMode('now');
    setDepartureTime('07:30');
    setPendingPrices(false);
    setError('');
    setLegs([{ trip_id: '', duration_min: '' }]);
    setLegRebelCosts({});
    setRebelCostStale(false);
    if (priceRetryRef.current) {
      clearTimeout(priceRetryRef.current);
      priceRetryRef.current = null;
    }
    pendingSessionIdRef.current = null;
  }

  function addLeg() {
    if (legs.length < 4) setLegs((prev) => [...prev, { trip_id: '', duration_min: '' }]);
  }

  function removeLeg(index) {
    setLegs((prev) => prev.filter((_, i) => i !== index));
  }

  function updateLeg(index, field, value) {
    setLegs((prev) => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)));
  }

  function buildLegData() {
    const legData = {};
    legs.forEach((leg, i) => {
      if (leg.trip_id) {
        legData[`leg_${i + 1}_trip_id`] = Number(leg.trip_id);
        if (leg.duration_min) legData[`leg_${i + 1}_duration_min`] = Number(leg.duration_min);
        const rc = legRebelCosts[i];
        if (rc?.cost != null) legData[`leg_${i + 1}_rebel_cost`] = rc.cost;
      }
    });
    const total = Object.values(legRebelCosts).reduce(
      (sum, rc) => (rc?.cost != null ? sum + rc.cost : sum), 0,
    );
    if (total > 0) legData.rebel_cost_total = total;
    legData.rebel_cost_stale = rebelCostStale ? 1 : 0;
    return legData;
  }

  async function handleChargeNow() {
    if (!selectedId || starting) return;
    setStarting(true);
    setError('');
    try {
      const session = await startSession({
        device_id: selectedId,
        soc_start_pct: socStart,
        soc_target_pct: socTarget,
        charge_mode: 'now',
        ...buildLegData(),
      });
      setActiveSessions((prev) => ({ ...prev, [selectedId]: session }));
      resetPlugInForm();
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  }

  async function handleScheduleOvernight() {
    if (!selectedId || starting) return;
    setStarting(true);
    setError('');
    try {
      const session = await startSession({
        device_id: selectedId,
        soc_start_pct: socStart,
        soc_target_pct: socTarget,
        charge_mode: 'scheduled',
        departure_time: departureTime,
        ...buildLegData(),
      });

      setActiveSessions((prev) => ({ ...prev, [selectedId]: session }));

      const schedResult = await scheduleOvernight(session.id, { departure_time: departureTime });

      if (schedResult.status === 'pending_prices') {
        setPendingPrices(true);
        pendingSessionIdRef.current = session.id;
        const delay = msUntilCtTime(19, 6);
        if (delay && delay > 0) {
          priceRetryRef.current = setTimeout(async () => {
            try {
              const retry = await scheduleOvernight(session.id, {
                departure_time: departureTime,
              });
              if (retry && retry.status !== 'pending_prices') {
                setPendingPrices(false);
                await refresh();
              }
            } catch { /* keep banner if retry fails */ }
          }, delay);
        }
      } else {
        await refresh();
      }

      setChargeMode('now');
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    if (!activeSession || stopping) return;
    setStopping(true);
    setError('');
    try {
      await stopSession(activeSession.id);
      setActiveSessions((prev) => {
        const next = { ...prev };
        delete next[selectedId];
        return next;
      });
      setSessionDetails(null);
      setTaperData(null);
      setPendingPrices(false);
      if (priceRetryRef.current) {
        clearTimeout(priceRetryRef.current);
        priceRetryRef.current = null;
      }
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setStopping(false);
    }
  }

  async function handleSkipCalibration() {
    if (!pendingCalibration || skipping) return;
    setSkipping(true);
    setError('');
    try {
      await skipCalibration(pendingCalibration.id);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSkipping(false);
    }
  }

  async function handleCalibrate() {
    if (!pendingCalibration || calibrating) return;
    setCalibrating(true);
    setError('');
    try {
      const result = await calibrateSession(pendingCalibration.id, calibrateSOC);
      setCalibrationResult(result.calibration);
      setTimeout(async () => {
        setCalibrationResult(null);
        await refresh();
      }, 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setCalibrating(false);
    }
  }

  const isScheduled = activeSession?.status === 'scheduled';
  const isCharging = activeSession?.status === 'active';
  const estCost = activeSession?.estimated_cost_dollars;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">

      {/* Calibration card (blocking) */}
      {isCalibrationBlocking && (() => {
        const calDevice = devices.find((d) => d.id === pendingCalibration.device_id);
        return (
          <section className="rounded-[2rem] border border-amber-700/60 bg-amber-950/20 p-5 sm:p-6">
            <p className="mb-2 text-sm font-semibold uppercase tracking-[0.28em] text-amber-400">
              Calibration Required
            </p>
            <p className="mb-4 text-sm text-slate-300">
              Enter the observed SOC on the bike after the{' '}
              <span className="font-semibold text-slate-100">
                {calDevice?.site_key ?? 'unknown'}
              </span>{' '}
              charge on{' '}
              <span className="font-semibold text-slate-100">
                {formatDate(pendingCalibration.started_at)}
              </span>.
            </p>
            {pendingCalibration.wh_delivered == null ? (
              <>
                <div className="mb-4 rounded-2xl border border-amber-700/50 bg-amber-900/20 px-4 py-3 text-sm text-amber-300">
                  No energy data recorded for this session — capacity estimate cannot be updated.
                </div>
                {error && (
                  <div className="mb-3 rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
                    {error}
                  </div>
                )}
                <button
                  type="button"
                  disabled
                  title="Cannot calibrate without energy data"
                  className="mb-3 min-h-12 w-full cursor-not-allowed rounded-2xl bg-amber-700/60 px-6 text-base font-semibold text-amber-100 opacity-40"
                >
                  Save Observed SOC
                </button>
                <button
                  type="button"
                  onClick={handleSkipCalibration}
                  disabled={skipping}
                  className="min-h-12 w-full rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-6 text-base font-semibold text-slate-300 transition-colors hover:border-slate-500 disabled:opacity-60"
                >
                  {skipping ? 'Skipping…' : 'Skip & Continue'}
                </button>
              </>
            ) : (
              <>
                <div className="mb-4 rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                  <SOCRoller
                    min={1}
                    max={100}
                    value={calibrateSOC}
                    onChange={setCalibrateSOC}
                    label="Observed SOC"
                  />
                </div>
                {error && (
                  <div className="mb-3 rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
                    {error}
                  </div>
                )}
                {calibrationResult ? (
                  <div className="rounded-2xl border border-emerald-700/50 bg-emerald-900/20 px-4 py-3 text-sm text-emerald-300">
                    Pack estimate updated:{' '}
                    {Math.round(calibrationResult.prevCapacity).toLocaleString()} Wh →{' '}
                    {Math.round(calibrationResult.newCapacity).toLocaleString()} Wh (
                    {calibrationResult.delta >= 0 ? '+' : ''}
                    {Math.round(calibrationResult.delta)} Wh)
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={handleCalibrate}
                    disabled={calibrating}
                    className="min-h-12 w-full rounded-2xl bg-amber-700/60 px-6 text-base font-semibold text-amber-100 transition-colors hover:bg-amber-700/80 disabled:opacity-60"
                  >
                    {calibrating ? 'Saving…' : 'Save Observed SOC'}
                  </button>
                )}
              </>
            )}
            <p className="mt-3 text-center text-sm text-slate-500">
              Complete calibration to start next session.
            </p>
          </section>
        );
      })()}

      {/* Device selector */}
      <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-4 sm:p-6">
        <p className="mb-4 text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">
          Maeving RM1S
        </p>
        <div className="grid grid-cols-3 gap-3 sm:flex sm:flex-wrap">
          {devices.map((device) => {
            const isSelected = device.id === selectedId;
            const live = device.live;
            const isOnline = live?.online === true;
            const watts = live?.apower ?? 0;
            return (
              <button
                key={device.id}
                type="button"
                onClick={() => {
                  setSelectedId(device.id);
                  setError('');
                }}
                disabled={isCharging && device.id !== selectedId}
                className={`min-h-16 rounded-2xl border px-5 py-4 text-left transition-colors ${
                  isSelected
                    ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/20 text-slate-50'
                    : 'border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] text-slate-300 hover:border-slate-500'
                }${isCharging && device.id !== selectedId ? ' cursor-not-allowed opacity-40' : ''}`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 flex-shrink-0 rounded-full ${
                      isOnline ? 'bg-green-400' : 'bg-slate-600'
                    }`}
                  />
                  <span className="font-semibold">{device.site_key}</span>
                </span>
                {isOnline && watts > 10 ? (
                  <span className="mt-0.5 block text-sm text-amber-400">
                    {Math.round(watts)} W
                  </span>
                ) : (
                  <span className="mt-0.5 block text-sm text-slate-500">{device.label}</span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* Session panel */}
      {selectedDevice && (
        <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
          {activeSession ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">
                {isScheduled ? 'Scheduled' : 'Charging'}
              </p>

              {isScheduled ? (
                <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-4 text-sm text-slate-300">
                  Plug will turn on at{' '}
                  <span className="font-semibold text-slate-100">
                    {formatCtTime(activeSession.scheduled_start_at)} CT
                  </span>
                  {activeSession.departure_time && (
                    <>
                      {'. '}Ready by{' '}
                      <span className="font-semibold text-slate-100">
                        {activeSession.departure_time}
                      </span>.
                    </>
                  )}
                </div>
              ) : (
                <div
                  className={`grid gap-3 ${
                    estCost != null ? 'grid-cols-2 sm:grid-cols-5' : 'grid-cols-2 sm:grid-cols-4'
                  }`}
                >
                  <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                    <p className="text-xs text-slate-500">Started</p>
                    <p className="mt-1 text-sm font-semibold text-slate-200">
                      {formatDate(activeSession.started_at)}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                    <p className="text-xs text-slate-500">SOC range</p>
                    <p className="mt-1 text-sm font-semibold text-slate-200">
                      {activeSession.soc_start_pct ?? '—'}% →{' '}
                      {activeSession.soc_target_pct ?? '—'}%
                    </p>
                  </div>
                  <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                    <p className="text-xs text-slate-500">Live power</p>
                    <p
                      className={`mt-1 text-sm font-semibold ${
                        liveApower > 10 ? 'text-amber-400' : 'text-slate-400'
                      }`}
                    >
                      {liveApower > 0 ? `${Math.round(liveApower)} W` : '—'}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                    <p className="text-xs text-slate-500">Wh delivered</p>
                    <p className="mt-1 text-sm font-semibold text-slate-200">
                      {formatEnergy(sessionDetails?.readings_summary?.wh_delivered)}
                    </p>
                  </div>
                  {estCost != null && (
                    <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                      <p className="text-xs text-slate-500">Est. cost</p>
                      <p className="mt-1 text-sm font-semibold text-slate-200">
                        ${estCost.toFixed(2)}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Taper section for 100% sessions */}
              {isCharging && activeSession.soc_target_pct === 100 && taperData && (
                <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Taper
                  </p>
                  {taperData.taper_detected ? (
                    <p className="text-sm text-slate-300">
                      Taper phase:{' '}
                      {taperData.taper_start_soc != null
                        ? Math.round(taperData.taper_start_soc)
                        : '—'}
                      % → 100% ·{' '}
                      {taperData.taper_duration_min != null
                        ? Math.round(taperData.taper_duration_min)
                        : '—'}{' '}
                      min ·{' '}
                      {formatEnergy(taperData.taper_wh_delivered)}
                    </p>
                  ) : (
                    <p className="text-sm text-slate-500">
                      Taper not yet detected — watching for CV phase
                    </p>
                  )}
                </div>
              )}

              {pendingPrices && (
                <div className="rounded-2xl border border-sky-700/50 bg-sky-900/20 px-4 py-3 text-sm text-sky-300">
                  Prices not yet available — start time will be optimized after 7:05 PM. Plug will
                  turn on at 3:00 AM as a fallback.
                </div>
              )}

              {/* Auto-shutoff monitoring for 100% target sessions */}
              {isCharging && activeSession.soc_target_pct === 100 && (
                <div className="rounded-2xl border border-sky-700/50 bg-sky-900/20 px-4 py-3 text-sm text-sky-300">
                  Monitoring for charger auto-shutoff
                </div>
              )}

              {/* SOC progress bar for sub-100% target active sessions */}
              {isCharging && activeSession.soc_target_pct < 100 && (() => {
                const effectiveCapacity = config?.effective_capacity_wh ?? TOTAL_WH;
                const whDelivered = sessionDetails?.readings_summary?.wh_delivered ?? 0;
                const socStartPct = activeSession.soc_start_pct ?? 0;
                const socTargetPct = activeSession.soc_target_pct ?? 100;
                const estimatedSoc = Math.min(
                  socTargetPct,
                  socStartPct + (whDelivered / effectiveCapacity) * 100,
                );
                const fillPct = Math.max(0, estimatedSoc - socStartPct);
                const unfilledPct = Math.max(0, socTargetPct - estimatedSoc);
                const etaText = formatEta(activeSession, sessionDetails?.readings_summary, liveApower);

                return (
                  <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3">
                    {/* Current SOC float label — aligned above the pip */}
                    <div className="mb-1 flex w-full items-end">
                      <div className="flex-shrink-0" style={{ width: `${estimatedSoc}%` }} />
                      <span className="-translate-x-1/2 transform whitespace-nowrap text-xs font-semibold text-slate-200">
                        ~{Math.round(estimatedSoc)}%
                      </span>
                    </div>

                    {/* Bar track */}
                    <div className="relative flex h-2.5 w-full items-center rounded-full bg-slate-700/50">
                      {/* Dead zone left of start */}
                      {socStartPct > 0 && (
                        <div className="h-full flex-shrink-0" style={{ width: `${socStartPct}%` }} />
                      )}
                      {/* Green fill: soc_start_pct → estimatedSoc */}
                      {fillPct > 0 && (
                        <div className="h-full flex-shrink-0 bg-emerald-500" style={{ width: `${fillPct}%` }} />
                      )}
                      {/* Unfilled target zone with pip at its left edge */}
                      {unfilledPct > 0 ? (
                        <div
                          className="relative h-full flex-shrink-0 bg-slate-500/30"
                          style={{ width: `${unfilledPct}%` }}
                        >
                          <div className="absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-[color:var(--color-surface-0)] bg-white shadow-sm" />
                        </div>
                      ) : (
                        /* estimatedSoc reached target — pip at right edge of green fill */
                        <div className="absolute right-0 top-1/2 h-4 w-4 -translate-y-1/2 translate-x-2 rounded-full border-2 border-[color:var(--color-surface-0)] bg-emerald-400 shadow-sm" />
                      )}
                    </div>

                    {/* Start / target labels below bar */}
                    <div className="mt-1 flex w-full items-start text-xs text-slate-400">
                      <div className="flex-shrink-0" style={{ width: `${socStartPct}%` }} />
                      <span className="-translate-x-1/2 transform whitespace-nowrap">{socStartPct}%</span>
                      <div className="flex-1" />
                      <span className="translate-x-1/2 transform whitespace-nowrap">{socTargetPct}%</span>
                      <div className="flex-shrink-0" style={{ width: `${100 - socTargetPct}%` }} />
                    </div>

                    {/* Time estimate */}
                    {etaText && (
                      <p className="mt-2 text-center text-sm text-emerald-300">{etaText}</p>
                    )}
                  </div>
                );
              })()}

              {error && (
                <div className="rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
                  {error}
                </div>
              )}

              <button
                type="button"
                onClick={handleStop}
                disabled={stopping}
                className="min-h-14 rounded-2xl border border-red-700/60 bg-red-900/30 px-6 text-base font-semibold text-red-300 transition-colors hover:bg-red-900/60 disabled:opacity-60"
              >
                {stopping
                  ? 'Stopping…'
                  : isScheduled
                    ? 'Cancel'
                    : activeSession.soc_target_pct === 100
                      ? 'Stop & Disconnect'
                      : 'Cut Power'}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">
                Plug In
              </p>

              {/* SOC rollers */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                  <SOCRoller
                    min={0}
                    max={100}
                    value={socStart}
                    onChange={setSocStart}
                    label="Current SOC"
                  />
                </div>
                <div className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                  <SOCRoller
                    min={20}
                    max={100}
                    value={socTarget}
                    onChange={setSocTarget}
                    label="Target SOC"
                  />
                </div>
              </div>

              {/* Trip legs */}
              <div className="flex flex-col gap-2">
                {legs.map((leg, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-3">
                    <label className="w-12 text-sm text-slate-400">
                      Leg {i + 1}
                    </label>
                    <select
                      className="flex-1 rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-3 py-2 text-sm text-slate-200 focus:outline-none"
                      value={leg.trip_id}
                      onChange={(e) => {
                        updateLeg(i, 'trip_id', e.target.value);
                        if (!e.target.value) {
                          updateLeg(i, 'duration_min', '');
                          setLegRebelCosts((prev) => {
                            const next = { ...prev };
                            delete next[i];
                            return next;
                          });
                        } else {
                          const trip = trips.find((t) => t.id === Number(e.target.value));
                          if (trip) {
                            getRebelCost(trip.distance_miles).then((result) => {
                              setLegRebelCosts((prev) => ({ ...prev, [i]: result }));
                              if (result.stale) setRebelCostStale(true);
                            }).catch(() => {});
                          }
                        }
                      }}
                    >
                      <option value="">— no trip —</option>
                      {trips.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.description} ({t.distance_miles} mi)
                        </option>
                      ))}
                    </select>
                    {leg.trip_id && (
                      <input
                        type="number"
                        min="0"
                        step="1"
                        placeholder="Duration (min)"
                        className="w-36 rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none"
                        value={leg.duration_min}
                        onChange={(e) => updateLeg(i, 'duration_min', e.target.value)}
                      />
                    )}
                    {legs.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeLeg(i)}
                        className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-[color:var(--color-surface-0)] hover:text-slate-300"
                        title="Remove leg"
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
                {legs.length < 4 && (
                  <button
                    type="button"
                    onClick={addLeg}
                    className="self-start rounded-xl border border-[color:var(--color-border)] px-3 py-1.5 text-sm text-slate-400 transition-colors hover:border-slate-500 hover:text-slate-300"
                  >
                    + Add Leg
                  </button>
                )}
              </div>

              {/* Trip statistics */}
              {tripStats && (
                <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3">
                  <div className="flex flex-wrap gap-5 text-sm">
                    <span className="text-slate-400">
                      <span className="font-semibold text-slate-200">
                        {tripStats.aggregate_distance_miles.toFixed(1)} mi
                      </span>{' '}
                      total
                    </span>
                    <span className="text-slate-400">
                      <span className="font-semibold text-slate-200">
                        {formatEnergy(tripStats.energy_consumed_wh)}
                      </span>{' '}
                      consumed
                    </span>
                    <span className="text-slate-400">
                      <span className="font-semibold text-slate-200">
                        {tripStats.wh_per_mile.toFixed(1)} Wh/mi
                      </span>
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Based on previous charge to {tripStats.prev_max_soc_pct}% — effective pack:{' '}
                    {Math.round(config?.effective_capacity_wh ?? TOTAL_WH).toLocaleString()} Wh
                  </p>
                </div>
              )}

              {/* Rebel 250 cost comparison */}
              {Object.keys(legRebelCosts).length > 0 && (
                <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3">
                  <div className="flex flex-wrap items-center gap-5 text-sm">
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                      vs Rebel 250
                    </span>
                    {legs.map((leg, i) => {
                      const rc = legRebelCosts[i];
                      if (!leg.trip_id || !rc || rc.cost == null) return null;
                      return (
                        <span key={i} className="text-slate-400">
                          Leg {i + 1}:{' '}
                          <span className={`font-semibold text-amber-400${rc.stale ? ' animate-pulse' : ''}`}>
                            ${rc.cost.toFixed(2)}
                          </span>
                        </span>
                      );
                    })}
                    {(() => {
                      const entries = Object.values(legRebelCosts).filter((rc) => rc?.cost != null);
                      if (entries.length < 2) return null;
                      const total = entries.reduce((s, rc) => s + rc.cost, 0);
                      return (
                        <span className="text-slate-400">
                          Total:{' '}
                          <span className={`font-semibold text-amber-400${rebelCostStale ? ' animate-pulse' : ''}`}>
                            ${total.toFixed(2)}
                          </span>
                        </span>
                      );
                    })()}
                  </div>
                  {rebelCostStale && (
                    <p className="mt-1 text-xs text-slate-500">
                      Gas price may be outdated (EIA cache stale)
                    </p>
                  )}
                </div>
              )}

              {/* Overnight departure time */}
              {chargeMode === 'overnight' && (
                <div className="flex flex-wrap items-center gap-3">
                  <label className="text-sm text-slate-400">Ready by</label>
                  <input
                    type="time"
                    className="rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-3 py-2 text-sm text-slate-200 focus:outline-none"
                    value={departureTime}
                    onChange={(e) => setDepartureTime(e.target.value)}
                  />
                </div>
              )}

              {error && (
                <div className="rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
                  {error}
                </div>
              )}

              {/* Charge mode buttons — hidden when calibration is blocking */}
              {!isCalibrationBlocking && (
                chargeMode === 'now' ? (
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={handleChargeNow}
                      disabled={starting}
                      className="min-h-14 rounded-2xl bg-[color:var(--color-accent)] px-6 text-base font-semibold text-white transition-colors hover:bg-[color:var(--color-accent-hover)] disabled:opacity-60"
                    >
                      {starting ? 'Logging…' : 'Charge Now'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setChargeMode('overnight')}
                      disabled={starting}
                      className="min-h-14 rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-6 text-base font-semibold text-slate-300 transition-colors hover:border-slate-500 disabled:opacity-60"
                    >
                      Charge Overnight
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={handleScheduleOvernight}
                      disabled={starting}
                      className="min-h-14 rounded-2xl bg-[color:var(--color-accent)] px-6 text-base font-semibold text-white transition-colors hover:bg-[color:var(--color-accent-hover)] disabled:opacity-60"
                    >
                      {starting ? 'Scheduling…' : 'Schedule Overnight Charge'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setChargeMode('now')}
                      disabled={starting}
                      className="min-h-14 rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-6 text-base font-semibold text-slate-300 transition-colors hover:border-slate-500 disabled:opacity-60"
                    >
                      Cancel
                    </button>
                  </div>
                )
              )}
            </div>
          )}
        </section>
      )}

      {/* Recent Charge Sessions */}
      {recentSessions.length > 0 && (
        <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
          <p className="mb-4 text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">
            Recent Charge Sessions
          </p>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 text-xs text-slate-500">
              <span>Site</span>
              <span>Date</span>
              <span>Energy</span>
              <span>SOC range</span>
              <span>Charge Time</span>
              <span>Cost</span>
            </div>
            {recentSessions.map((session) => {
              const device = devices.find((d) => d.id === session.device_id);
              const needsCalibration =
                session.calibration_complete === 0 &&
                (session.status === 'complete' || session.status === 'charger_complete');
              return (
                <div
                  key={session.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3 text-sm"
                >
                  <span className="font-semibold text-slate-300">
                    {device?.site_key ?? '?'}
                    {needsCalibration && (
                      <span
                        className="ml-1.5 inline-block h-2 w-2 rounded-full bg-amber-400"
                        title="Calibration pending"
                      />
                    )}
                  </span>
                  <span className="text-slate-500">{formatDate(session.started_at)}</span>
                  <span className="text-slate-400">
                    {formatEnergy(session.wh_delivered)}
                  </span>
                  <span className="text-slate-500">
                    {session.soc_start_pct ?? '—'}% → {session.soc_target_pct ?? '—'}%
                  </span>
                  <span className="text-slate-500">
                    {formatChargeTime(session.started_at, session.ended_at)}
                  </span>
                  {device?.cost_free ? (
                    <span className="text-slate-400">
                      $0.00{' '}
                      <span className="text-xs text-slate-500">(employer)</span>
                    </span>
                  ) : session.rebel_cost_total != null && session.actual_cost_dollars != null ? (
                    <span className="flex flex-col items-end gap-0.5 text-xs leading-tight">
                      <span className="text-green-400">
                        Hourly: ${session.actual_cost_dollars.toFixed(2)}
                      </span>
                      {session.fixed_rate_cost_dollars != null && (
                        <span className="text-amber-400">
                          Fixed: ${session.fixed_rate_cost_dollars.toFixed(2)}
                        </span>
                      )}
                      <span className={`text-amber-400${session.rebel_cost_stale === 1 ? ' animate-pulse' : ''}`}>
                        vs Rebel 250: ${session.rebel_cost_total.toFixed(2)}
                      </span>
                    </span>
                  ) : session.fixed_rate_cost_dollars != null && session.actual_cost_dollars != null ? (
                    <span className="flex flex-col items-end gap-0.5 text-xs leading-tight">
                      <span className="text-slate-400">
                        Hourly: ${session.actual_cost_dollars.toFixed(2)}
                      </span>
                      <span className="text-slate-500">
                        Fixed: ${session.fixed_rate_cost_dollars.toFixed(2)}
                      </span>
                      <span
                        className={
                          (session.hourly_savings_dollars ?? 0) > 0
                            ? 'text-emerald-400'
                            : 'text-amber-400'
                        }
                      >
                        Saved: ${(session.hourly_savings_dollars ?? 0).toFixed(2)}
                      </span>
                    </span>
                  ) : session.actual_cost_dollars != null ? (
                    <span className="text-slate-400">
                      ${session.actual_cost_dollars.toFixed(2)}
                    </span>
                  ) : session.estimated_cost_dollars != null ? (
                    <span className="text-slate-400">
                      ${session.estimated_cost_dollars.toFixed(2)}*
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-slate-600">* estimated cost</p>
        </section>
      )}

      {/* Recent Trips */}
      {(() => {
        const tripLegRows = [];
        for (const session of recentSessions) {
          if (session.leg_1_trip_id == null) continue;
          const legNums = [1, 2, 3, 4].filter((n) => session[`leg_${n}_trip_id`] != null);
          const isMultiLeg = legNums.length > 1;
          for (const n of legNums) {
            const tripId = session[`leg_${n}_trip_id`];
            const trip = trips.find((t) => t.id === tripId);
            tripLegRows.push({
              session,
              legNum: n,
              totalLegs: legNums.length,
              isMultiLeg,
              tripId,
              trip,
              durationMin: session[`leg_${n}_duration_min`],
              isLastLeg: n === legNums[legNums.length - 1],
            });
          }
        }
        const recentTripLegs = tripLegRows.slice(0, 5);
        if (recentTripLegs.length === 0) return null;
        const hasMultiLeg = recentTripLegs.some((r) => r.isMultiLeg);
        return (
          <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
            <p className="mb-4 text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">
              Recent Trips
            </p>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 text-xs text-slate-500">
                <span>Trip</span>
                <span>Date</span>
                <span>Trip Time</span>
                <span>Cost</span>
              </div>
              {recentTripLegs.map((row, i) => {
                const { session, legNum, totalLegs, isMultiLeg, trip, durationMin, isLastLeg } = row;
                const device = devices.find((d) => d.id === session.device_id);
                const cellColor = isMultiLeg ? 'text-yellow-400' : 'text-slate-300';
                const dateCellColor = isMultiLeg ? 'text-yellow-400' : 'text-slate-500';
                const timeCellColor = isMultiLeg ? 'text-yellow-400' : 'text-slate-500';
                const tripName = trip?.description ?? `Trip #${row.tripId}`;
                return (
                  <div
                    key={`${session.id}-${legNum}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3 text-sm"
                  >
                    <span className={`font-semibold ${cellColor}`}>
                      {tripName}
                      {isMultiLeg && (
                        <span className="ml-1.5 text-xs font-normal text-slate-500">
                          (leg {legNum} of {totalLegs})
                        </span>
                      )}
                    </span>
                    <span className={dateCellColor}>{formatDate(session.started_at)}</span>
                    <span className={timeCellColor}>{formatMinutes(durationMin)}</span>
                    {isLastLeg ? (
                      device?.cost_free ? (
                        <span className="text-slate-400">
                          $0.00{' '}
                          <span className="text-xs text-slate-500">(employer)</span>
                        </span>
                      ) : session.rebel_cost_total != null && session.actual_cost_dollars != null ? (
                        <span className="flex flex-col items-end gap-0.5 text-xs leading-tight">
                          <span className="text-green-400">
                            Hourly: ${session.actual_cost_dollars.toFixed(2)}
                          </span>
                          {session.fixed_rate_cost_dollars != null && (
                            <span className="text-amber-400">
                              Fixed: ${session.fixed_rate_cost_dollars.toFixed(2)}
                            </span>
                          )}
                          <span className={`text-amber-400${session.rebel_cost_stale === 1 ? ' animate-pulse' : ''}`}>
                            vs Rebel 250: ${session.rebel_cost_total.toFixed(2)}
                          </span>
                        </span>
                      ) : session.fixed_rate_cost_dollars != null && session.actual_cost_dollars != null ? (
                        <span className="flex flex-col items-end gap-0.5 text-xs leading-tight">
                          <span className="text-slate-400">
                            Hourly: ${session.actual_cost_dollars.toFixed(2)}
                          </span>
                          <span className="text-slate-500">
                            Fixed: ${session.fixed_rate_cost_dollars.toFixed(2)}
                          </span>
                          <span
                            className={
                              (session.hourly_savings_dollars ?? 0) > 0
                                ? 'text-emerald-400'
                                : 'text-amber-400'
                            }
                          >
                            Saved: ${(session.hourly_savings_dollars ?? 0).toFixed(2)}
                          </span>
                        </span>
                      ) : session.actual_cost_dollars != null ? (
                        <span className="text-slate-400">
                          ${session.actual_cost_dollars.toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </div>
                );
              })}
            </div>
            {hasMultiLeg && (
              <p className="mt-2 text-xs text-slate-600">
                Multi-leg trips shown in yellow — cost data reflects the final leg's charge session.
              </p>
            )}
          </section>
        );
      })()}

      {/* Calibration history */}
      {config && config.observation_count > 0 && (
        <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">
              Calibration History
            </p>
            <button
              type="button"
              onClick={() => setShowCapacityHistory((prev) => !prev)}
              className="text-sm text-slate-500 transition-colors hover:text-slate-300"
            >
              {showCapacityHistory ? 'Hide' : 'Show'}
            </button>
          </div>
          {showCapacityHistory && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500">
                      <th className="pb-2 pr-4">Date</th>
                      <th className="pb-2 pr-4">SOC delta</th>
                      <th className="pb-2 pr-4">Observed Wh</th>
                      <th className="pb-2 pr-4">Pack estimate</th>
                      <th className="pb-2">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(config.capacityHistory ?? []).map((entry, i) => {
                      const change = entry.new_capacity - entry.prev_capacity;
                      return (
                        <tr
                          key={i}
                          className="border-t border-[color:var(--color-border)] text-slate-300"
                        >
                          <td className="py-2 pr-4 text-slate-500">
                            {formatDate(entry.recorded_at)}
                          </td>
                          <td className="py-2 pr-4">+{Math.round(entry.soc_delta)}%</td>
                          <td className="py-2 pr-4">
                            {Math.round(entry.observed_wh).toLocaleString()} Wh
                          </td>
                          <td className="py-2 pr-4">
                            {Math.round(entry.new_capacity).toLocaleString()} Wh
                          </td>
                          <td
                            className={`py-2 ${
                              change >= 0 ? 'text-emerald-400' : 'text-red-400'
                            }`}
                          >
                            {change >= 0 ? '+' : ''}
                            {Math.round(change)} Wh
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-sm text-slate-400">
                Effective pack capacity:{' '}
                {Math.round(config.effective_capacity_wh ?? TOTAL_WH).toLocaleString()} Wh (n=
                {config.observation_count} observations)
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
