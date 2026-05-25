import { useEffect, useState } from 'react';
import { getRecentSessions } from '../../api/tesla.js';

const DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const TIME_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
const DATE_KEY_FMT = new Intl.DateTimeFormat('en-CA'); // YYYY-MM-DD

function dateKey(ms) {
  return DATE_KEY_FMT.format(new Date(ms));
}

function formatDateRange(startMs, endMs) {
  if (!startMs) return '—';
  const startKey = dateKey(startMs);
  const endKey = endMs ? dateKey(endMs) : null;
  const crossesMidnight = endKey && endKey !== startKey;
  if (crossesMidnight) {
    return `${DATE_FMT.format(new Date(startMs))}–${DATE_FMT.format(new Date(endMs))}`;
  }
  return DATE_FMT.format(new Date(startMs));
}

function formatTimeRange(startMs, endMs) {
  if (!startMs) return null;
  const start = TIME_FMT.format(new Date(startMs));
  const end = endMs ? TIME_FMT.format(new Date(endMs)) : null;
  return end ? `${start} – ${end}` : start;
}

function formatDuration(startMs, endMs) {
  if (!startMs || !endMs) return null;
  const totalMinutes = Math.round((endMs - startMs) / 60000);
  if (totalMinutes < 1) return '<1m';
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `:${String(m).padStart(2, '0')}`;
  return `${h}:${String(m).padStart(2, '0')}`;
}

function fmt2(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toFixed(2);
}

function fmt1(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toFixed(1);
}

function fmtV(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toFixed(1);
}

function fmtA(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toFixed(1);
}

function avgPriceFromJson(actualPricesJson) {
  if (!Array.isArray(actualPricesJson) || !actualPricesJson.length) return null;
  const sum = actualPricesJson.reduce((s, e) => s + Number(e.price ?? 0), 0);
  return sum / actualPricesJson.length;
}

function hourlyCostColor(supplyAvgCents) {
  if (supplyAvgCents == null) return 'text-yellow-400';
  if (supplyAvgCents > 15) return 'text-red-400 animate-pulse';
  if (supplyAvgCents > 9) return 'text-red-400';
  if (supplyAvgCents >= 2) return 'text-yellow-400';
  return 'text-green-400';
}

function SessionRow({ session, striped }) {
  const startMs = session.session_start;
  const endMs = session.session_end;

  const supplyAvgCents = avgPriceFromJson(session.actual_prices_json);

  const avgV = session.avg_charger_voltage ?? session.charger_voltage ?? null;
  const maxV = session.max_charger_voltage ?? null;
  const avgA = session.avg_charger_current ?? session.charger_actual_current ?? null;
  const maxA = session.max_charger_current ?? null;

  const hourlyCost = session.hourly_cost_dollars;
  const fixedCost = session.fixed_rate_cost_dollars;
  const diff = hourlyCost != null && fixedCost != null ? hourlyCost - fixedCost : null;

  const bgClass = striped ? 'bg-slate-900/30' : '';

  return (
    <tr className={`border-t border-slate-800/80 text-sm ${bgClass}`}>
      {/* Date & Duration */}
      <td className="px-3 py-3 align-top">
        <div className="flex items-center gap-1.5">
          {session.suspect === 1 && (
            <span title={session.suspect_reason ?? 'suspect'} className="text-amber-400">⚠</span>
          )}
          {session.mqtt_detected === 1 && session.suspect !== 1 && (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-indigo-500/60" title="MQTT-detected" />
          )}
          <span className="font-medium text-slate-100">
            {formatDateRange(startMs, endMs)}
          </span>
        </div>
        <div className="mt-0.5 text-xs text-slate-500">{formatTimeRange(startMs, endMs)}</div>
        {formatDuration(startMs, endMs) && (
          <div className="mt-0.5 text-xs text-slate-600">{formatDuration(startMs, endMs)}</div>
        )}
      </td>

      {/* SOC Range */}
      <td className="px-3 py-3 align-top whitespace-nowrap">
        {session.start_soc != null && session.end_soc != null
          ? <span className="text-slate-200">{session.start_soc}% – {session.end_soc}%</span>
          : <span className="text-slate-600">—</span>}
      </td>

      {/* Used / Added / Efficiency */}
      <td className="px-3 py-3 align-top whitespace-nowrap">
        <div className="text-slate-300">
          <span className="text-xs text-slate-500 uppercase tracking-wide">USED</span>{' '}
          {fmt2(session.kwh_used)} kWh
        </div>
        <div className="mt-0.5 text-slate-400">
          <span className="text-xs text-slate-500 uppercase tracking-wide">ADDED</span>{' '}
          {fmt2(session.charge_energy_added)} kWh
        </div>
        {session.efficiency_pct != null && (
          <div className="mt-0.5 text-slate-500 text-xs">
            {fmt1(session.efficiency_pct)}%{' '}
            <span className="text-slate-700">eff</span>
          </div>
        )}
      </td>

      {/* Voltage & Amps */}
      <td className="px-3 py-3 align-top">
        <div className="flex gap-4 text-xs">
          <div className="flex flex-col gap-0.5">
            <span className="text-slate-400">Avg V: {fmtV(avgV)}</span>
            {maxV != null && <span className="text-slate-500">Max V: {fmtV(maxV)}</span>}
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-slate-400">Avg A: {fmtA(avgA)}</span>
            {maxA != null && <span className="text-slate-500">Max A: {fmtA(maxA)}</span>}
          </div>
        </div>
      </td>

      {/* Charge Cost */}
      <td className="px-3 py-3 align-top whitespace-nowrap">
        <div className={`font-medium ${hourlyCostColor(supplyAvgCents)}`}>
          {hourlyCost != null ? `$${Number(hourlyCost).toFixed(2)}` : '—'}
        </div>
        <div className="mt-0.5 text-slate-400 text-xs">
          {fixedCost != null ? `$${Number(fixedCost).toFixed(2)} fixed` : <span className="text-slate-600">—</span>}
        </div>
        {diff != null && (
          <div className={`mt-0.5 text-xs font-medium ${diff < 0 ? 'text-green-400' : 'text-red-400'}`}>
            {diff < 0 ? `-$${Math.abs(diff).toFixed(2)}` : `+$${diff.toFixed(2)}`}
          </div>
        )}
      </td>
    </tr>
  );
}

export function ChargeHistoryCard({ vin }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!vin) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError('');
      try {
        const rows = await getRecentSessions(vin, 5);
        if (!cancelled) setSessions(rows);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [vin]);

  return (
    <div className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
      <p className="mb-4 text-sm font-semibold uppercase tracking-[0.24em] text-slate-400">
        Charge History
      </p>

      {loading && !sessions.length && (
        <p className="text-sm text-slate-500">Loading…</p>
      )}

      {error && (
        <p className="text-sm text-red-300">{error}</p>
      )}

      {!loading && !error && sessions.length === 0 && (
        <p className="text-sm text-slate-500">No charge sessions recorded yet.</p>
      )}

      {sessions.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm text-slate-300">
            <thead>
              <tr className="text-xs uppercase tracking-[0.18em] text-slate-500">
                <th className="px-3 pb-2 text-left font-medium">Date</th>
                <th className="px-3 pb-2 text-left font-medium">SOC</th>
                <th className="px-3 pb-2 text-left font-medium">Energy</th>
                <th className="px-3 pb-2 text-left font-medium">V / A</th>
                <th className="px-3 pb-2 text-left font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session, i) => (
                <SessionRow key={session.id} session={session} striped={i % 2 === 1} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
