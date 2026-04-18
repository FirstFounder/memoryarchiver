import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  getLatestPlan,
  getVehicleStatus,
  getVehicles,
  pollVehicle,
  recomputePlan,
  skipPlan,
} from '../../api/tesla.js';
import { SessionHistoryTable } from './SessionHistoryTable.jsx';
import { useTeslaStore } from '../../store/teslaStore.js';

const MODE_META = {
  connectivity: 'bg-amber-900/50 text-amber-200 border border-amber-700/60',
  active: 'bg-indigo-900/50 text-indigo-200 border border-indigo-700/60',
};

const ALERT_META = {
  window_too_short: {
    className: 'border-amber-700/60 bg-amber-950/40 text-amber-200',
    text: 'Window too short for spread rate — burst strategy may apply',
  },
  user_overridden: {
    className: 'border-amber-700/60 bg-amber-950/40 text-amber-200',
    text: 'Schedule was manually changed — automatic scheduling paused',
  },
  fleet_command_failed: {
    className: 'border-red-700/60 bg-red-950/40 text-red-200',
    text: 'Failed to push schedule to vehicle',
  },
  vehicle_asleep: {
    className: 'border-yellow-700/60 bg-yellow-950/40 text-yellow-200',
    text: 'Vehicle was asleep; schedule may not have been received',
  },
};

const STRATEGY_LABELS = {
  A: 'Strategy A — Spread',
  B: 'Strategy B — Burst',
  C: 'Strategy C — Hybrid',
};

function connectivityLabel(vehicle, status) {
  if (!vehicle.hasCredentials) return 'No credentials';
  if (status?.error) return 'Fleet error';
  if (status?.state) return status.state;
  return 'Offline';
}

function formatCurrency(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `$${Number(value).toFixed(2)}`;
}

function formatHourLabel(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

function parseTimeToHour(timeText) {
  if (!timeText) return null;
  const [hourText = '0'] = String(timeText).split(':');
  const hour = Number(hourText);
  return Number.isFinite(hour) ? hour : null;
}

function buildChartData(prices, windowStart, windowEnd) {
  const startHour = parseTimeToHour(windowStart);
  const endHour = parseTimeToHour(windowEnd);

  const rows = (prices ?? [])
    .slice()
    .sort((a, b) => a.millisUTC - b.millisUTC)
    .slice(0, 24)
    .map((entry) => {
      const hour = Number(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        hour: '2-digit',
        hour12: false,
      }).format(new Date(entry.millisUTC)));

      let charging = false;
      if (startHour !== null && endHour !== null) {
        charging = startHour < endHour
          ? hour >= startHour && hour < endHour
          : hour >= startHour || hour < endHour;
      }

      return {
        hour,
        label: String(hour),
        price: Number(entry.price),
        charging,
      };
    });

  return rows.sort((a, b) => a.hour - b.hour);
}

function renderModelLabel(modelLabel) {
  const label = modelLabel ?? '';
  const match = label.match(/\bP(\d+)D\b/);
  if (!match) {
    return <span>{label}</span>;
  }

  const token = match[0];
  const [before, after] = label.split(token);
  return (
    <span>
      {before}
      <span className="text-red-400">P</span>
      {match[1]}
      <span className="text-red-400">D</span>
      {after}
    </span>
  );
}

