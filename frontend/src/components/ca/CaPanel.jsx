import { useCallback, useEffect, useMemo, useState } from 'react';
import { getCaStatus } from '../../api/ca.js';

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : DATE_TIME_FORMATTER.format(date);
}

function formatDaysLeft(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return String(value);
}

function statusBadgeClass(status) {
  if (status === 'expiring') return 'border-amber-700/60 bg-amber-900/20 text-amber-200';
  if (status === 'revoked') return 'border-slate-700/70 bg-slate-800/70 text-slate-300';
  return 'border-emerald-700/60 bg-emerald-900/20 text-emerald-200';
}

function statusLabel(status) {
  if (status === 'expiring') return 'Expiring';
  if (status === 'revoked') return 'Revoked';
  return 'Active';
}

function relativeLastUpdated(updatedAt, now) {
  if (!updatedAt) return 'Last updated: never';
  const diffMs = Math.max(0, now - updatedAt);
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes <= 0) return 'Last updated: just now';
  if (diffMinutes === 1) return 'Last updated: 1 minute ago';
  return `Last updated: ${diffMinutes} minutes ago`;
}

export function CaPanel() {
  const [health, setHealth] = useState('error');
  const [certs, setCerts] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const data = await getCaStatus();
      setHealth(data.health ?? 'error');
      setCerts(Array.isArray(data.certs) ? data.certs : []);
      setLastUpdated(Date.now());
    } catch (nextError) {
      setHealth('error');
      setCerts([]);
      setError(nextError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const healthDotClass = health === 'ok' ? 'bg-emerald-400' : 'bg-red-400';
  const healthLabel = health === 'ok' ? 'Running' : 'Unavailable';
  const updatedLabel = useMemo(() => relativeLastUpdated(lastUpdated, now), [lastUpdated, now]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between mb-4 pt-4 border-t border-slate-800">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <h2 className="text-slate-200 font-semibold text-sm">CA Status</h2>
            <span className="inline-flex items-center gap-2 text-xs text-slate-300">
              <span className={`h-2.5 w-2.5 rounded-full ${healthDotClass}`} />
              {healthLabel}
            </span>
          </div>
          <p className="text-xs text-slate-500">{updatedLabel}</p>
        </div>

        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-50"
          title="Refresh"
        >
          ↻ Refresh
        </button>
      </div>

      {error && (
        <p className="mb-4 rounded-xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {!certs.length ? (
        <div className="rounded-2xl border border-slate-800/80 bg-slate-950/50 px-6 py-10 text-center text-sm text-slate-400">
          {loading ? 'Loading certificates…' : 'No issued certificates found.'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-700/70 bg-slate-950/50">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm text-slate-200">
              <thead className="bg-slate-900/80 text-slate-400">
                <tr>
                  <th className="px-3 py-3 text-left font-medium">Device</th>
                  <th className="px-3 py-3 text-left font-medium">CN</th>
                  <th className="px-3 py-3 text-left font-medium">Issued</th>
                  <th className="px-3 py-3 text-left font-medium">Expires</th>
                  <th className="px-3 py-3 text-left font-medium">Days Left</th>
                  <th className="px-3 py-3 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {certs.map((cert, index) => (
                  <tr key={`${cert.cn ?? 'cert'}-${cert.device ?? index}`} className="border-t border-slate-800/80">
                    <td className="px-3 py-3">{cert.device ?? cert.name ?? '—'}</td>
                    <td className="px-3 py-3">{cert.device_name ?? '—'}</td>
                    <td className="px-3 py-3">{formatDateTime(cert.issued)}</td>
                    <td className="px-3 py-3">{formatDateTime(cert.expires)}</td>
                    <td className="px-3 py-3">{formatDaysLeft(cert.daysRemaining)}</td>
                    <td className="px-3 py-3">
                      <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${statusBadgeClass(cert.status)}`}>
                        {statusLabel(cert.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
