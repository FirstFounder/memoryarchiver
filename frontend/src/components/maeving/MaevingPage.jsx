import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AreaChart, Area, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import {
  calibrateSession,
  deleteCalibrationEntry,
  deleteRide,
  deleteSession,
  getAllSessions,
  getConfig,
  getDevices,
  getLegs,
  getPendingRides,
  getSession,
  getSessionCurve,
  getSessionRideTelemetry,
  getSessionTaper,
  scheduleOvernight,
  startSession,
  stopSession,
  updateRide,
} from '../../api/maeving.js';
import { SOCSelector } from '../tesla/SOCRoller.jsx';
import { RideCard } from './RideCard.jsx';
import { LegsCard } from './LegsCard.jsx';
import RideTelemetryDetail from './RideTelemetryDetail.jsx';
const FIXED_RATE_CENTS = 7.8;
const TOTAL_WH = 2880;

// ── Formatting helpers ──────────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatEnergy(wh) {
  if (wh == null) return '—';
  if (wh >= 1000) return (wh / 1000).toFixed(2) + ' kWh';
  return Math.round(wh) + ' Wh';
}

function formatCtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
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
  return formatMinutes((new Date(endedAt) - new Date(startedAt)) / 60000);
}

function formatSessionDate(startedAt, endedAt) {
  if (!startedAt) return '—';
  const start = new Date(startedAt);
  const dateStr = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const startTime = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (!endedAt) return `${dateStr} ${startTime}`;
  const endTime = new Date(endedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${dateStr} ${startTime}–${endTime}`;
}

function formatDateOnly(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTimeOnly(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatTimeRange(startedAt, finishedAt) {
  if (!startedAt) return '';
  const fmt = iso => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (!finishedAt) return fmt(startedAt);
  return `${fmt(startedAt)}–${fmt(finishedAt)}`;
}

function formatEta(session, summary, liveApower, estimatedSoc, effectiveCapacity) {
  const socTarget = session.soc_target_pct ?? 100;
  const remainingWh = Math.max(0, ((socTarget - estimatedSoc) / 100) * effectiveCapacity);
  const watts = liveApower > 10 ? liveApower : (summary?.avg_watts ?? 0) > 10 ? summary.avg_watts : 250;
  if (watts < 10) return null;
  const etaMin = (remainingWh / watts) * 60;
  const h = Math.floor(etaMin / 60);
  const m = Math.round(etaMin % 60);
  if (h === 0 && m === 0) return `~0 min remaining`;
  if (h === 0) return `~${m} min remaining`;
  if (m === 0) return `~${h} hr remaining`;
  return `~${h} hr ${m} min remaining`;
}

function formatScheduledDuration(socStart, socTarget, effectiveCapacity) {
  const wh = Math.max(0, ((socTarget - socStart) / 100) * (effectiveCapacity ?? TOTAL_WH));
  const min = (wh / 1200) * 60;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0 && m === 0) return '< 1m';
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function getSessionRowClass(session, device) {
  if (device?.cost_free) return 'bg-orange-950/30 border-orange-800/40';
  const legCount = [1, 2, 3, 4, 5, 6, 7, 8].filter(n => session[`leg_${n}_trip_id`] != null).length;
  if (legCount === 1) return 'bg-green-950/30 border-green-800/40';
  return 'border-[color:var(--color-border)] bg-[color:var(--color-surface-0)]';
}

// ── ComEd pricing hook ──────────────────────────────────────────────────────

function useComEdPricing() {
  const [state, setState] = useState({ currentPrice: null, hourlyAvg: null, priceTrend: 'same', avgTrend: 'same' });
  const [loading, setLoading] = useState(false);
  const prevFiveMinPrice = useRef(null);
  const prevHourlyAvg = useRef(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [feedRes, avgRes] = await Promise.all([
        fetch('https://hourlypricing.comed.com/api?type=5minutefeed&format=json'),
        fetch('https://hourlypricing.comed.com/api?type=currenthouraverage&format=json'),
      ]);
      const [feedData, avgData] = await Promise.all([feedRes.json(), avgRes.json()]);
      const currentPrice = parseFloat(feedData[0]?.price);
      const hourlyAvg = parseFloat(avgData[0]?.price);
      const nextCurrentPrice = isNaN(currentPrice) ? null : currentPrice;
      const nextHourlyAvg = isNaN(hourlyAvg) ? null : hourlyAvg;
      let priceTrend = 'same';
      if (nextCurrentPrice != null && prevFiveMinPrice.current != null) {
        if (nextCurrentPrice > prevFiveMinPrice.current) priceTrend = 'up';
        else if (nextCurrentPrice < prevFiveMinPrice.current) priceTrend = 'down';
      }
      let avgTrend = 'same';
      if (nextHourlyAvg != null && prevHourlyAvg.current != null) {
        if (nextHourlyAvg > prevHourlyAvg.current) avgTrend = 'up';
        else if (nextHourlyAvg < prevHourlyAvg.current) avgTrend = 'down';
      }
      prevFiveMinPrice.current = nextCurrentPrice;
      prevHourlyAvg.current = nextHourlyAvg;
      setState({ currentPrice: nextCurrentPrice, hourlyAvg: nextHourlyAvg, priceTrend, avgTrend });
    } catch {
      prevFiveMinPrice.current = null;
      prevHourlyAvg.current = null;
      setState({ currentPrice: null, hourlyAvg: null, priceTrend: 'same', avgTrend: 'same' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  return { ...state, loading, refresh };
}

function getTrendProps(trend, fallbackArrow) {
  if (trend === 'down') return { arrow: '↓', className: 'text-green-400' };
  if (trend === 'up') return { arrow: '↑', className: 'text-red-400' };
  return { arrow: fallbackArrow, className: 'text-slate-100' };
}

function getHourlyAvgClass(hourlyAvg) {
  if (hourlyAvg == null) return { className: 'text-slate-400', isFlashing: false };
  if (hourlyAvg < 0) return { className: 'text-green-400', isFlashing: true };
  if (hourlyAvg < 2) return { className: 'text-green-400', isFlashing: false };
  if (hourlyAvg <= FIXED_RATE_CENTS) return { className: 'text-slate-100', isFlashing: false };
  if (hourlyAvg <= 10) return { className: 'text-amber-400', isFlashing: false };
  if (hourlyAvg <= 20) return { className: 'text-red-400', isFlashing: false };
  return { className: 'text-red-400', isFlashing: true };
}

// ── Charge Curve mini chart ─────────────────────────────────────────────────

function ChargeCurveChart({ curve, socStart, socEnd }) {
  if (!curve?.power_timeline_json) return null;
  return (
    <div>
      {(socStart != null || socEnd != null) && (
        <p className="mb-1 text-xs text-slate-400">
          SOC range: <span className="font-semibold text-slate-200">{socStart ?? '—'}%–{socEnd ?? '—'}%</span>
          {curve.device_label && <span className="ml-2 text-slate-500">· {curve.device_label}</span>}
          {curve.recorded_at && <span className="ml-2 text-slate-500">· {formatDate(curve.recorded_at)}</span>}
        </p>
      )}
      <ResponsiveContainer width="100%" height={140}>
        <AreaChart data={curve.power_timeline_json} margin={{ top: 8, right: 8, left: 8, bottom: 20 }}>
          <XAxis
            dataKey="t" type="number" domain={['dataMin', 'dataMax']}
            tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false}
            tickCount={6} tickFormatter={v => `${Math.round(v)}m`}
            label={{ value: 'time', position: 'insideBottomRight', offset: 0, fontSize: 9, fill: '#475569' }}
          />
          <YAxis
            dataKey="w" tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false}
            width={36} tickFormatter={v => `${v}W`}
          />
          <Area
            type="stepAfter" dataKey="w" stroke="#60a5fa" fill="#60a5fa" fillOpacity={0.2}
            dot={false} strokeWidth={1.5} isAnimationActive={false}
          />
          {curve.taper_onset_minutes != null && (
            <ReferenceLine
              x={curve.taper_onset_minutes} stroke="#f87171"
              label={{ value: 'Taper', fontSize: 10, fill: '#f87171', position: 'top' }}
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Session cost display ────────────────────────────────────────────────────

function SessionCostDisplay({ session, device, compact = false }) {
  if (device?.cost_free) {
    if (session.lf_equivalent_cost_dollars != null) {
      return (
        <span className={`flex flex-col items-start gap-0.5 text-xs leading-tight`}>
          <span className="text-green-400">vs Hourly: ${session.lf_equivalent_cost_dollars.toFixed(2)}</span>
          {session.lf_equivalent_fixed_dollars != null && (
            <span className="text-amber-400">vs Fixed: ${session.lf_equivalent_fixed_dollars.toFixed(2)}</span>
          )}
        </span>
      );
    }
    return <span className="text-slate-400">$0.00</span>;
  }
  if (session.fixed_rate_cost_dollars != null && session.actual_cost_dollars != null) {
    return (
      <span className="flex flex-col items-start gap-0.5 text-xs leading-tight">
        <span className={(session.hourly_savings_dollars ?? 0) > 0 ? 'text-green-400' : 'text-red-400'}>
          Hourly: ${session.actual_cost_dollars.toFixed(2)}
        </span>
        <span className="text-amber-400">Fixed: ${session.fixed_rate_cost_dollars.toFixed(2)}</span>
        <span className={(session.hourly_savings_dollars ?? 0) > 0 ? 'text-emerald-400' : 'text-red-400'}>
          {(session.hourly_savings_dollars ?? 0) > 0
            ? `Saved: $${session.hourly_savings_dollars.toFixed(2)}`
            : `Penalized: $${Math.abs(session.hourly_savings_dollars ?? 0).toFixed(2)}`}
        </span>
      </span>
    );
  }
  if (session.actual_cost_dollars != null) return <span className="text-slate-400">${session.actual_cost_dollars.toFixed(2)}</span>;
  if (session.estimated_cost_dollars != null) return <span className="text-slate-400">${session.estimated_cost_dollars.toFixed(2)}*</span>;
  return <span className="text-slate-400">—</span>;
}

// ── Pending ride row ─────────────────────────────────────────────────────────

function PendingRideRow({ ride, trips, editRideId, editRideForm, setEditRideForm, deleteRideConfirmId, rideEditError,
  onStartEdit, onSaveEdit, onCancelEdit, onDelete, onConfirmDelete, onCancelDelete, onOpenNote }) {
  const isEditing = editRideId === ride.id;
  const isConfirmingDelete = deleteRideConfirmId === ride.id;

  if (isConfirmingDelete) {
    return (
      <div className="rounded-2xl border border-red-800/50 bg-red-950/20 px-4 py-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-slate-300">Delete <span className="font-semibold text-slate-100">{ride.trip_name}</span>?</span>
          <div className="flex gap-2">
            <button onClick={() => onDelete(ride.id)} className="rounded-xl bg-red-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-red-600">Yes</button>
            <button onClick={onCancelDelete} className="rounded-xl border border-[color:var(--color-border)] px-4 py-1.5 text-sm text-slate-400 hover:border-slate-500">No</button>
          </div>
        </div>
        {rideEditError && <p className="mt-1 text-xs text-red-400">{rideEditError}</p>}
      </div>
    );
  }

  if (isEditing) {
    return (
      <div className="rounded-2xl border border-amber-700/50 bg-amber-950/30 px-4 py-3">
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
            onClick={() => onOpenNote(ride.id, 'edit', editRideForm.notes)}
            className="self-end rounded-xl border border-[color:var(--color-border)] px-3 py-1.5 text-xs text-slate-400 hover:border-slate-500"
          >
            {editRideForm.notes ? 'Edit Note' : 'Note'}
          </button>
          <button onClick={() => onSaveEdit(ride.id)} className="self-end rounded-xl bg-[color:var(--color-accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[color:var(--color-accent-hover)]">Save</button>
          <button onClick={onCancelEdit} className="self-end rounded-xl border border-[color:var(--color-border)] px-4 py-2 text-sm text-slate-400 hover:border-slate-500">Cancel</button>
        </div>
        <div className="mt-3 flex flex-wrap gap-4 items-start">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={editRideForm.windbreaker === 1}
              onChange={e => setEditRideForm(f => ({ ...f, windbreaker: e.target.checked ? 1 : null }))}
              className="h-4 w-4 accent-blue-500" />
            <span className="text-xs text-slate-400">Windbreaker</span>
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-slate-500">Overheat</span>
            {editRideForm.overheat_pack === null && editRideForm.overheat_motor === null && editRideForm.overheat_level === null ? (
              <button
                onClick={() => setEditRideForm(f => ({ ...f, overheat_pack: 1, overheat_motor: 0, overheat_level: 2 }))}
                className="rounded-xl border border-[color:var(--color-border)] px-3 py-1 text-xs text-slate-400 hover:border-slate-500"
              >+ Add</button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 cursor-pointer select-none text-xs text-slate-300">
                  <input type="checkbox" checked={!!editRideForm.overheat_pack}
                    onChange={e => setEditRideForm(f => ({ ...f, overheat_pack: e.target.checked ? 1 : 0 }))}
                    className="h-3.5 w-3.5 accent-orange-500" />
                  Pack
                </label>
                <label className="flex items-center gap-1 cursor-pointer select-none text-xs text-slate-300">
                  <input type="checkbox" checked={!!editRideForm.overheat_motor}
                    onChange={e => setEditRideForm(f => ({ ...f, overheat_motor: e.target.checked ? 1 : 0 }))}
                    className="h-3.5 w-3.5 accent-orange-500" />
                  Motor
                </label>
                <select
                  className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-1.5 py-1 text-xs text-slate-200"
                  value={editRideForm.overheat_level ?? ''}
                  onChange={e => setEditRideForm(f => ({ ...f, overheat_level: e.target.value ? Number(e.target.value) : null }))}
                >
                  <option value="">—</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                </select>
                <button onClick={() => setEditRideForm(f => ({ ...f, overheat_pack: null, overheat_motor: null, overheat_level: null }))}
                  className="text-xs text-slate-500 hover:text-slate-300">✕ Clear</button>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-slate-500">Sporty</span>
            <select
              className="rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-2 py-1.5 text-xs text-slate-200"
              value={editRideForm.sporty_level ?? ''}
              onChange={e => setEditRideForm(f => ({ ...f, sporty_level: e.target.value ? Number(e.target.value) : null }))}
            >
              <option value="">None</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </select>
          </div>
        </div>
        {rideEditError && <p className="mt-2 text-xs text-red-400">{rideEditError}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-amber-700/50 bg-amber-950/30 px-4 py-3 text-sm">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="font-semibold text-yellow-400">{ride.trip_name}</span>
        <span className="text-xs text-slate-500">
          {new Date(ride.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          {' · '}{formatTimeRange(ride.started_at, ride.finished_at)}
          {ride.duration_min != null ? ` · ${formatMinutes(ride.duration_min)}` : null}
        </span>
      </div>
      <span className="text-xs text-slate-500">
        {ride.start_soc_pct != null && ride.end_soc_pct != null ? `${ride.start_soc_pct}%→${ride.end_soc_pct}%` : null}
        {ride.wh_per_mile != null ? ` · ${ride.wh_per_mile < 100 ? ride.wh_per_mile.toFixed(1) : Math.round(ride.wh_per_mile)} Wh/mi` : null}
      </span>
      <div className="flex items-center gap-2">
        {ride.notes ? (
          <button onClick={() => onOpenNote(ride.id, 'display', ride.notes)}
            className="rounded px-1.5 py-0.5 text-xs text-yellow-400 border border-yellow-700/40 hover:border-yellow-500" title="View/edit note">note</button>
        ) : (
          <button onClick={() => onOpenNote(ride.id, 'display', '')}
            className="rounded px-1.5 py-0.5 text-xs text-slate-500 border border-[color:var(--color-border)] hover:border-slate-500" title="Add note">+note</button>
        )}
        <button onClick={() => onStartEdit(ride)} className="rounded p-1 text-base text-slate-500 hover:text-slate-300" title="Edit ride">✎</button>
        <button onClick={() => onConfirmDelete(ride.id)} className="rounded p-1 text-base text-slate-500 hover:text-red-400" title="Delete ride">×</button>
      </div>
    </div>
  );
}

// ── Trip legs table rows ─────────────────────────────────────────────────────

function TripSessionRows({ session, devices, trips, expandedLegKey, sessionTelemetryCache, telemetryLoading, onLegClick, onLegClose }) {
  const device = devices.find(d => d.id === session.device_id);
  const isLF = !!device?.cost_free;
  const legNums = [1, 2, 3, 4, 5, 6, 7, 8].filter(n => session[`leg_${n}_trip_id`] != null);
  if (legNums.length === 0) return null;
  const totalLegs = legNums.length;
  const isMultiLeg = totalLegs > 1;

  return (
    <>
      {legNums.map((n) => {
        const tripId = session[`leg_${n}_trip_id`];
        const trip = trips.find(t => t.id === tripId);
        const tripName = trip?.description ?? `Trip #${tripId}`;
        const durationMin = session[`leg_${n}_duration_min`];
        const legStartedAt = session[`leg_${n}_started_at`];
        const legWhPerMile = session[`leg_${n}_wh_per_mile`] ?? null;
        const legStartSoc = session[`leg_${n}_start_soc_pct`] ?? null;
        const legEndSoc = session[`leg_${n}_end_soc_pct`] ?? null;
        const isLastLeg = n === legNums[legNums.length - 1];
        const key = `${session.id}-${n}`;

        let lastLegColor = 'text-slate-300';
        if (isLastLeg) {
          if (isLF) lastLegColor = 'text-emerald-400';
          else if (session.hourly_savings_dollars != null) {
            lastLegColor = session.hourly_savings_dollars > 0 ? 'text-emerald-400' : 'text-red-400';
          }
        }

        return (
          <React.Fragment key={key}>
            <div
              className={`grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1.2fr)] rounded-2xl border px-4 py-3 text-sm cursor-pointer hover:border-slate-500 ${isLF ? 'bg-orange-950/30 border-orange-800/40' : 'border-[color:var(--color-border)] bg-[color:var(--color-surface-0)]'}`}
              onClick={() => onLegClick(session.id, n)}
            >
              <span className={`flex items-center ${isLastLeg ? `font-semibold ${lastLegColor}` : `font-semibold italic text-slate-300`}`}>
                {tripName}
                {isMultiLeg && <span className="ml-1.5 text-xs font-normal text-slate-500">(leg {n} of {totalLegs})</span>}
              </span>
              <span className={`flex items-center ${isLF ? 'text-orange-300' : 'text-slate-500'}`}>{formatDate(legStartedAt ?? session.started_at)}</span>
              <span className={`flex items-center ${isLF ? 'text-orange-300' : 'text-slate-500'}`}>{formatMinutes(durationMin)}</span>
              <span className="flex items-center text-slate-500 text-xs">
                {legWhPerMile != null ? (
                  <>
                    {legStartSoc != null && legEndSoc != null && <span>{legStartSoc}%→{legEndSoc}% · </span>}
                    {legWhPerMile < 100 ? legWhPerMile.toFixed(1) : Math.round(legWhPerMile)} Wh/mi
                  </>
                ) : null}
              </span>
              <span className="flex items-start justify-end text-right">
                {isLastLeg ? <SessionCostDisplay session={session} device={device} /> : null}
              </span>
            </div>
            {expandedLegKey === key && (
              <RideTelemetryDetail
                legData={sessionTelemetryCache[session.id]?.legs?.[n] ?? null}
                sessionLeg={{ session, legNum: n, trip, durationMin, legStartedAt }}
                onClose={onLegClose}
              />
            )}
            {expandedLegKey === key && telemetryLoading && (
              <div className="px-4 py-2 text-xs text-slate-500">Loading route data…</div>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}

// ── Session row (for charge session tables) ──────────────────────────────────

function SessionRow({ session, device, devices, deleteSessionConfirmId, calibrateSocMap, expandedCurveId,
  onConfirmDelete, onCancelDelete, onDelete, onCalibrateSocChange, onCalibrate, onToggleCurve, showCurveButton = false }) {
  const needsCalibration =
    (session.status === 'complete' || session.status === 'charger_complete') &&
    session.calibration_complete === 1 && session.actual_soc_pct == null && (session.wh_delivered ?? 0) > 0;
  const rowClass = getSessionRowClass(session, device);
  const isConfirmingDelete = deleteSessionConfirmId === session.id;
  const calSoc = calibrateSocMap[session.id] ?? (session.soc_target_pct ?? 60);

  if (isConfirmingDelete) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-red-800/50 bg-red-950/20 px-4 py-3 text-sm">
        <span className="text-slate-300">
          Delete <span className="font-semibold text-slate-100">{device?.site_key ?? '?'}</span> session from{' '}
          <span className="font-semibold text-slate-100">{formatDate(session.started_at)}</span>?
        </span>
        <div className="flex gap-2">
          <button onClick={() => onDelete(session.id)} className="rounded-xl bg-red-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-red-600">Delete</button>
          <button onClick={onCancelDelete} className="rounded-xl border border-[color:var(--color-border)] px-4 py-1.5 text-sm text-slate-400 hover:border-slate-500">Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-2xl border px-4 py-3 text-sm ${rowClass}`}>
      <div className="grid grid-cols-[4rem_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.8fr)_auto] items-center gap-x-3 min-w-0">
        <span className="whitespace-nowrap font-semibold text-slate-300">
          {device?.site_key ?? '?'}
          {session.charge_mode === 'auto' && (
            <span className="ml-1.5 rounded bg-sky-800/60 px-1 py-0.5 text-xs font-normal text-sky-300">auto</span>
          )}
          {needsCalibration && <span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-amber-400" title="Calibration pending" />}
        </span>
        <div className="flex flex-col gap-0.5 text-xs">
          <span className="text-slate-400">{formatDateOnly(session.started_at)}</span>
          <span className="text-slate-500">{formatTimeOnly(session.started_at)}</span>
          {session.ended_at && <span className="text-slate-500">{formatTimeOnly(session.ended_at)}</span>}
        </div>
        <span className="text-slate-400">{formatEnergy(session.wh_delivered)}</span>
        <span className="whitespace-nowrap text-slate-500">{session.soc_start_pct ?? '—'}% → {session.actual_soc_pct ?? session.soc_target_pct ?? '—'}%</span>
        <span className="text-slate-500">{formatChargeTime(session.started_at, session.ended_at)}</span>
        <SessionCostDisplay session={session} device={device} />
        <div className="flex items-center gap-1.5">
          {needsCalibration && (
            <>
              <div className="flex flex-col items-center">
                <button onClick={() => onCalibrateSocChange(session.id, Math.min(100, calSoc + 1))}
                  className="rounded px-1 py-0 text-xs text-slate-400 hover:text-slate-200 leading-none">▲</button>
                <span className="w-9 text-center text-xs font-semibold text-slate-200">{calSoc}%</span>
                <button onClick={() => onCalibrateSocChange(session.id, Math.max(0, calSoc - 1))}
                  className="rounded px-1 py-0 text-xs text-slate-400 hover:text-slate-200 leading-none">▼</button>
              </div>
              <button onClick={() => onCalibrate(session.id, calSoc)}
                className="whitespace-nowrap rounded-xl border border-amber-600/60 bg-amber-900/20 px-2.5 py-1 text-xs font-semibold text-amber-400 hover:bg-amber-900/50">
                Calibrate
              </button>
            </>
          )}
          {showCurveButton && (
            <button onClick={() => onToggleCurve(session.id)}
              className={`rounded px-1.5 py-0.5 text-xs border transition-colors ${expandedCurveId === session.id ? 'border-blue-500 text-blue-300' : 'border-[color:var(--color-border)] text-slate-500 hover:border-slate-500'}`}
              title="View charge curve">
              {expandedCurveId === session.id ? '▾ curve' : '▸ curve'}
            </button>
          )}
          <button onClick={() => onConfirmDelete(session.id)} className="rounded p-1 text-slate-600 hover:text-red-400" title="Delete session">🗑</button>
        </div>
      </div>
    </div>
  );
}

// ── ExpandedCurve component ──────────────────────────────────────────────────

function ExpandedSessionCurve({ session, curveCache, onFetch }) {
  const sessionId = session.id;
  const entry = curveCache[sessionId];

  useEffect(() => {
    if (entry === undefined) onFetch(sessionId);
  }, [sessionId]);

  if (entry === undefined || entry === 'loading') {
    return <div className="px-4 py-2 text-xs text-slate-500">Loading curve…</div>;
  }
  if (entry === null) {
    return <div className="px-4 py-2 text-xs text-slate-500">No curve data for this session.</div>;
  }
  return (
    <div className="rounded-2xl border border-blue-800/30 bg-blue-950/10 px-4 py-3 mt-1">
      <ChargeCurveChart curve={entry} socStart={session.soc_start_pct} socEnd={session.actual_soc_pct ?? session.soc_target_pct} />
    </div>
  );
}

// ── Main page component ──────────────────────────────────────────────────────

export default function MaevingPage() {
  // Sidebar
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeSection, setActiveSection] = useState('ride');

  // Pricing
  const { currentPrice, hourlyAvg, priceTrend, avgTrend, loading: comedLoading, refresh: refreshComed } = useComEdPricing();
  const lastPriceArrow = useRef('↑');
  const lastAvgArrow = useRef('↑');
  if (priceTrend !== 'same') lastPriceArrow.current = priceTrend === 'up' ? '↑' : '↓';
  if (avgTrend !== 'same') lastAvgArrow.current = avgTrend === 'up' ? '↑' : '↓';
  const priceTrendProps = getTrendProps(priceTrend, lastPriceArrow.current);
  const avgTrendProps = getTrendProps(avgTrend, lastAvgArrow.current);
  const { className: currentPriceClass, isFlashing: currentPriceFlashing } = getHourlyAvgClass(currentPrice);
  const { className: hourlyAvgClass, isFlashing: hourlyAvgFlashing } = getHourlyAvgClass(hourlyAvg);

  // Maeving totals for header
  const [maevingTotals, setMaevingTotals] = useState({});
  useEffect(() => {
    let active = true;
    async function fetchTotals() {
      try {
        const res = await fetch('/api/maeving/config');
        if (res.ok && active) {
          const data = await res.json();
          setMaevingTotals({
            totalMiles: data.total_miles > 0 ? data.total_miles : null,
            whPerMile: data.avg_wh_per_mile ?? null,
            totalKwh: data.total_wh_added != null ? data.total_wh_added / 1000 : null,
            totalSpent: data.total_money_spent ?? null,
            savings: data.running_savings_dollars ?? null,
            rebelTotal: data.total_rebel_cost ?? null,
          });
        }
      } catch { /* silent */ }
    }
    fetchTotals();
    const id = setInterval(fetchTotals, 60_000);
    return () => { active = false; clearInterval(id); };
  }, []);

  // Core data
  const [devices, setDevices] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [activeSessions, setActiveSessions] = useState({});
  const [sessionDetails, setSessionDetails] = useState(null);
  const [allSessions, setAllSessions] = useState([]);
  const [trips, setTrips] = useState([]);
  const [config, setConfig] = useState(null);
  const [pendingRides, setPendingRides] = useState([]);
  const [checkedRideIds, setCheckedRideIds] = useState(() => new Set());
  const [recentPendingRides, setRecentPendingRides] = useState([]);

  // Charging section state
  const [socStart, setSocStart] = useState(50);
  const [socTarget, setSocTarget] = useState(90);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [schedulingOvernight, setSchedulingOvernight] = useState(false);
  const [error, setError] = useState('');
  const [taperData, setTaperData] = useState(null);
  const [deleteSessionConfirmId, setDeleteSessionConfirmId] = useState(null);
  const [calibrateSocMap, setCalibrateSocMap] = useState({});
  const [showCapacityHistory, setShowCapacityHistory] = useState(false);
  const [showHistoricalSessions, setShowHistoricalSessions] = useState(false);
  const [confirmDeleteCalIdx, setConfirmDeleteCalIdx] = useState(null);
  const [expandedCurveId, setExpandedCurveId] = useState(null);
  const [curveCache, setCurveCache] = useState({});

  // Trips section state
  const [editRideId, setEditRideId] = useState(null);
  const [editRideForm, setEditRideForm] = useState({});
  const [rideEditError, setRideEditError] = useState('');
  const [deleteRideConfirmId, setDeleteRideConfirmId] = useState(null);
  const [noteMode, setNoteMode] = useState('display');
  const [noteRideId, setNoteRideId] = useState(null);
  const [noteValue, setNoteValue] = useState('');
  const [noteError, setNoteError] = useState('');
  const noteDialogRef = useRef(null);
  const [expandedLegKey, setExpandedLegKey] = useState(null);
  const [sessionTelemetryCache, setSessionTelemetryCache] = useState({});
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [showAllTrips, setShowAllTrips] = useState(false);

  const detailsIntervalRef = useRef(null);
  const taperIntervalRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const [devs, all, tripList, cfg, pendingList] = await Promise.all([
        getDevices(),
        getAllSessions(),
        getLegs(),
        getConfig(),
        getPendingRides(),
      ]);
      setDevices(devs);
      const activeDeviceId = all.find(s => s.status === 'active' || s.status === 'scheduled')?.device_id ?? null;
      setSelectedId(prev => prev ?? activeDeviceId ?? devs[0]?.id ?? null);
      setTrips(tripList);
      setConfig(cfg);
      setSocStart(cfg.prev_max_soc_pct ?? 50);
      const map = {};
      for (const s of all.filter(s => s.status === 'active' || s.status === 'scheduled')) map[s.device_id] = s;
      setActiveSessions(map);
      setAllSessions(all.filter(s => s.status !== 'active' && s.status !== 'scheduled'));
      setRecentPendingRides(pendingList);
      setPendingRides(pendingList);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { refresh(); const id = setInterval(refresh, 15_000); return () => clearInterval(id); }, [refresh]);

  const activeSession = activeSessions[selectedId] ?? null;
  const selectedDevice = devices.find(d => d.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedDevice || activeSession) return;
    const siteKey = selectedDevice.site_key;
    if (siteKey === 'MH') setSocTarget(90);
    else if (siteKey === 'BG') setSocTarget(socStart < 40 ? 40 : 90);
    else setSocTarget(selectedDevice.default_soc_target ?? 95);
  }, [selectedDevice?.id, !!activeSession]);

  useEffect(() => {
    if (detailsIntervalRef.current) { clearInterval(detailsIntervalRef.current); detailsIntervalRef.current = null; }
    if (!activeSession) { setSessionDetails(null); return; }
    async function fetchDetails() {
      try { setSessionDetails(await getSession(activeSession.id)); } catch { /* ignore */ }
    }
    fetchDetails();
    detailsIntervalRef.current = setInterval(fetchDetails, 30_000);
    return () => clearInterval(detailsIntervalRef.current);
  }, [activeSession?.id]);

  useEffect(() => {
    if (taperIntervalRef.current) { clearInterval(taperIntervalRef.current); taperIntervalRef.current = null; }
    if (!activeSession || activeSession.soc_target_pct !== 100) { setTaperData(null); return; }
    async function fetchTaper() {
      try { setTaperData(await getSessionTaper(activeSession.id)); } catch { /* ignore */ }
    }
    fetchTaper();
    taperIntervalRef.current = setInterval(fetchTaper, 60_000);
    return () => { if (taperIntervalRef.current) clearInterval(taperIntervalRef.current); };
  }, [activeSession?.id, activeSession?.soc_target_pct]);

  useEffect(() => {
    if (!selectedId || activeSession) return;
    let mounted = true;
    getPendingRides().then(rides => {
      if (!mounted) return;
      setPendingRides(rides);
      setCheckedRideIds(new Set(rides.map(r => r.id)));
    }).catch(() => {});
    return () => { mounted = false; };
  }, [selectedId, activeSession?.id]);

  useEffect(() => () => { if (taperIntervalRef.current) clearInterval(taperIntervalRef.current); }, []);

  const liveState = selectedDevice?.live ?? null;
  const liveApower = liveState?.apower ?? 0;
  const checkedCount = checkedRideIds.size;
  const isOverLimit = checkedCount > 8;
  const isScheduled = activeSession?.status === 'scheduled';
  const isCharging = activeSession?.status === 'active';
  const estCost = activeSession?.estimated_cost_dollars;

  function resetPlugInForm() { setError(''); setPendingRides([]); setCheckedRideIds(new Set()); }
  function toggleRideCheck(id) {
    setCheckedRideIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  function buildLegData() {
    const legData = {};
    const checkedRides = pendingRides.filter(r => checkedRideIds.has(r.id)).sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
    let slotIdx = 0;
    for (const ride of checkedRides) {
      if (slotIdx >= 8) break;
      slotIdx++;
      legData[`leg_${slotIdx}_trip_id`] = ride.trip_id;
      legData[`leg_${slotIdx}_ride_id`] = ride.id;
      legData[`leg_${slotIdx}_started_at`] = ride.started_at;
      if (ride.duration_min != null) legData[`leg_${slotIdx}_duration_min`] = Math.round(ride.duration_min);
    }
    return legData;
  }

  async function handleChargeNow() {
    if (!selectedId || starting || schedulingOvernight) return;
    setStarting(true); setError('');
    try {
      const session = await startSession({ device_id: selectedId, soc_start_pct: socStart, soc_target_pct: socTarget, charge_mode: 'now', ...buildLegData() });
      setActiveSessions(prev => ({ ...prev, [selectedId]: session }));
      resetPlugInForm();
    } catch (err) { setError(err.message); } finally { setStarting(false); }
  }

  async function handleScheduleOvernight() {
    if (!selectedId || starting || schedulingOvernight) return;
    setSchedulingOvernight(true); setError('');
    try {
      const session = await startSession({ device_id: selectedId, soc_start_pct: socStart, soc_target_pct: socTarget, charge_mode: 'scheduled', ...buildLegData() });
      setActiveSessions(prev => ({ ...prev, [selectedId]: session }));
      await scheduleOvernight(session.id, {});
      await refresh();
    } catch (err) { setError(err.message); } finally { setSchedulingOvernight(false); }
  }

  async function handleStop() {
    if (!activeSession || stopping) return;
    setStopping(true); setError('');
    try {
      await stopSession(activeSession.id);
      setActiveSessions(prev => { const next = { ...prev }; delete next[selectedId]; return next; });
      setSessionDetails(null); setTaperData(null);
      await refresh();
    } catch (err) { setError(err.message); } finally { setStopping(false); }
  }

  async function handleDeleteSession(id) {
    try { await deleteSession(id); setDeleteSessionConfirmId(null); await refresh(); } catch (err) { console.error('Failed to delete session', err); }
  }

  async function handleCalibrateSession(sessionId, socPct) {
    try {
      await calibrateSession(sessionId, socPct);
      setCalibrateSocMap(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
      await refresh();
    } catch (err) { console.error('Calibrate failed', err); }
  }

  async function handleDeleteCalEntry(displayIdx) {
    const offset = (config.observation_count ?? 0) - (config.capacityHistory?.length ?? 0);
    try { await deleteCalibrationEntry(offset + displayIdx); setConfirmDeleteCalIdx(null); await refresh(); }
    catch (err) { console.error('Failed to delete calibration entry', err); }
  }

  async function handleFetchCurve(sessionId) {
    if (curveCache[sessionId] !== undefined) return;
    setCurveCache(prev => ({ ...prev, [sessionId]: 'loading' }));
    try {
      const curve = await getSessionCurve(sessionId);
      setCurveCache(prev => ({ ...prev, [sessionId]: curve ?? null }));
    } catch {
      setCurveCache(prev => ({ ...prev, [sessionId]: null }));
    }
  }

  function handleToggleCurve(sessionId) {
    setExpandedCurveId(prev => prev === sessionId ? null : sessionId);
  }

  // ── Pending rides edit handlers ───────────────────────────────────────────

  function startEditRide(ride) {
    setEditRideId(ride.id);
    setEditRideForm({
      trip_id: ride.trip_id ?? '', end_soc_pct: ride.end_soc_pct ?? '', notes: ride.notes ?? '',
      windbreaker: ride.windbreaker ?? null, overheat_pack: ride.overheat_pack ?? null,
      overheat_motor: ride.overheat_motor ?? null, overheat_level: ride.overheat_level ?? null,
      sporty_level: ride.sporty_level ?? null,
    });
    setRideEditError(''); setDeleteRideConfirmId(null);
  }

  async function handleSaveRideEdit(id) {
    setRideEditError('');
    const payload = {};
    if (editRideForm.trip_id !== '') payload.trip_id = Number(editRideForm.trip_id);
    if (editRideForm.end_soc_pct !== '') payload.end_soc_pct = Number(editRideForm.end_soc_pct);
    if (editRideForm.notes !== undefined) payload.notes = editRideForm.notes;
    payload.windbreaker = editRideForm.windbreaker !== '' ? editRideForm.windbreaker : null;
    payload.overheat_pack = editRideForm.overheat_pack !== '' ? editRideForm.overheat_pack : null;
    payload.overheat_motor = editRideForm.overheat_motor !== '' ? editRideForm.overheat_motor : null;
    payload.overheat_level = editRideForm.overheat_level !== '' ? editRideForm.overheat_level : null;
    payload.sporty_level = editRideForm.sporty_level !== '' ? editRideForm.sporty_level : null;
    try { await updateRide(id, payload); setEditRideId(null); await refresh(); }
    catch (err) { setRideEditError(err.message); }
  }

  async function handleDeleteRide(id) {
    try { await deleteRide(id); setDeleteRideConfirmId(null); await refresh(); }
    catch (err) { setRideEditError(err.message); }
  }

  function openNoteDialog(rideId, mode, currentNote) {
    setNoteRideId(rideId); setNoteMode(mode); setNoteValue(currentNote ?? ''); setNoteError('');
    noteDialogRef.current.showModal();
  }

  async function handleNoteSave() {
    if (noteMode === 'display') {
      try {
        await updateRide(noteRideId, { notes: noteValue || null });
        noteDialogRef.current.close(); setNoteError(''); await refresh();
      } catch (err) { setNoteError(err.message); }
    } else {
      setEditRideForm(f => ({ ...f, notes: noteValue }));
      noteDialogRef.current.close();
    }
  }

  async function handleLegRowClick(sessionId, legNum) {
    const key = `${sessionId}-${legNum}`;
    if (expandedLegKey === key) { setExpandedLegKey(null); return; }
    setExpandedLegKey(key);
    if (!sessionTelemetryCache[sessionId]) {
      setTelemetryLoading(true);
      try {
        const data = await getSessionRideTelemetry(sessionId);
        setSessionTelemetryCache(prev => ({ ...prev, [sessionId]: data }));
      } catch { setSessionTelemetryCache(prev => ({ ...prev, [sessionId]: { legs: {} } })); }
      finally { setTelemetryLoading(false); }
    }
  }

  // ── Derived data ──────────────────────────────────────────────────────────

  const recentSessions = allSessions.slice(0, 5);

  // Sessions that have at least one leg (are "trips")
  const tripSessions = allSessions.filter(s => s.leg_1_trip_id != null);
  const recentTripSessions = tripSessions.slice(0, 5);

  // Latest charge curve session
  const latestCurveSession = config?.latestChargeCurve?.session_id
    ? allSessions.find(s => s.id === config.latestChargeCurve.session_id)
    : null;

  // ── Sidebar nav ───────────────────────────────────────────────────────────

  const navItems = [
    { id: 'ride', label: 'Ride', icon: '🛵' },
    { id: 'charging', label: 'Charging', icon: '⚡' },
    { id: 'trips', label: 'Trips', icon: '🗺️' },
  ];

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <style>{'@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }'}</style>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="border-b border-slate-800 px-6 py-4 flex items-center gap-3 shrink-0">
        <span className="text-xl">🎬</span>
        <h1 className="text-slate-100 font-semibold tracking-tight">
          <a href="/" className="hover:text-indigo-300 transition-colors">Memory Archiver</a>
        </h1>
        <span className="text-slate-600 text-xs ml-auto flex items-center gap-2">
          H.265 · {'{Fam|Vault}'}
          {maevingTotals.totalMiles != null && (
            <span className="flex flex-col items-center gap-0">
              <span className="inline-flex items-center rounded bg-white px-1.5 py-0.5 text-base font-semibold" style={{ color: '#0047AB', fontSize: '1.2em' }}>
                {Math.round(maevingTotals.totalMiles)} mi
              </span>
              <span className="text-xs text-slate-500 leading-tight">miles logged</span>
            </span>
          )}
          {maevingTotals.whPerMile != null && (
            <span className="flex flex-col items-center gap-0">
              <span className="inline-flex items-center rounded bg-white px-1.5 py-0.5 text-base font-semibold" style={{ color: '#0047AB', fontSize: '1.2em' }}>
                {Math.round(maevingTotals.whPerMile)} Wh/mi
              </span>
              <span className="text-xs text-slate-500 leading-tight">efficiency</span>
            </span>
          )}
          {maevingTotals.totalKwh != null && (
            <span className="flex flex-col items-center gap-0">
              <span className="inline-flex items-center rounded bg-white px-1.5 py-0.5 text-base font-semibold" style={{ color: '#0047AB', fontSize: '1.2em' }}>
                {maevingTotals.totalKwh.toFixed(2)} kWh
              </span>
              <span className="text-xs text-slate-500 leading-tight">added</span>
            </span>
          )}
          {maevingTotals.totalSpent != null && (
            <span className="flex flex-col items-center gap-0">
              <span className="inline-flex items-center rounded bg-white px-1.5 py-0.5 text-base font-semibold" style={{ color: '#0047AB', fontSize: '1.2em' }}>
                ${maevingTotals.totalSpent.toFixed(2)}
              </span>
              <span className="text-xs text-slate-500 leading-tight">spent</span>
            </span>
          )}
          {maevingTotals.savings != null && (
            <span className="flex flex-col items-center gap-0">
              <span className="inline-flex items-center rounded bg-white px-1.5 py-0.5 text-base font-semibold" style={{ color: '#0047AB', fontSize: '1.2em' }}>
                ${maevingTotals.savings.toFixed(2)}
              </span>
              <span className="text-xs text-slate-500 leading-tight">saved</span>
            </span>
          )}
          {maevingTotals.rebelTotal != null && (
            <span className="flex flex-col items-center gap-0">
              <span className="inline-flex items-center rounded bg-white px-1.5 py-0.5 text-base font-semibold" style={{ color: '#CC0000', fontSize: '1.2em' }}>
                ${maevingTotals.rebelTotal.toFixed(2)}
              </span>
              <span className="text-xs text-slate-500 leading-tight">Rebel 250</span>
            </span>
          )}
          <span className="text-slate-600">·</span>
          <span className={`${priceTrendProps.className} text-base`} style={{ fontSize: '1.2em' }}>{priceTrendProps.arrow}</span>
          <span className={`${currentPriceClass} text-base`} style={{ fontSize: '1.2em', ...(currentPriceFlashing ? { animation: 'blink 1s step-start infinite' } : {}) }}>
            {currentPrice != null ? `${currentPrice.toFixed(1)}¢` : '—'}
          </span>
          <span className={`${avgTrendProps.className} text-base`} style={{ fontSize: '1.2em' }}>{avgTrendProps.arrow}</span>
          <span className={`${hourlyAvgClass} text-base`} style={hourlyAvgFlashing ? { animation: 'blink 1s step-start infinite' } : undefined}>
            {hourlyAvg != null ? `${hourlyAvg.toFixed(1)}¢` : '—'}
          </span>
          <button onClick={refreshComed} disabled={comedLoading} aria-label="Refresh ComEd price"
            className={`text-slate-500 hover:text-slate-300 transition-colors leading-none${comedLoading ? ' opacity-50' : ''}`}>↻</button>
        </span>
      </header>

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">

        {/* ── Sidebar ─────────────────────────────────────────────────── */}
        <nav className={`shrink-0 border-r border-slate-800 flex flex-col transition-all duration-200 ${sidebarCollapsed ? 'w-12' : 'w-48'}`}>
          <button
            onClick={() => setSidebarCollapsed(c => !c)}
            className="flex items-center justify-center h-12 text-slate-500 hover:text-slate-300 border-b border-slate-800 transition-colors"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? '▶' : '◀'}
          </button>
          <div className="flex flex-col pt-2">
            {navItems.map(item => (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                className={`flex items-center gap-3 px-3 py-3 text-sm transition-colors ${
                  activeSection === item.id
                    ? 'bg-slate-800 text-slate-100 border-l-2 border-indigo-500'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 border-l-2 border-transparent'
                }`}
              >
                <span className="text-base shrink-0">{item.icon}</span>
                {!sidebarCollapsed && <span className="font-medium">{item.label}</span>}
              </button>
            ))}
          </div>
        </nav>

        {/* ── Main content ─────────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto">

          {/* ── Ride section ─────────────────────────────────────────── */}
          {activeSection === 'ride' && (
            <div className="p-4 sm:p-6 flex flex-col gap-6 max-w-lg mx-auto">
              <RideCard />
            </div>
          )}

          {/* ── Charging section ─────────────────────────────────────── */}
          {activeSection === 'charging' && (
            <div className="p-6 flex flex-col gap-6 max-w-5xl">

              {/* Device selector */}
              <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-4 sm:p-6">
                <div className="mb-4 flex items-center">
                  <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Maeving RM1S</p>
                  <a href="/api/maeving/export-db" download
                    className="ml-auto text-xs px-2 py-1 rounded border border-slate-600 text-slate-400 hover:text-slate-200 hover:border-slate-400 transition-colors">
                    Export DB
                  </a>
                </div>
                <div className="grid grid-cols-3 gap-3 sm:flex sm:flex-wrap">
                  {devices.map(device => {
                    const isSelected = device.id === selectedId;
                    const live = device.live;
                    const isOnline = live?.online === true;
                    const watts = live?.apower ?? 0;
                    return (
                      <button key={device.id} type="button" onClick={() => { setSelectedId(device.id); setError(''); }}
                        disabled={isCharging && device.id !== selectedId}
                        className={`min-h-16 rounded-2xl border px-5 py-4 text-left transition-colors ${isSelected ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/20 text-slate-50' : 'border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] text-slate-300 hover:border-slate-500'}${isCharging && device.id !== selectedId ? ' cursor-not-allowed opacity-40' : ''}`}>
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

              {/* Plug In card */}
              {selectedDevice && (
                <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
                  {activeSession ? (
                    <div className="flex flex-col gap-4">
                      <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">
                        {isScheduled ? 'Scheduled' : 'Charging'}
                      </p>
                      {isScheduled ? (
                        <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-4 text-sm text-slate-300">
                          Charging from <span className="font-semibold text-slate-100">{activeSession.soc_start_pct ?? '—'}%</span> to{' '}
                          <span className="font-semibold text-slate-100">{activeSession.soc_target_pct ?? '—'}%</span> at{' '}
                          <span className="font-semibold text-slate-100">{activeSession.scheduled_start_at ? `${formatCtTime(activeSession.scheduled_start_at)} CT` : '2:00 AM CT'}</span>
                          {' — estimated '}<span className="font-semibold text-slate-100">{formatScheduledDuration(activeSession.soc_start_pct ?? 0, activeSession.soc_target_pct ?? 100, config?.effective_capacity_wh)}</span>
                        </div>
                      ) : (
                        <div className={`grid gap-3 ${estCost != null ? 'grid-cols-2 sm:grid-cols-5' : 'grid-cols-2 sm:grid-cols-4'}`}>
                          <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                            <p className="text-xs text-slate-500">Started</p>
                            <p className="mt-1 text-sm font-semibold text-slate-200">{formatDate(activeSession.started_at)}</p>
                          </div>
                          <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                            <p className="text-xs text-slate-500">SOC range</p>
                            <p className="mt-1 text-sm font-semibold text-slate-200">{activeSession.soc_start_pct ?? '—'}% → {activeSession.soc_target_pct ?? '—'}%</p>
                          </div>
                          <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                            <p className="text-xs text-slate-500">Live power</p>
                            <p className={`mt-1 text-sm font-semibold ${liveApower > 10 ? 'text-amber-400' : 'text-slate-400'}`}>
                              {liveApower > 0 ? `${Math.round(liveApower)} W` : '—'}
                            </p>
                          </div>
                          <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                            <p className="text-xs text-slate-500">Wh delivered</p>
                            <p className="mt-1 text-sm font-semibold text-slate-200">{formatEnergy(sessionDetails?.readings_summary?.wh_delivered)}</p>
                          </div>
                          {estCost != null && (
                            <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                              <p className="text-xs text-slate-500">Est. cost</p>
                              <p className="mt-1 text-sm font-semibold text-slate-200">${estCost.toFixed(2)}</p>
                            </div>
                          )}
                        </div>
                      )}

                      {isCharging && activeSession.soc_target_pct === 100 && taperData && (
                        <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3">
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Taper</p>
                          {taperData.taper_detected ? (
                            <p className="text-sm text-slate-300">
                              Taper phase: {taperData.taper_start_soc != null ? Math.round(taperData.taper_start_soc) : '—'}% → 100%
                              · {taperData.taper_duration_min != null ? Math.round(taperData.taper_duration_min) : '—'} min
                              · {formatEnergy(taperData.taper_wh_delivered)}
                            </p>
                          ) : (
                            <p className="text-sm text-slate-500">Taper not yet detected — watching for CV phase</p>
                          )}
                        </div>
                      )}

                      {isCharging && activeSession.soc_target_pct === 100 && (
                        <div className="rounded-2xl border border-sky-700/50 bg-sky-900/20 px-4 py-3 text-sm text-sky-300">
                          Monitoring for charger auto-shutoff
                        </div>
                      )}

                      {isCharging && activeSession.soc_target_pct < 100 && (() => {
                        const effectiveCapacity = config?.effective_capacity_wh ?? TOTAL_WH;
                        const whDelivered = sessionDetails?.readings_summary?.wh_delivered ?? 0;
                        const socStartPct = activeSession.soc_start_pct ?? 0;
                        const socTargetPct = activeSession.soc_target_pct ?? 100;
                        const estimatedSoc = Math.min(socTargetPct, socStartPct + (whDelivered / effectiveCapacity) * 100);
                        const fillPct = Math.max(0, estimatedSoc - socStartPct);
                        const unfilledPct = Math.max(0, socTargetPct - estimatedSoc);
                        const etaText = formatEta(activeSession, sessionDetails?.readings_summary, liveApower, estimatedSoc, effectiveCapacity);
                        return (
                          <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3">
                            <div className="mb-1 flex w-full items-end">
                              <div className="flex-shrink-0" style={{ width: `${estimatedSoc}%` }} />
                              <span className="-translate-x-1/2 transform whitespace-nowrap text-xs font-semibold text-slate-200">~{Math.round(estimatedSoc)}%</span>
                            </div>
                            <div className="relative flex h-2.5 w-full items-center rounded-full bg-slate-700/50">
                              {socStartPct > 0 && <div className="h-full flex-shrink-0" style={{ width: `${socStartPct}%` }} />}
                              {fillPct > 0 && <div className="h-full flex-shrink-0 bg-emerald-500" style={{ width: `${fillPct}%` }} />}
                              {unfilledPct > 0 ? (
                                <div className="relative h-full flex-shrink-0 bg-slate-500/30" style={{ width: `${unfilledPct}%` }}>
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
                            {etaText && <p className="mt-2 text-center text-sm text-emerald-300">{etaText}</p>}
                          </div>
                        );
                      })()}

                      {error && <div className="rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">{error}</div>}
                      <button type="button" onClick={handleStop} disabled={stopping}
                        className="min-h-14 rounded-2xl border border-red-700/60 bg-red-900/30 px-6 text-base font-semibold text-red-300 transition-colors hover:bg-red-900/60 disabled:opacity-60">
                        {stopping ? 'Stopping…' : isScheduled ? 'Cancel' : activeSession.soc_target_pct === 100 ? 'Stop & Disconnect' : 'Cut Power'}
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-5">
                      <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Plug In</p>
                      <div className="grid grid-cols-2 gap-3">
                        <SOCSelector min={0} max={95} value={socStart} onChange={setSocStart} label="Current SOC" />
                        <SOCSelector min={20} max={95} value={socTarget} onChange={setSocTarget} label="Target SOC" />
                      </div>
                      {pendingRides.length > 0 && (
                        <div className="flex flex-col gap-2">
                          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Prestaged Rides</p>
                          {pendingRides.map(ride => {
                            const checked = checkedRideIds.has(ride.id);
                            return (
                              <label key={ride.id} className={`flex cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 text-sm transition-colors ${checked ? 'border-emerald-700/50 bg-emerald-950/20' : 'border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] opacity-60'}`}>
                                <input type="checkbox" checked={checked} onChange={() => toggleRideCheck(ride.id)} className="h-4 w-4 accent-emerald-500" />
                                <span className="flex-1 font-semibold text-slate-200">{ride.trip_name}</span>
                                <span className="text-slate-400">{ride.trip_miles} mi</span>
                                {ride.duration_min != null && <span className="text-slate-400">{Math.round(ride.duration_min)} min</span>}
                                <span className="text-slate-500 text-xs">{formatTimeRange(ride.started_at, ride.finished_at)}</span>
                                {ride.start_soc_pct != null && ride.end_soc_pct != null && (
                                  <span className="text-slate-500 text-xs">{ride.start_soc_pct}%→{ride.end_soc_pct}%</span>
                                )}
                                {ride.wh_per_mile != null && (
                                  <span className="text-slate-500 text-xs">{ride.wh_per_mile < 100 ? ride.wh_per_mile.toFixed(1) : Math.round(ride.wh_per_mile)} Wh/mi</span>
                                )}
                              </label>
                            );
                          })}
                        </div>
                      )}
                      {error && <div className="rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">{error}</div>}
                      <div className={selectedDevice?.site_key === 'LF' ? '' : 'grid grid-cols-2 gap-3'}>
                        <button type="button" onClick={handleChargeNow} disabled={starting || schedulingOvernight || isOverLimit}
                          className={`min-h-14 rounded-2xl bg-[color:var(--color-accent)] px-6 text-base font-semibold text-white transition-colors hover:bg-[color:var(--color-accent-hover)] disabled:opacity-60${selectedDevice?.site_key === 'LF' ? ' w-full' : ''}`}>
                          {starting ? 'Logging…' : 'Charge Now'}
                        </button>
                        {selectedDevice?.site_key !== 'LF' && (
                          <button type="button" onClick={handleScheduleOvernight} disabled={starting || schedulingOvernight || isOverLimit}
                            className="min-h-14 rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-6 text-base font-semibold text-slate-300 transition-colors hover:border-slate-500 disabled:opacity-60">
                            {schedulingOvernight ? 'Scheduling…' : 'Charge Overnight'}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </section>
              )}

              {/* Charge Curve card — latest session */}
              {config && (config.taperOnsetByDevice?.length > 0 || config.latestChargeCurve != null) && (
                <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
                  <p className="mb-4 text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Charge Curve</p>
                  {config.taperOnsetByDevice?.length > 0 && (
                    <>
                      <div className="overflow-x-auto mb-3">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left text-slate-400">
                              <th className="pb-2 pr-4">Device</th>
                              <th className="pb-2 pr-4">Avg Taper Onset</th>
                              <th className="pb-2">Sessions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {config.taperOnsetByDevice.map(row => (
                              <tr key={row.device_id} className="border-b border-slate-700 text-slate-300">
                                <td className="py-2 pr-4">{row.device_label}</td>
                                <td className="py-2 pr-4">{row.avg_taper_onset_soc != null ? `${row.avg_taper_onset_soc}%` : '—'}</td>
                                <td className="py-2">{row.curve_count} sessions</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="mb-3 text-xs text-slate-500">
                        Taper onset is where the charger transitions from constant-current to constant-voltage phase.
                      </p>
                    </>
                  )}
                  {config.latestChargeCurve?.power_timeline_json && (
                    <ChargeCurveChart
                      curve={config.latestChargeCurve}
                      socStart={latestCurveSession?.soc_start_pct ?? null}
                      socEnd={latestCurveSession?.actual_soc_pct ?? latestCurveSession?.soc_target_pct ?? null}
                    />
                  )}
                </section>
              )}

              {/* Recent Charge Sessions (last 5) */}
              {recentSessions.length > 0 && (
                <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
                  <p className="mb-4 text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Recent Charge Sessions</p>
                  <div className="flex flex-col gap-2 overflow-x-auto">
                    {recentSessions.map(session => {
                      const device = devices.find(d => d.id === session.device_id);
                      return (
                        <SessionRow
                          key={session.id}
                          session={session} device={device} devices={devices}
                          deleteSessionConfirmId={deleteSessionConfirmId}
                          calibrateSocMap={calibrateSocMap}
                          expandedCurveId={null}
                          showCurveButton={false}
                          onConfirmDelete={id => setDeleteSessionConfirmId(id)}
                          onCancelDelete={() => setDeleteSessionConfirmId(null)}
                          onDelete={handleDeleteSession}
                          onCalibrateSocChange={(id, v) => setCalibrateSocMap(prev => ({ ...prev, [id]: v }))}
                          onCalibrate={handleCalibrateSession}
                          onToggleCurve={() => {}}
                        />
                      );
                    })}
                  </div>
                  <p className="mt-2 text-xs text-slate-600">* estimated cost</p>
                </section>
              )}

              {/* Historical Charge Sessions (all, collapsible) */}
              {allSessions.length > 0 && (
                <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Historical Charge Sessions</p>
                    <button onClick={() => setShowHistoricalSessions(v => !v)}
                      className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
                      {showHistoricalSessions ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  {showHistoricalSessions && (
                    <div className="flex flex-col gap-2 overflow-x-auto">
                      {allSessions.map(session => {
                        const device = devices.find(d => d.id === session.device_id);
                        return (
                          <React.Fragment key={session.id}>
                            <SessionRow
                              session={session} device={device} devices={devices}
                              deleteSessionConfirmId={deleteSessionConfirmId}
                              calibrateSocMap={calibrateSocMap}
                              expandedCurveId={expandedCurveId}
                              showCurveButton={true}
                              onConfirmDelete={id => setDeleteSessionConfirmId(id)}
                              onCancelDelete={() => setDeleteSessionConfirmId(null)}
                              onDelete={handleDeleteSession}
                              onCalibrateSocChange={(id, v) => setCalibrateSocMap(prev => ({ ...prev, [id]: v }))}
                              onCalibrate={handleCalibrateSession}
                              onToggleCurve={handleToggleCurve}
                            />
                            {expandedCurveId === session.id && (
                              <ExpandedSessionCurve
                                session={session}
                                curveCache={curveCache}
                                onFetch={handleFetchCurve}
                              />
                            )}
                          </React.Fragment>
                        );
                      })}
                      <p className="mt-2 text-xs text-slate-600">* estimated cost</p>
                    </div>
                  )}
                </section>
              )}

              {/* Full Calibration History (collapsible) */}
              {config && config.observation_count > 0 && (
                <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
                  <div className="mb-4 flex items-center justify-between">
                    <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Full Calibration History</p>
                    <button onClick={() => setShowCapacityHistory(v => !v)}
                      className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
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
                              <th className="pb-2 pr-4">Implied Capacity</th>
                              <th className="pb-2 pr-4">Pack estimate</th>
                              <th className="pb-2 pr-4">Change</th>
                              <th className="pb-2" />
                            </tr>
                          </thead>
                          <tbody>
                            {(config.capacityHistory ?? []).map((entry, i) => {
                              const change = entry.new_capacity - entry.prev_capacity;
                              return (
                                <tr key={i} className="border-t border-[color:var(--color-border)] text-slate-300">
                                  <td className="py-2 pr-4 text-slate-500">{formatDate(entry.recorded_at)}</td>
                                  <td className="py-2 pr-4">+{Math.round(entry.soc_delta)}%</td>
                                  <td className="py-2 pr-4">{Math.round(entry.observed_wh).toLocaleString()} Wh</td>
                                  <td className="py-2 pr-4">{Math.round(entry.new_capacity).toLocaleString()} Wh</td>
                                  <td className={`py-2 pr-4 ${change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                    {change >= 0 ? '+' : ''}{Math.round(change)} Wh
                                  </td>
                                  <td className="py-2 text-right">
                                    {confirmDeleteCalIdx === i ? (
                                      <span className="flex items-center justify-end gap-1 text-xs">
                                        <button onClick={() => setConfirmDeleteCalIdx(null)} className="text-gray-400 hover:text-white px-2 py-0.5 rounded">✕</button>
                                        <button onClick={() => handleDeleteCalEntry(i)} className="bg-red-700 hover:bg-red-600 text-white px-2 py-0.5 rounded">Delete</button>
                                      </span>
                                    ) : (
                                      <button onClick={() => setConfirmDeleteCalIdx(i)}
                                        className="text-gray-500 hover:text-red-400 transition-colors p-1" title="Remove this calibration entry">🗑</button>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <p className="mt-3 text-sm text-slate-400">
                        Effective pack capacity: {Math.round(config.effective_capacity_wh ?? TOTAL_WH).toLocaleString()} Wh (n={config.observation_count} observations)
                      </p>
                    </>
                  )}
                </section>
              )}
            </div>
          )}

          {/* ── Trips section ─────────────────────────────────────────── */}
          {activeSection === 'trips' && (
            <div className="p-6 flex flex-col gap-6 max-w-5xl">

              {/* Pending Legs card */}
              {recentPendingRides.length > 0 && (
                <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
                  <p className="mb-4 text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Pending Legs</p>
                  <div className="flex flex-col gap-2">
                    {recentPendingRides.map(ride => (
                      <PendingRideRow
                        key={ride.id}
                        ride={ride} trips={trips}
                        editRideId={editRideId} editRideForm={editRideForm} setEditRideForm={setEditRideForm}
                        deleteRideConfirmId={deleteRideConfirmId} rideEditError={rideEditError}
                        onStartEdit={startEditRide}
                        onSaveEdit={handleSaveRideEdit}
                        onCancelEdit={() => { setEditRideId(null); setRideEditError(''); }}
                        onDelete={handleDeleteRide}
                        onConfirmDelete={id => { setDeleteRideConfirmId(id); setEditRideId(null); setRideEditError(''); }}
                        onCancelDelete={() => { setDeleteRideConfirmId(null); setRideEditError(''); }}
                        onOpenNote={openNoteDialog}
                      />
                    ))}
                  </div>
                </section>
              )}

              {/* Recent Trips card (last 5 sessions with legs) */}
              {recentTripSessions.length > 0 && (
                <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
                  <p className="mb-4 text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Recent Trips</p>
                  <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1.2fr)] px-4 mb-2 text-xs text-slate-500">
                    <span>Trip</span><span>Date</span><span>Trip Time</span><span>Wh/mi</span><span className="text-right">Cost</span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {recentTripSessions.map(session => (
                      <TripSessionRows
                        key={session.id}
                        session={session} devices={devices} trips={trips}
                        expandedLegKey={expandedLegKey}
                        sessionTelemetryCache={sessionTelemetryCache}
                        telemetryLoading={telemetryLoading}
                        onLegClick={handleLegRowClick}
                        onLegClose={() => setExpandedLegKey(null)}
                      />
                    ))}
                  </div>
                </section>
              )}

              {/* Legs card (trip definitions) */}
              <LegsCard />

              {/* All Trips (collapsible, default collapsed) */}
              {tripSessions.length > 5 && (
                <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">All Trips</p>
                    <button onClick={() => setShowAllTrips(v => !v)}
                      className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
                      {showAllTrips ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  {showAllTrips && (
                    <>
                      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1.2fr)] px-4 mb-2 text-xs text-slate-500">
                        <span>Trip</span><span>Date</span><span>Trip Time</span><span>Wh/mi</span><span className="text-right">Cost</span>
                      </div>
                      <div className="flex flex-col gap-2">
                        {tripSessions.slice(5).map(session => (
                          <TripSessionRows
                            key={session.id}
                            session={session} devices={devices} trips={trips}
                            expandedLegKey={expandedLegKey}
                            sessionTelemetryCache={sessionTelemetryCache}
                            telemetryLoading={telemetryLoading}
                            onLegClick={handleLegRowClick}
                            onLegClose={() => setExpandedLegKey(null)}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </section>
              )}
            </div>
          )}
        </main>
      </div>

      {/* ── Notes dialog ───────────────────────────────────────────────── */}
      <dialog
        ref={noteDialogRef}
        className="w-full max-w-md rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-6 text-slate-200 backdrop:bg-black/60"
      >
        <p className="mb-3 text-sm font-semibold text-slate-300">{noteMode === 'display' ? 'Note' : 'Add Note'}</p>
        <textarea
          className="w-full rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-3 py-2 text-sm text-slate-200 focus:outline-none"
          rows={4} value={noteValue} onChange={e => setNoteValue(e.target.value)} placeholder="Add a note…"
        />
        {noteError && <p className="mt-2 text-xs text-red-400">{noteError}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={() => { noteDialogRef.current.close(); setNoteError(''); }}
            className="rounded-xl border border-[color:var(--color-border)] px-4 py-2 text-sm text-slate-400 hover:border-slate-500">Cancel</button>
          <button onClick={handleNoteSave}
            className="rounded-xl bg-[color:var(--color-accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[color:var(--color-accent-hover)]">Save</button>
        </div>
      </dialog>
    </div>
  );
}
