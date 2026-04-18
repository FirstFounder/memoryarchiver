import { useEffect, useState } from 'react';
import { getSessions, triggerMorningPoll } from '../../api/tesla.js';
import { useTeslaStore } from '../../store/teslaStore.js';

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

function formatDate(value) {
  if (!value) return '—';
  return DATE_FORMATTER.format(new Date(value));
}

function formatSoc(session) {
  if (session.start_soc == null || session.end_soc == null) return '—';
  return `${session.start_soc}% -> ${session.end_soc}%`;
}

function formatNumber(value, digits = 1, suffix = '') {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `${Number(value).toFixed(digits)}${suffix}`;
}

function formatCurrency(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `$${Number(value).toFixed(2)}`;
}

function formatDelta(session) {
  const predicted = Number(session.predicted_cost_dollars);
  const actual = Number(session.actual_cost_dollars);
  if (!Number.isFinite(predicted) || !Number.isFinite(actual)) return null;
  return actual - predicted;
}

export function SessionHistoryTable({ vin }) {
  const sessions = useTeslaStore(s => s.sessions[vin] ?? []);
  const totals = useTeslaStore(s => s.sessionTotals[vin]);
  const setSessions = useTeslaStore(s => s.setSessions);
  const appendSessions = useTeslaStore(s => s.appendSessions);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState('');

  async function loadPage(offset = 0, append = false) {
    if (loading) return;
    setLoading(true);
    setError('');
    try {
      const response = await getSessions(vin, { limit: 10, offset });
      if (append) {
        appendSessions(vin, response.sessions, response.total);
      } else {
        setSessions(vin, response.sessions, response.total, response.offset, response.limit);
      }
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!expanded || totals) return;
    loadPage(0, false);
  }, [expanded, totals]);

  async function handlePollNow() {
    if (polling) return;
    setPolling(true);
    setError('');
    try {
      await triggerMorningPoll(vin);
      await loadPage(0, false);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setPolling(false);
    }
  }

  const total = totals?.total ?? 0;
  const canLoadMore = total > sessions.length;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-700/70 bg-slate-950/50">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded(value => !value)}
          className="flex items-center gap-3 text-sm font-medium text-slate-200"
        >
          <span>Session History</span>
          <span className={`text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
        </button>

        {expanded && (
          <button
            type="button"
            onClick={handlePollNow}
            disabled={polling}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:border-indigo-500 hover:text-indigo-200 disabled:opacity-50"
          >
            {polling ? 'Polling…' : 'Poll Now'}
          </button>
        )}
      </div>

      {expanded && (
        <div className="border-t border-slate-800/80 px-4 py-4">
          {loading && sessions.length === 0 && (
            <p className="text-sm text-slate-400">Loading sessions…</p>
          )}

          {!loading && !sessions.length && !error && (
            <p className="text-sm text-slate-400">No sessions logged yet.</p>
          )}

          {sessions.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm text-slate-200">
                <thead className="bg-slate-900/80 text-slate-400">
                  <tr>
                    <th className="px-3 py-3 text-left font-medium">Date</th>
                    <th className="px-3 py-3 text-left font-medium">SOC</th>
                    <th className="px-3 py-3 text-left font-medium">kWh used</th>
                    <th className="px-3 py-3 text-left font-medium">Rate</th>
                    <th className="px-3 py-3 text-left font-medium">Voltage</th>
                    <th className="px-3 py-3 text-left font-medium">Efficiency</th>
                    <th className="px-3 py-3 text-left font-medium">Heater</th>
                    <th className="px-3 py-3 text-left font-medium">Predicted</th>
                    <th className="px-3 py-3 text-left font-medium">Actual</th>
                    <th className="px-3 py-3 text-left font-medium">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => {
                    const delta = formatDelta(session);
                    return (
                      <tr
                        key={session.id}
                        className={`border-t border-slate-800/80 ${session.suspect ? 'bg-amber-950/25' : ''}`}
                      >
                        <td className="px-3 py-3" title={session.suspect_reason ?? undefined}>
                          {session.suspect ? '⚠ ' : ''}
                          {formatDate(session.session_start)}
                        </td>
                        <td className="px-3 py-3">{formatSoc(session)}</td>
                        <td className="px-3 py-3">{formatNumber(session.kwh_used, 1)}</td>
                        <td className="px-3 py-3">{session.charge_amps != null ? `${session.charge_amps}A` : '—'}</td>
                        <td className="px-3 py-3">{session.charger_voltage != null ? `${Math.round(Number(session.charger_voltage))}V` : '—'}</td>
                        <td className="px-3 py-3">{session.efficiency_pct != null ? `${Math.round(Number(session.efficiency_pct))}%` : '—'}</td>
                        <td className="px-3 py-3">{session.battery_heater_on ? '🔥' : ''}</td>
                        <td className="px-3 py-3">{formatCurrency(session.predicted_cost_dollars)}</td>
                        <td className="px-3 py-3">{formatCurrency(session.actual_cost_dollars)}</td>
                        <td className={`px-3 py-3 font-medium ${delta == null ? 'text-slate-400' : delta <= 0 ? 'text-emerald-300' : 'text-amber-300'}`}>
                          {delta == null ? '—' : `${delta > 0 ? '+' : ''}$${delta.toFixed(2)}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {error && (
            <p className="mt-3 text-sm text-red-300">{error}</p>
          )}

          {canLoadMore && (
            <button
              type="button"
              onClick={() => loadPage(sessions.length, true)}
              disabled={loading}
              className="mt-4 rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition-colors hover:border-indigo-500 hover:text-indigo-200 disabled:opacity-50"
            >
              {loading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
