import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getDevices,
  getSession,
  getSessions,
  getTrips,
  scheduleOvernight,
  startSession,
  stopSession,
} from '../../api/maeving.js';
import { SOCRoller } from '../tesla/SOCRoller.jsx';

const TOTAL_WH = 2880; // 2 × 1.44 kWh packs

function formatEta(session, summary, liveApower) {
  const whDelivered = summary?.wh_delivered ?? 0;
  const avgWatts = summary?.avg_watts ?? (liveApower > 10 ? liveApower : 250);
  const socStart = session.soc_start_pct ?? 0;
  const socTarget = session.soc_target_pct ?? 100;
  const estimatedSoc = Math.min(socTarget, socStart + (whDelivered / TOTAL_WH) * 100);
  const remainingWh = Math.max(0, (socTarget - estimatedSoc) / 100 * TOTAL_WH);
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
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatCtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  });
}

// Returns ms until the next occurrence of targetHour:targetMinute CT after now.
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

export function MaevingPanel() {
  const [devices, setDevices] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [activeSessions, setActiveSessions] = useState({});   // deviceId → session
  const [sessionDetails, setSessionDetails] = useState(null);
  const [recentSessions, setRecentSessions] = useState([]);
  const [trips, setTrips] = useState([]);
  const [socStart, setSocStart] = useState(50);
  const [socTarget, setSocTarget] = useState(90);
  const [selectedTripId, setSelectedTripId] = useState('');
  const [tripDurationMin, setTripDurationMin] = useState('');
  const [chargeMode, setChargeMode] = useState('now');       // 'now' | 'overnight'
  const [departureTime, setDepartureTime] = useState('07:30');
  const [pendingPrices, setPendingPrices] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const detailsIntervalRef = useRef(null);
  const priceRetryRef = useRef(null);
  const pendingSessionIdRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const [devs, all, tripList] = await Promise.all([
        getDevices(),
        getSessions({}),
        getTrips(),
      ]);
      setDevices(devs);
      setSelectedId(prev => prev ?? devs[0]?.id ?? null);
      setTrips(tripList);
      const map = {};
      for (const s of all.filter(s => s.status === 'active' || s.status === 'scheduled')) {
        map[s.device_id] = s;
      }
      setActiveSessions(map);
      setRecentSessions(
        all.filter(s => s.status !== 'active' && s.status !== 'scheduled').slice(0, 5),
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

  // Clean up price retry timer on unmount
  useEffect(() => {
    return () => {
      if (priceRetryRef.current) clearTimeout(priceRetryRef.current);
    };
  }, []);

  const selectedDevice = devices.find(d => d.id === selectedId) ?? null;
  const liveState = selectedDevice?.live ?? null;
  const liveApower = liveState?.apower ?? 0;

  function resetPlugInForm() {
    setChargeMode('now');
    setDepartureTime('07:30');
    setPendingPrices(false);
    setError('');
    if (priceRetryRef.current) { clearTimeout(priceRetryRef.current); priceRetryRef.current = null; }
    pendingSessionIdRef.current = null;
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
        trip_id: selectedTripId ? Number(selectedTripId) : undefined,
        trip_duration_min: tripDurationMin ? Number(tripDurationMin) : undefined,
      });
      setActiveSessions(prev => ({ ...prev, [selectedId]: session }));
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
        trip_id: selectedTripId ? Number(selectedTripId) : undefined,
        trip_duration_min: tripDurationMin ? Number(tripDurationMin) : undefined,
      });

      setActiveSessions(prev => ({ ...prev, [selectedId]: session }));

      // Now request optimal start time
      const schedResult = await scheduleOvernight(session.id, { departure_time: departureTime });

      if (schedResult.status === 'pending_prices') {
        setPendingPrices(true);
        pendingSessionIdRef.current = session.id;
        // Retry at 19:06 CT to allow ComEd a minute past their publication window
        const delay = msUntilCtTime(19, 6);
        if (delay && delay > 0) {
          priceRetryRef.current = setTimeout(async () => {
            try {
              const retry = await scheduleOvernight(session.id, { departure_time: departureTime });
              if (retry && retry.status !== 'pending_prices') {
                setPendingPrices(false);
                await refresh();
              }
            } catch { /* keep banner if retry fails */ }
          }, delay);
        }
      } else {
        // Successfully scheduled — refresh to get updated session
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
      setActiveSessions(prev => {
        const next = { ...prev };
        delete next[selectedId];
        return next;
      });
      setSessionDetails(null);
      setPendingPrices(false);
      if (priceRetryRef.current) { clearTimeout(priceRetryRef.current); priceRetryRef.current = null; }
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setStopping(false);
    }
  }

  const eta = activeSession?.status === 'active'
    ? formatEta(activeSession, sessionDetails?.readings_summary, liveApower)
    : null;

  const isScheduled = activeSession?.status === 'scheduled';
  const isCharging = activeSession?.status === 'active';
  const estCost = activeSession?.estimated_cost_dollars;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">

      {/* Device selector */}
      <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-4 sm:p-6">
        <p className="mb-4 text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Maeving RM1S</p>
        <div className="grid grid-cols-3 gap-3 sm:flex sm:flex-wrap">
          {devices.map(device => {
            const isSelected = device.id === selectedId;
            const live = device.live;
            const isOnline = live?.online === true;
            const watts = live?.apower ?? 0;
            return (
              <button
                key={device.id}
                type="button"
                onClick={() => { setSelectedId(device.id); setError(''); }}
                className={`min-h-16 rounded-2xl border px-5 py-4 text-left transition-colors ${
                  isSelected
                    ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/20 text-slate-50'
                    : 'border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] text-slate-300 hover:border-slate-500'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className={`h-2 w-2 flex-shrink-0 rounded-full ${isOnline ? 'bg-green-400' : 'bg-slate-600'}`} />
                  <span className="font-semibold">{device.site_key}</span>
                </span>
                {isOnline && watts > 10 ? (
                  <span className="mt-0.5 block text-sm text-amber-400">{Math.round(watts)} W</span>
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
                /* Scheduled banner — show instead of stats grid */
                <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-4 text-sm text-slate-300">
                  Plug will turn on at{' '}
                  <span className="font-semibold text-slate-100">
                    {formatCtTime(activeSession.scheduled_start_at)} CT
                  </span>
                  {activeSession.departure_time && (
                    <>
                      {'. '}Ready by{' '}
                      <span className="font-semibold text-slate-100">{activeSession.departure_time}</span>.
                    </>
                  )}
                </div>
              ) : (
                /* Active charging stats */
                <div className={`grid gap-3 ${estCost != null ? 'grid-cols-2 sm:grid-cols-5' : 'grid-cols-2 sm:grid-cols-4'}`}>
                  <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                    <p className="text-xs text-slate-500">Started</p>
                    <p className="mt-1 text-sm font-semibold text-slate-200">{formatDate(activeSession.started_at)}</p>
                  </div>
                  <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                    <p className="text-xs text-slate-500">SOC range</p>
                    <p className="mt-1 text-sm font-semibold text-slate-200">
                      {activeSession.soc_start_pct ?? '—'}% → {activeSession.soc_target_pct ?? '—'}%
                    </p>
                  </div>
                  <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                    <p className="text-xs text-slate-500">Live power</p>
                    <p className={`mt-1 text-sm font-semibold ${liveApower > 10 ? 'text-amber-400' : 'text-slate-400'}`}>
                      {liveApower > 0 ? `${Math.round(liveApower)} W` : '—'}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                    <p className="text-xs text-slate-500">Wh delivered</p>
                    <p className="mt-1 text-sm font-semibold text-slate-200">
                      {sessionDetails?.readings_summary?.wh_delivered != null
                        ? `${Math.round(sessionDetails.readings_summary.wh_delivered)} Wh`
                        : '—'}
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

              {pendingPrices && (
                <div className="rounded-2xl border border-sky-700/50 bg-sky-900/20 px-4 py-3 text-sm text-sky-300">
                  Prices not yet available — start time will be optimized after 7:05 PM.
                  Plug will turn on at 3:00 AM as a fallback.
                </div>
              )}

              {eta && (
                <div className="rounded-2xl border border-emerald-700/50 bg-emerald-900/20 px-4 py-3 text-sm text-emerald-300">
                  {eta}
                </div>
              )}

              {error && (
                <div className="rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">{error}</div>
              )}

              <button
                type="button"
                onClick={handleStop}
                disabled={stopping}
                className="min-h-14 rounded-2xl border border-red-700/60 bg-red-900/30 px-6 text-base font-semibold text-red-300 transition-colors hover:bg-red-900/60 disabled:opacity-60"
              >
                {stopping ? 'Stopping…' : isScheduled ? 'Cancel' : 'Cut Power'}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Plug In</p>

              {/* SOC rollers */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                  <SOCRoller min={0} max={100} value={socStart} onChange={setSocStart} label="Current SOC" />
                </div>
                <div className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                  <SOCRoller min={50} max={100} value={socTarget} onChange={setSocTarget} label="Target SOC" />
                </div>
              </div>

              {/* Trip selector */}
              <div className="flex flex-wrap items-center gap-3">
                <label className="text-sm text-slate-400">Trip</label>
                <select
                  className="flex-1 rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-3 py-2 text-sm text-slate-200 focus:outline-none"
                  value={selectedTripId}
                  onChange={e => { setSelectedTripId(e.target.value); setTripDurationMin(''); }}
                >
                  <option value="">— no trip —</option>
                  {trips.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.description} ({t.distance_miles} mi)
                    </option>
                  ))}
                </select>
                {selectedTripId && (
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder="Duration (min)"
                    className="w-36 rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none"
                    value={tripDurationMin}
                    onChange={e => setTripDurationMin(e.target.value)}
                  />
                )}
              </div>

              {/* Overnight departure time (only when mode is overnight) */}
              {chargeMode === 'overnight' && (
                <div className="flex flex-wrap items-center gap-3">
                  <label className="text-sm text-slate-400">Ready by</label>
                  <input
                    type="time"
                    className="rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-3 py-2 text-sm text-slate-200 focus:outline-none"
                    value={departureTime}
                    onChange={e => setDepartureTime(e.target.value)}
                  />
                </div>
              )}

              {error && (
                <div className="rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">{error}</div>
              )}

              {/* Charge mode buttons */}
              {chargeMode === 'now' ? (
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
              )}
            </div>
          )}
        </section>
      )}

      {/* Recent sessions */}
      {recentSessions.length > 0 && (
        <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
          <p className="mb-4 text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Recent Sessions</p>
          <div className="flex flex-col gap-2">
            {recentSessions.map(session => {
              const device = devices.find(d => d.id === session.device_id);
              const trip = trips.find(t => t.id === session.trip_id);
              const tripLabel = trip
                ? (trip.description.length > 25 ? trip.description.slice(0, 25) + '…' : trip.description)
                : null;
              const cost = session.actual_cost_dollars != null
                ? `$${session.actual_cost_dollars.toFixed(2)}`
                : session.estimated_cost_dollars != null
                  ? `$${session.estimated_cost_dollars.toFixed(2)}*`
                  : '—';
              return (
                <div
                  key={session.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3 text-sm"
                >
                  <span className="font-semibold text-slate-300">{device?.site_key ?? '?'}</span>
                  <span className="text-slate-500">{formatDate(session.started_at)}</span>
                  <span className="text-slate-400">
                    {session.wh_delivered != null ? `${Math.round(session.wh_delivered)} Wh` : '—'}
                  </span>
                  <span className="text-slate-500">
                    {session.soc_start_pct ?? '—'}% → {session.soc_target_pct ?? '—'}%
                  </span>
                  {tripLabel && (
                    <span className="text-slate-500 italic">{tripLabel}</span>
                  )}
                  <span className="text-slate-400">{cost}</span>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-slate-600">* estimated cost</p>
        </section>
      )}
    </div>
  );
}
