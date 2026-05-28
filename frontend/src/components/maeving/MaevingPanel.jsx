import { useCallback, useEffect, useRef, useState } from 'react';
import {
  calibrateSession,
  deleteRide,
  finishRide,
  getConfig,
  getDevices,
  getLegs,
  getPendingRides,
  getRebelCost,
  getSession,
  getSessions,
  getSessionTaper,
  scheduleOvernight,
  skipCalibration,
  startRide,
  startSession,
  stopSession,
  updateRide,
} from '../../api/maeving.js';
import { SOCRoller } from '../tesla/SOCRoller.jsx';

const TOTAL_WH = 2880; // fallback when config not yet loaded

function formatEta(session, summary, liveApower, estimatedSoc, effectiveCapacity) {
  const socTarget = session.soc_target_pct ?? 100;
  const remainingWh = Math.max(0, ((socTarget - estimatedSoc) / 100) * effectiveCapacity);
  const watts =
    liveApower > 10
      ? liveApower
      : (summary?.avg_watts ?? 0) > 10
        ? summary.avg_watts
        : 250;
  if (watts < 10) return null;
  const etaMin = (remainingWh / watts) * 60;
  const h = Math.floor(etaMin / 60);
  const m = Math.round(etaMin % 60);
  if (h === 0 && m === 0) return `~0 min remaining`;
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

function formatTimeRange(startedAt, finishedAt) {
  if (!startedAt) return '';
  const fmt = (iso) =>
    new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (!finishedAt) return fmt(startedAt);
  return `${fmt(startedAt)}–${fmt(finishedAt)}`;
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

function getSessionRowClass(session, device) {
  if (device?.cost_free) return 'bg-orange-950/30 border-orange-800/40';
  const legCount = [1, 2, 3, 4, 5, 6, 7, 8].filter((n) => session[`leg_${n}_trip_id`] != null).length;
  if (legCount === 1) return 'bg-green-950/30 border-green-800/40';
  return 'border-[color:var(--color-border)] bg-[color:var(--color-surface-0)]';
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
  // Prestaged rides (plug-in form)
  const [pendingRides, setPendingRides] = useState([]);
  const [checkedRideIds, setCheckedRideIds] = useState(() => new Set());
  // Recent Trips — pending rides
  const [recentPendingRides, setRecentPendingRides] = useState([]);
  const [editRideId, setEditRideId] = useState(null);
  const [editRideForm, setEditRideForm] = useState({});
  const [rideEditError, setRideEditError] = useState('');
  const [deleteRideConfirmId, setDeleteRideConfirmId] = useState(null);
  const [addingRide, setAddingRide] = useState(false);
  const [addRideForm, setAddRideForm] = useState({ trip_id: '', started_at: '', finished_at: '', start_soc_pct: '', end_soc_pct: '', notes: '' });
  const [addRideError, setAddRideError] = useState('');
  // Notes dialog
  const [noteMode, setNoteMode] = useState('display');
  const [noteRideId, setNoteRideId] = useState(null);
  const [noteValue, setNoteValue] = useState('');
  const [noteError, setNoteError] = useState('');
  const noteDialogRef = useRef(null);

  const detailsIntervalRef = useRef(null);
  const priceRetryRef = useRef(null);
  const pendingSessionIdRef = useRef(null);
  const taperIntervalRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const [devs, all, tripList, cfg, pendingList] = await Promise.all([
        getDevices(),
        getSessions({}),
        getLegs(),
        getConfig(),
        getPendingRides(),
      ]);
      setDevices(devs);
      const activeDeviceId =
        all.find((s) => s.status === 'active' || s.status === 'scheduled')?.device_id ?? null;
      setSelectedId((prev) => prev ?? activeDeviceId ?? devs[0]?.id ?? null);
      setTrips(tripList);
      setConfig(cfg);
      setSocStart(cfg.prev_max_soc_pct ?? 50);
      setPendingCalibration(cfg.pendingSession ?? null);
      const map = {};
      for (const s of all.filter(
        (s) => s.status === 'active' || s.status === 'scheduled',
      )) {
        map[s.device_id] = s;
      }
      setActiveSessions(map);
      setRecentSessions(
        all.filter((s) => s.status !== 'active' && s.status !== 'scheduled').slice(0, 10),
      );
      setRecentPendingRides(pendingList);
      setPendingRides(pendingList);
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

  // Fetch pending rides when plug-in form is visible (device selected, no active session)
  useEffect(() => {
    if (!selectedId || activeSession) return;
    let mounted = true;
    getPendingRides().then((rides) => {
      if (!mounted) return;
      setPendingRides(rides);
      setCheckedRideIds(new Set(rides.map((r) => r.id)));
    }).catch(() => {});
    return () => { mounted = false; };
  }, [selectedId, activeSession?.id]);

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

  // Leg limit accounting
  const checkedCount = checkedRideIds.size;
  const manualLegsWithTrip = legs.filter((l) => l.trip_id !== '').length;
  const totalLegCount = checkedCount + manualLegsWithTrip;
  const isOverLimit = totalLegCount > 8;

  function resetPlugInForm() {
    setChargeMode('now');
    setDepartureTime('07:30');
    setPendingPrices(false);
    setError('');
    setLegs([{ trip_id: '', duration_min: '' }]);
    setLegRebelCosts({});
    setRebelCostStale(false);
    setPendingRides([]);
    setCheckedRideIds(new Set());
    if (priceRetryRef.current) {
      clearTimeout(priceRetryRef.current);
      priceRetryRef.current = null;
    }
    pendingSessionIdRef.current = null;
  }

  function addLeg() {
    if (checkedCount + legs.length < 8) setLegs((prev) => [...prev, { trip_id: '', duration_min: '' }]);
  }

  function removeLeg(index) {
    setLegs((prev) => prev.filter((_, i) => i !== index));
  }

  function updateLeg(index, field, value) {
    setLegs((prev) => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)));
  }

  function toggleRideCheck(id) {
    setCheckedRideIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function buildLegData() {
    const legData = {};
    const checkedRides = pendingRides
      .filter((r) => checkedRideIds.has(r.id))
      .sort((a, b) => new Date(a.started_at) - new Date(b.started_at));

    let slotIdx = 0;

    for (const ride of checkedRides) {
      if (slotIdx >= 8) break;
      slotIdx++;
      legData[`leg_${slotIdx}_trip_id`] = ride.trip_id;
      legData[`leg_${slotIdx}_ride_id`] = ride.id;
      legData[`leg_${slotIdx}_started_at`] = ride.started_at;
      if (ride.duration_min != null) {
        legData[`leg_${slotIdx}_duration_min`] = Math.round(ride.duration_min);
      }
    }

    legs.forEach((leg, i) => {
      if (!leg.trip_id || slotIdx >= 8) return;
      slotIdx++;
      legData[`leg_${slotIdx}_trip_id`] = Number(leg.trip_id);
      if (leg.duration_min) legData[`leg_${slotIdx}_duration_min`] = Number(leg.duration_min);
      const rc = legRebelCosts[i];
      if (rc?.cost != null) legData[`leg_${slotIdx}_rebel_cost`] = rc.cost;
    });

    const total = Object.values(legRebelCosts).reduce(
      (sum, rc) => (rc?.cost != null ? sum + rc.cost : sum), 0,
    );
    if (total > 0) legData.rebel_cost_total = total;
    legData.rebel_cost_stale = rebelCostStale ? 1 : 0;
    return legData;
  }

  async function consumeCheckedRides() {
    const ids = [...checkedRideIds];
    if (ids.length === 0) return;
    Promise.all(ids.map((id) => deleteRide(id))).catch(() => {});
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
      consumeCheckedRides();
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

      consumeCheckedRides();
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

  // ── Pending ride edit helpers ────────────────────────────────────────────────

  function startEditRide(ride) {
    setEditRideId(ride.id);
    setEditRideForm({
      trip_id: ride.trip_id ?? '',
      end_soc_pct: ride.end_soc_pct ?? '',
      notes: ride.notes ?? '',
    });
    setRideEditError('');
    setDeleteRideConfirmId(null);
  }

  async function handleSaveRideEdit(id) {
    setRideEditError('');
    const payload = {};
    if (editRideForm.trip_id !== '') payload.trip_id = Number(editRideForm.trip_id);
    if (editRideForm.end_soc_pct !== '') payload.end_soc_pct = Number(editRideForm.end_soc_pct);
    if (editRideForm.notes !== undefined) payload.notes = editRideForm.notes;
    try {
      await updateRide(id, payload);
      setEditRideId(null);
      await refresh();
    } catch (err) {
      setRideEditError(err.message);
    }
  }

  async function handleDeleteRide(id) {
    try {
      await deleteRide(id);
      setDeleteRideConfirmId(null);
      await refresh();
    } catch (err) {
      setRideEditError(err.message);
    }
  }

  // ── Add ride helper ──────────────────────────────────────────────────────────

  async function handleAddRide() {
    setAddRideError('');
    const { trip_id, started_at, finished_at, start_soc_pct, end_soc_pct, notes } = addRideForm;
    if (!trip_id || !started_at || !finished_at || start_soc_pct === '' || end_soc_pct === '') {
      setAddRideError('All fields are required.');
      return;
    }
    if (new Date(finished_at) <= new Date(started_at)) {
      setAddRideError('End time must be after start time.');
      return;
    }
    try {
      const ride = await startRide({ trip_id: Number(trip_id), start_soc_pct: Number(start_soc_pct) });
      await finishRide(ride.id, { end_soc_pct: Number(end_soc_pct) });
      await updateRide(ride.id, {
        started_at: new Date(started_at).toISOString(),
        finished_at: new Date(finished_at).toISOString(),
        notes: notes || null,
      });
      setAddingRide(false);
      setAddRideForm({ trip_id: '', started_at: '', finished_at: '', start_soc_pct: '', end_soc_pct: '', notes: '' });
      await refresh();
    } catch (err) {
      setAddRideError(err.message);
    }
  }

  // ── Notes dialog helpers ─────────────────────────────────────────────────────

  function openNoteDialog(rideId, mode, currentNote) {
    setNoteRideId(rideId);
    setNoteMode(mode);
    setNoteValue(currentNote ?? '');
    setNoteError('');
    noteDialogRef.current.showModal();
  }

  async function handleNoteSave() {
    if (noteMode === 'display') {
      try {
        await updateRide(noteRideId, { notes: noteValue || null });
        noteDialogRef.current.close();
        setNoteError('');
        await refresh();
      } catch (err) {
        setNoteError(err.message);
      }
    } else {
      setEditRideForm((f) => ({ ...f, notes: noteValue }));
      noteDialogRef.current.close();
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
                const etaText = formatEta(
                  activeSession,
                  sessionDetails?.readings_summary,
                  liveApower,
                  estimatedSoc,
                  effectiveCapacity,
                );

                return (
                  <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3">
                    <div className="mb-1 flex w-full items-end">
                      <div className="flex-shrink-0" style={{ width: `${estimatedSoc}%` }} />
                      <span className="-translate-x-1/2 transform whitespace-nowrap text-xs font-semibold text-slate-200">
                        ~{Math.round(estimatedSoc)}%
                      </span>
                    </div>
                    <div className="relative flex h-2.5 w-full items-center rounded-full bg-slate-700/50">
                      {socStartPct > 0 && (
                        <div className="h-full flex-shrink-0" style={{ width: `${socStartPct}%` }} />
                      )}
                      {fillPct > 0 && (
                        <div className="h-full flex-shrink-0 bg-emerald-500" style={{ width: `${fillPct}%` }} />
                      )}
                      {unfilledPct > 0 ? (
                        <div
                          className="relative h-full flex-shrink-0 bg-slate-500/30"
                          style={{ width: `${unfilledPct}%` }}
                        >
                          <div className="absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-[color:var(--color-surface-0)] bg-white shadow-sm" />
                        </div>
                      ) : (
                        <div className="absolute right-0 top-1/2 h-4 w-4 -translate-y-1/2 translate-x-2 rounded-full border-2 border-[color:var(--color-surface-0)] bg-emerald-400 shadow-sm" />
                      )}
                    </div>
                    <div className="mt-1 flex w-full items-start text-xs text-slate-400">
                      <div className="flex-shrink-0" style={{ width: `${socStartPct}%` }} />
                      <span className="-translate-x-1/2 transform whitespace-nowrap">{socStartPct}%</span>
                      <div className="flex-1" />
                      <span className="translate-x-1/2 transform whitespace-nowrap">{socTargetPct}%</span>
                      <div className="flex-shrink-0" style={{ width: `${100 - socTargetPct}%` }} />
                    </div>
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

              {/* Prestaged rides */}
              {pendingRides.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Prestaged Rides
                  </p>
                  {pendingRides.map((ride) => {
                    const checked = checkedRideIds.has(ride.id);
                    return (
                      <label
                        key={ride.id}
                        className={`flex cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 text-sm transition-colors ${
                          checked
                            ? 'border-emerald-700/50 bg-emerald-950/20'
                            : 'border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] opacity-60'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleRideCheck(ride.id)}
                          className="h-4 w-4 accent-emerald-500"
                        />
                        <span className="flex-1 font-semibold text-slate-200">{ride.trip_name}</span>
                        <span className="text-slate-400">{ride.trip_miles} mi</span>
                        {ride.duration_min != null && (
                          <span className="text-slate-400">{Math.round(ride.duration_min)} min</span>
                        )}
                        <span className="text-slate-500 text-xs">
                          {formatTimeRange(ride.started_at, ride.finished_at)}
                        </span>
                        {ride.start_soc_pct != null && ride.end_soc_pct != null && (
                          <span className="text-slate-500 text-xs">
                            {ride.start_soc_pct}%→{ride.end_soc_pct}%
                          </span>
                        )}
                        {ride.wh_per_mile != null && (
                          <span className="text-slate-500 text-xs">
                            {ride.wh_per_mile < 100
                              ? ride.wh_per_mile.toFixed(1)
                              : Math.round(ride.wh_per_mile)} Wh/mi
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}

              {/* Over-limit warning */}
              {isOverLimit && (
                <div className="rounded-2xl border border-amber-700/60 bg-amber-950/20 px-4 py-3 text-sm text-amber-300">
                  {totalLegCount} legs selected — maximum is 8. Uncheck prestaged rides or remove manual legs.
                </div>
              )}

              {/* Trip legs */}
              <div className="flex flex-col gap-2">
                {legs.map((leg, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-3">
                    <label className="w-12 text-sm text-slate-400">
                      Leg {checkedCount + i + 1}
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
                      {trips.filter((t) => !t.hidden).map((t) => (
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
                {(checkedCount + legs.length) < 8 && (
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
                          Leg {checkedCount + i + 1}:{' '}
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
                      disabled={starting || isOverLimit}
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
                      disabled={starting || isOverLimit}
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
              const rowClass = getSessionRowClass(session, device);
              return (
                <div
                  key={session.id}
                  className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl border px-4 py-3 text-sm ${rowClass}`}
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
                    session.lf_equivalent_cost_dollars != null ? (
                      <span className="flex flex-col items-end gap-0.5 text-xs leading-tight">
                        <span className="text-green-400">
                          vs Hourly: ${session.lf_equivalent_cost_dollars.toFixed(2)}
                        </span>
                        {session.lf_equivalent_fixed_dollars != null && (
                          <span className="text-amber-400">
                            vs Fixed: ${session.lf_equivalent_fixed_dollars.toFixed(2)}
                          </span>
                        )}
                        {session.rebel_cost_total != null && (
                          <span className={`text-amber-400${session.rebel_cost_stale === 1 ? ' animate-pulse' : ''}`}>
                            vs Rebel 250: ${session.rebel_cost_total.toFixed(2)}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-slate-400">$0.00</span>
                    )
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
                            : 'text-red-400'
                        }
                      >
                        {(session.hourly_savings_dollars ?? 0) > 0
                          ? `Saved: $${(session.hourly_savings_dollars).toFixed(2)}`
                          : `Penalized: $${Math.abs(session.hourly_savings_dollars ?? 0).toFixed(2)}`}
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
          const legNums = [1, 2, 3, 4, 5, 6, 7, 8].filter((n) => session[`leg_${n}_trip_id`] != null);
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
              legStartedAt: session[`leg_${n}_started_at`],
              isLastLeg: n === legNums[legNums.length - 1],
            });
          }
        }
        const recentTripLegs = tripLegRows.slice(0, 10);

        if (recentTripLegs.length === 0 && recentPendingRides.length === 0 && !addingRide) return null;

        const hasLFRow = recentTripLegs.some((r) => devices.find((d) => d.id === r.session.device_id)?.cost_free);

        return (
          <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
            <p className="mb-4 text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">
              Recent Trips
            </p>
            <div className="flex flex-col gap-2">

              {/* Pending rides header + Add Ride button */}
              {recentPendingRides.length > 0 || addingRide ? (
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-[0.2em] text-yellow-500">
                    Pending Rides
                  </span>
                  {!addingRide && (
                    <button
                      type="button"
                      onClick={() => { setAddingRide(true); setAddRideError(''); }}
                      className="rounded-xl border border-[color:var(--color-border)] px-3 py-1 text-xs text-slate-300 hover:border-slate-500"
                    >
                      + Add Ride
                    </button>
                  )}
                </div>
              ) : (
                <div className="mb-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => { setAddingRide(true); setAddRideError(''); }}
                    className="rounded-xl border border-[color:var(--color-border)] px-3 py-1 text-xs text-slate-300 hover:border-slate-500"
                  >
                    + Add Ride
                  </button>
                </div>
              )}

              {/* Add Ride inline form */}
              {addingRide && (
                <div className="mb-3 rounded-2xl border border-yellow-700/50 bg-yellow-950/20 px-4 py-3">
                  <div className="flex flex-wrap gap-2 items-end">
                    <select
                      className="rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-3 py-2 text-sm text-slate-200"
                      value={addRideForm.trip_id}
                      onChange={e => setAddRideForm(f => ({ ...f, trip_id: e.target.value }))}
                    >
                      <option value="">Select Leg</option>
                      {trips.filter(t => !t.hidden).map(t => (
                        <option key={t.id} value={t.id}>{t.description} ({t.distance_miles} mi)</option>
                      ))}
                    </select>
                    <label className="flex flex-col text-xs text-slate-400 gap-1">
                      Start
                      <input
                        type="datetime-local"
                        className="rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-2 py-1.5 text-sm text-slate-200"
                        value={addRideForm.started_at}
                        onChange={e => setAddRideForm(f => ({ ...f, started_at: e.target.value }))}
                      />
                    </label>
                    <label className="flex flex-col text-xs text-slate-400 gap-1">
                      End
                      <input
                        type="datetime-local"
                        className="rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-2 py-1.5 text-sm text-slate-200"
                        value={addRideForm.finished_at}
                        onChange={e => setAddRideForm(f => ({ ...f, finished_at: e.target.value }))}
                      />
                    </label>
                    <label className="flex flex-col text-xs text-slate-400 gap-1">
                      Start SOC %
                      <input
                        type="number" min="0" max="100"
                        className="w-20 rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-2 py-1.5 text-sm text-slate-200"
                        value={addRideForm.start_soc_pct}
                        onChange={e => setAddRideForm(f => ({ ...f, start_soc_pct: e.target.value }))}
                      />
                    </label>
                    <label className="flex flex-col text-xs text-slate-400 gap-1">
                      End SOC %
                      <input
                        type="number" min="0" max="100"
                        className="w-20 rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-2 py-1.5 text-sm text-slate-200"
                        value={addRideForm.end_soc_pct}
                        onChange={e => setAddRideForm(f => ({ ...f, end_soc_pct: e.target.value }))}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={handleAddRide}
                      className="rounded-xl bg-[color:var(--color-accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[color:var(--color-accent-hover)]"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => { setAddingRide(false); setAddRideError(''); }}
                      className="rounded-xl border border-[color:var(--color-border)] px-4 py-2 text-sm text-slate-400 hover:border-slate-500"
                    >
                      Cancel
                    </button>
                  </div>
                  {addRideError && (
                    <p className="mt-2 text-xs text-red-400">{addRideError}</p>
                  )}
                </div>
              )}

              {/* Pending ride rows */}
              {recentPendingRides.map((ride) => {
                const isEditing = editRideId === ride.id;
                const isConfirmingDelete = deleteRideConfirmId === ride.id;

                if (isConfirmingDelete) {
                  return (
                    <div key={ride.id} className="rounded-2xl border border-red-800/50 bg-red-950/20 px-4 py-3 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-slate-300">
                          Delete <span className="font-semibold text-slate-100">{ride.trip_name}</span>?
                        </span>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => handleDeleteRide(ride.id)}
                            className="rounded-xl bg-red-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-red-600"
                          >
                            Yes
                          </button>
                          <button
                            type="button"
                            onClick={() => { setDeleteRideConfirmId(null); setRideEditError(''); }}
                            className="rounded-xl border border-[color:var(--color-border)] px-4 py-1.5 text-sm text-slate-400 hover:border-slate-500"
                          >
                            No
                          </button>
                        </div>
                      </div>
                      {rideEditError && <p className="mt-1 text-xs text-red-400">{rideEditError}</p>}
                    </div>
                  );
                }

                if (isEditing) {
                  return (
                    <div key={ride.id} className="rounded-2xl border border-amber-700/50 bg-amber-950/30 px-4 py-3">
                      <p className="mb-2 text-xs text-slate-500">
                        {formatTimeRange(ride.started_at, ride.finished_at)} · {formatMinutes(ride.duration_min)}
                      </p>
                      <div className="flex flex-wrap gap-2 items-end">
                        <label className="flex flex-col text-xs text-slate-400 gap-1">
                          Leg
                          <select
                            className="rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-3 py-2 text-sm text-slate-200"
                            value={editRideForm.trip_id}
                            onChange={e => setEditRideForm(f => ({ ...f, trip_id: e.target.value }))}
                          >
                            <option value="">Select Leg</option>
                            {trips.filter(t => !t.hidden).map(t => (
                              <option key={t.id} value={t.id}>{t.description} ({t.distance_miles} mi)</option>
                            ))}
                          </select>
                        </label>
                        <label className="flex flex-col text-xs text-slate-400 gap-1">
                          End SOC %
                          <input
                            type="number" min="0" max="100"
                            className="w-20 rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-2 py-1.5 text-sm text-slate-200"
                            value={editRideForm.end_soc_pct}
                            onChange={e => setEditRideForm(f => ({ ...f, end_soc_pct: e.target.value }))}
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => openNoteDialog(ride.id, 'edit', editRideForm.notes)}
                          className="self-end rounded-xl border border-[color:var(--color-border)] px-3 py-1.5 text-xs text-slate-400 hover:border-slate-500"
                        >
                          {editRideForm.notes ? 'Edit Note' : 'Note'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSaveRideEdit(ride.id)}
                          className="self-end rounded-xl bg-[color:var(--color-accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[color:var(--color-accent-hover)]"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => { setEditRideId(null); setRideEditError(''); }}
                          className="self-end rounded-xl border border-[color:var(--color-border)] px-4 py-2 text-sm text-slate-400 hover:border-slate-500"
                        >
                          Cancel
                        </button>
                      </div>
                      {rideEditError && <p className="mt-2 text-xs text-red-400">{rideEditError}</p>}
                    </div>
                  );
                }

                return (
                  <div
                    key={ride.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-amber-700/50 bg-amber-950/30 px-4 py-3 text-sm"
                  >
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="font-semibold text-yellow-400">{ride.trip_name}</span>
                      <span className="text-xs text-slate-500">
                        {new Date(ride.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        {' · '}
                        {formatTimeRange(ride.started_at, ride.finished_at)}
                        {ride.duration_min != null ? ` · ${formatMinutes(ride.duration_min)}` : null}
                      </span>
                    </div>
                    <span className="text-xs text-slate-500">
                      {ride.start_soc_pct != null && ride.end_soc_pct != null
                        ? `${ride.start_soc_pct}%→${ride.end_soc_pct}%`
                        : null}
                      {ride.wh_per_mile != null
                        ? ` · ${ride.wh_per_mile < 100 ? ride.wh_per_mile.toFixed(1) : Math.round(ride.wh_per_mile)} Wh/mi`
                        : null}
                    </span>
                    <div className="flex items-center gap-2">
                      {ride.notes ? (
                        <button
                          type="button"
                          onClick={() => openNoteDialog(ride.id, 'display', ride.notes)}
                          className="rounded px-1.5 py-0.5 text-xs text-yellow-400 border border-yellow-700/40 hover:border-yellow-500"
                          title="View/edit note"
                        >
                          note
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openNoteDialog(ride.id, 'display', '')}
                          className="rounded px-1.5 py-0.5 text-xs text-slate-500 border border-[color:var(--color-border)] hover:border-slate-500"
                          title="Add note"
                        >
                          +note
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => startEditRide(ride)}
                        className="rounded p-1 text-base text-slate-500 hover:text-slate-300"
                        title="Edit ride"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        onClick={() => { setDeleteRideConfirmId(ride.id); setEditRideId(null); setRideEditError(''); }}
                        className="rounded p-1 text-base text-slate-500 hover:text-red-400"
                        title="Delete ride"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* Separator between pending and completed */}
              {(recentPendingRides.length > 0 || addingRide) && recentTripLegs.length > 0 && (
                <hr className="border-t border-[color:var(--color-border)] my-2" />
              )}

              {/* Column header for completed trips */}
              {recentTripLegs.length > 0 && (
                <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1.2fr)] px-4 text-xs text-slate-500">
                  <span className="flex items-center">Trip</span>
                  <span className="flex items-center">Date</span>
                  <span className="flex items-center">Trip Time</span>
                  <span className="flex items-center">Wh/mi</span>
                  <span className="flex items-center justify-end text-right">Cost</span>
                </div>
              )}

              {/* Completed trip leg rows */}
              {recentTripLegs.map((row) => {
                const { session, legNum, totalLegs, isMultiLeg, trip, durationMin, legStartedAt, isLastLeg } = row;
                const device = devices.find((d) => d.id === session.device_id);
                const isLF = !!device?.cost_free;
                const cellColor = isLF ? 'text-orange-300' : 'text-slate-300';
                const dateCellColor = isLF ? 'text-orange-300' : 'text-slate-500';
                const timeCellColor = isLF ? 'text-orange-300' : 'text-slate-500';
                const tripName = trip?.description ?? `Trip #${row.tripId}`;
                const legWhPerMile = session[`leg_${legNum}_wh_per_mile`] ?? null;
                const legStartSoc = session[`leg_${legNum}_start_soc_pct`] ?? null;
                const legEndSoc = session[`leg_${legNum}_end_soc_pct`] ?? null;
                let lastLegColor = 'text-slate-300';
                if (isLastLeg) {
                  if (isLF) {
                    lastLegColor = 'text-emerald-400';
                  } else if (session.hourly_savings_dollars != null) {
                    lastLegColor = session.hourly_savings_dollars > 0 ? 'text-emerald-400' : 'text-red-400';
                  }
                }
                return (
                  <div
                    key={`${session.id}-${legNum}`}
                    className={`grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1.2fr)] rounded-2xl border px-4 py-3 text-sm ${isLF ? 'bg-orange-950/30 border-orange-800/40' : 'border-[color:var(--color-border)] bg-[color:var(--color-surface-0)]'}`}
                  >
                    <span className={`flex items-center ${isLastLeg ? `font-semibold ${lastLegColor}` : `font-semibold italic ${cellColor}`}`}>
                      {tripName}
                      {isMultiLeg && (
                        <span className="ml-1.5 text-xs font-normal text-slate-500">
                          (leg {legNum} of {totalLegs})
                        </span>
                      )}
                    </span>
                    <span className={`flex items-center ${dateCellColor}`}>{formatDate(legStartedAt ?? session.started_at)}</span>
                    <span className={`flex items-center ${timeCellColor}`}>{formatMinutes(durationMin)}</span>
                    <span className="flex items-center text-slate-500 text-xs">
                      {legWhPerMile != null ? (
                        <>
                          {legStartSoc != null && legEndSoc != null && (
                            <span>{legStartSoc}%→{legEndSoc}% · </span>
                          )}
                          {legWhPerMile < 100
                            ? legWhPerMile.toFixed(1)
                            : Math.round(legWhPerMile)} Wh/mi
                        </>
                      ) : null}
                    </span>
                    <span className="flex items-start justify-end text-right">
                      {isLastLeg ? (
                        device?.cost_free ? (
                          session.lf_equivalent_cost_dollars != null ? (
                            <span className="flex flex-col items-end gap-0.5 text-xs leading-tight">
                              <span className="text-green-400">
                                vs Hourly: ${session.lf_equivalent_cost_dollars.toFixed(2)}
                              </span>
                              {session.lf_equivalent_fixed_dollars != null && (
                                <span className="text-amber-400">
                                  vs Fixed: ${session.lf_equivalent_fixed_dollars.toFixed(2)}
                                </span>
                              )}
                              {session.rebel_cost_total != null && (
                                <span className={`text-amber-400${session.rebel_cost_stale === 1 ? ' animate-pulse' : ''}`}>
                                  vs Rebel 250: ${session.rebel_cost_total.toFixed(2)}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-slate-400">$0.00</span>
                          )
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
                                  : 'text-red-400'
                              }
                            >
                              {(session.hourly_savings_dollars ?? 0) > 0
                                ? `Saved: $${(session.hourly_savings_dollars).toFixed(2)}`
                                : `Penalized: $${Math.abs(session.hourly_savings_dollars ?? 0).toFixed(2)}`}
                            </span>
                          </span>
                        ) : session.actual_cost_dollars != null ? (
                          <span className="text-slate-400">
                            ${session.actual_cost_dollars.toFixed(2)}
                          </span>
                        ) : null
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-slate-600">
              Pending rides shown in yellow{hasLFRow ? '; Lake Forest sessions in orange' : ''} — cost data reflects the final leg's charge session.
            </p>
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

      {/* Notes dialog */}
      <dialog
        ref={noteDialogRef}
        className="w-full max-w-md rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-6 text-slate-200 backdrop:bg-black/60"
      >
        <p className="mb-3 text-sm font-semibold text-slate-300">
          {noteMode === 'display' ? 'Note' : 'Add Note'}
        </p>
        <textarea
          className="w-full rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-3 py-2 text-sm text-slate-200 focus:outline-none"
          rows={4}
          value={noteValue}
          onChange={e => setNoteValue(e.target.value)}
          placeholder="Add a note…"
        />
        {noteError && <p className="mt-2 text-xs text-red-400">{noteError}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => { noteDialogRef.current.close(); setNoteError(''); }}
            className="rounded-xl border border-[color:var(--color-border)] px-4 py-2 text-sm text-slate-400 hover:border-slate-500"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleNoteSave}
            className="rounded-xl bg-[color:var(--color-accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[color:var(--color-accent-hover)]"
          >
            Save
          </button>
        </div>
      </dialog>

    </div>
  );
}