function PlanChart({ plan }) {
  const chartData = buildChartData(plan.day_ahead_prices_json, plan.window_start, plan.window_end);
  if (!chartData.length) return null;

  return (
    <div className="h-56 rounded-2xl border border-slate-700/70 bg-slate-950/50 p-3">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
          <XAxis dataKey="label" stroke="#94a3b8" tickLine={false} axisLine={false} />
          <YAxis stroke="#94a3b8" tickLine={false} axisLine={false} width={32} />
          <Tooltip
            cursor={{ fill: 'rgba(148, 163, 184, 0.08)' }}
            contentStyle={{
              background: '#020617',
              border: '1px solid rgba(71, 85, 105, 0.7)',
              borderRadius: '12px',
            }}
            formatter={value => [`${Number(value).toFixed(2)}¢/kWh`, 'Price']}
            labelFormatter={label => `${label}:00`}
          />
          <Bar dataKey="price" radius={[6, 6, 0, 0]}>
            {chartData.map((entry) => (
              <Cell key={entry.hour} fill={entry.charging ? '#818cf8' : '#334155'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function StrategyTable({ plan }) {
  const rows = Array.isArray(plan.strategy_comparison_json) ? plan.strategy_comparison_json : [];
  if (!rows.length) return null;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-700/70 bg-slate-950/50">
      <table className="w-full text-sm text-slate-200">
        <thead className="bg-slate-900/80 text-slate-400">
          <tr>
            <th className="px-4 py-3 text-left font-medium">Strategy</th>
            <th className="px-4 py-3 text-left font-medium">Window</th>
            <th className="px-4 py-3 text-left font-medium">Rate</th>
            <th className="px-4 py-3 text-left font-medium">Est. Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-slate-800/80">
              <td className="px-4 py-3">{STRATEGY_LABELS[row.key]}</td>
              <td className="px-4 py-3">{row.windowStart}–{row.windowEnd}</td>
              <td className="px-4 py-3">{row.chargeAmps ?? '—'}A</td>
              <td className="px-4 py-3">{formatCurrency(row.estimatedCostDollars)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VehicleCard({ vehicle }) {
  const status = useTeslaStore(s => s.vehicleStatus[vehicle.vin]);
  const plan = useTeslaStore(s => s.plans[vehicle.vin]);
  const setVehicleStatus = useTeslaStore(s => s.setVehicleStatus);
  const setPlan = useTeslaStore(s => s.setPlan);
  const [polling, setPolling] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');

  async function handlePoll() {
    if (polling) return;
    setPolling(true);
    setMessage('');
    try {
      const result = await pollVehicle(vehicle.vin);
      setVehicleStatus(vehicle.vin, result);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setPolling(false);
    }
  }

  async function handleRecompute() {
    if (working) return;
    setWorking(true);
    setMessage('');
    try {
      const nextPlan = await recomputePlan(vehicle.vin);
      setPlan(vehicle.vin, nextPlan);
      const nextStatus = await getVehicleStatus(vehicle.vin);
      setVehicleStatus(vehicle.vin, nextStatus);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setWorking(false);
    }
  }

  async function handleSkip() {
    if (working) return;
    setWorking(true);
    setMessage('');
    try {
      await skipPlan(vehicle.vin);
      setPlan(vehicle.vin, {
        status: 'skipped',
        strategy_comparison_json: [],
        day_ahead_prices_json: [],
      });
    } catch (error) {
      setMessage(error.message);
    } finally {
      setWorking(false);
    }
  }

  const odometer = vehicle.cached_odometer != null
    ? `${Number(vehicle.cached_odometer).toLocaleString()} mi`
    : null;

  return (
    <div className="rounded-[2rem] border border-slate-700/60 bg-slate-800/60 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-2xl font-semibold text-white">{vehicle.display_name ?? vehicle.nickname}</p>
          <p className="mt-1 text-sm text-slate-400">
            {renderModelLabel(vehicle.model_label ?? vehicle.nickname)}
            {odometer ? ` · ${odometer}` : ''}
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${MODE_META[vehicle.mode] ?? MODE_META.connectivity}`}>
          {vehicle.mode}
        </span>
      </div>

      {vehicle.mode === 'connectivity' ? (
        <>
          <div className="mt-5 flex items-center justify-between rounded-2xl border border-slate-700/70 bg-slate-900/50 p-4">
            <div>
              <p className="text-sm text-slate-500">Connectivity</p>
              <p className="mt-1 text-lg capitalize text-slate-100">{connectivityLabel(vehicle, status)}</p>
              <p className="mt-2 text-sm text-slate-400">Scheduling disabled — connectivity mode</p>
            </div>
            <button
              type="button"
              onClick={handlePoll}
              disabled={polling}
              className="rounded-xl border border-indigo-800 px-3 py-2 text-sm text-indigo-300 transition-colors hover:border-indigo-600 hover:bg-indigo-900/30 disabled:opacity-40"
            >
              {polling ? 'Polling…' : 'Poll Now'}
            </button>
          </div>
        </>
      ) : (
        <div className="mt-5 flex flex-col gap-4">
          {!plan ? (
            <div className="rounded-2xl border border-slate-700/70 bg-slate-900/50 p-4">
              <p className="text-base text-slate-200">No plan computed yet</p>
              <button
                type="button"
                onClick={handleRecompute}
                disabled={working}
                className="mt-4 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:opacity-60"
              >
                {working ? 'Computing…' : 'Compute Now'}
              </button>
            </div>
          ) : plan.status === 'skipped' ? (
            <div className="rounded-2xl border border-slate-700/70 bg-slate-900/50 p-4">
              <p className="text-base text-slate-200">Skipped tonight</p>
              <div className="mt-4 flex gap-3">
                <button
                  type="button"
                  onClick={handleRecompute}
                  disabled={working}
                  className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:opacity-60"
                >
                  {working ? 'Computing…' : 'Recompute & Apply'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="grid gap-3 rounded-2xl border border-slate-700/70 bg-slate-900/50 p-4 md:grid-cols-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Strategy</p>
                  <p className="mt-1 text-sm font-medium text-slate-100">{STRATEGY_LABELS[plan.selected_strategy] ?? '—'}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Window</p>
                  <p className="mt-1 text-sm font-medium text-slate-100">{plan.window_start ?? '—'} → {plan.window_end ?? '—'}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Charge Rate</p>
                  <p className="mt-1 text-sm font-medium text-slate-100">{plan.charge_amps ?? '—'}A</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Predicted Cost</p>
                  <p className="mt-1 text-sm font-medium text-slate-100">
                    {formatCurrency(
                      plan.selected_strategy === 'B'
                        ? plan.cost_strategy_b_dollars
                        : Array.isArray(plan.strategy_comparison_json)
                          ? plan.strategy_comparison_json.find(item => item.key === plan.selected_strategy)?.estimatedCostDollars
                          : plan.cost_strategy_a_dollars,
                    )}
                  </p>
                </div>
              </div>

              {plan.alert && ALERT_META[plan.alert] && (
                <div className={`rounded-2xl border px-4 py-3 text-sm ${ALERT_META[plan.alert].className}`}>
                  {ALERT_META[plan.alert].text}
                </div>
              )}

              <StrategyTable plan={plan} />
              <PlanChart plan={plan} />
              <SessionHistoryTable vin={vehicle.vin} />

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={handleRecompute}
                  disabled={working}
                  className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:opacity-60"
                >
                  {working ? 'Applying…' : 'Recompute & Apply'}
                </button>
                <button
                  type="button"
                  onClick={handleSkip}
                  disabled={working}
                  className="rounded-xl border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 transition-colors hover:border-slate-400 disabled:opacity-60"
                >
                  Skip Tonight
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {message && (
        <p className="mt-4 rounded-xl border border-red-800/70 bg-red-950/40 px-4 py-3 text-sm text-red-300">{message}</p>
      )}
    </div>
  );
}

export function TeslaPanel() {
  const vehicles = useTeslaStore(s => s.vehicles);
  const setVehicles = useTeslaStore(s => s.setVehicles);
  const setVehicleStatus = useTeslaStore(s => s.setVehicleStatus);
  const setPlan = useTeslaStore(s => s.setPlan);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const rows = await getVehicles();
        if (cancelled) return;
        setVehicles(rows);

        await Promise.all(rows.map(async (vehicle) => {
          try {
            const [status, plan] = await Promise.all([
              getVehicleStatus(vehicle.vin),
              getLatestPlan(vehicle.vin),
            ]);
            if (cancelled) return;
            setVehicleStatus(vehicle.vin, status);
            setPlan(vehicle.vin, plan);
          } catch (error) {
            if (cancelled) return;
            setVehicleStatus(vehicle.vin, { error: 'fleet_error', message: error.message });
            setPlan(vehicle.vin, null);
          }
        }));
      } catch {
        if (!cancelled) setVehicles([]);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [setPlan, setVehicleStatus, setVehicles]);

  return (
    <div className="flex flex-col">
      <div className="mb-4 flex items-center justify-between border-t border-slate-800 pt-4">
        <h2 className="text-sm font-semibold text-slate-200">Tesla Scheduler</h2>
      </div>

      {vehicles.length === 0 && (
        <p className="py-8 text-center text-xs text-slate-600">Loading Tesla vehicles…</p>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {vehicles.map(vehicle => (
          <VehicleCard key={vehicle.vin} vehicle={vehicle} />
        ))}
      </div>
    </div>
  );
}
