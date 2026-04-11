import { useState, useEffect, useCallback } from 'react';
import { getSyncHistory } from '../../api/hub.js';

const PAGE_SIZE = 50;

const STATUS_PILL = {
  done:    'bg-green-900/50 text-green-400',
  error:   'bg-red-900/50 text-red-400',
  skipped: 'bg-amber-900/50 text-amber-300',
  running: 'bg-sky-900/50 text-sky-300',
};

function formatBytes(bytes) {
  if (bytes == null || bytes === 0) return '—';
  if (bytes < 1_048_576)      return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824)  return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

function formatRate(bytesPerSec) {
  if (!bytesPerSec) return '—';
  return `${((bytesPerSec * 8) / 1_000_000).toFixed(1)} Mbps`;
}

function formatDuration(secs) {
  if (!secs) return '—';
  if (secs < 60)  return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ${secs % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatDate(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'America/Chicago',
    timeZoneName: 'short',
  });
}

export function SyncHistoryTable({ destinations }) {
  const [rows, setRows]               = useState([]);
  const [total, setTotal]             = useState(0);
  const [page, setPage]               = useState(0);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [filterDest, setFilterDest]   = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = {
        limit:  PAGE_SIZE,
        offset: page * PAGE_SIZE,
      };
      if (filterDest)   params.destinationId = filterDest;
      if (filterStatus) params.status        = filterStatus;

      const data = await getSyncHistory(params);
      setRows(data.rows ?? data);
      setTotal(data.total ?? (data.rows ?? data).length);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [page, filterDest, filterStatus]);

  useEffect(() => { load(); }, [load]);

  // Reset to page 0 when filters change
  useEffect(() => { setPage(0); }, [filterDest, filterStatus]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mt-6">
      {/* Section header */}
      <div className="flex items-center justify-between mb-3 pt-4 border-t border-slate-800">
        <h2 className="text-slate-200 font-semibold text-sm">Sync History</h2>
        <div className="flex items-center gap-2">
          {/* Destination filter */}
          <select
            value={filterDest}
            onChange={e => setFilterDest(e.target.value)}
            className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1 focus:outline-none focus:border-indigo-500"
          >
            <option value="">All destinations</option>
            {destinations.map(d => (
              <option key={d.id} value={d.id}>{d.hostname}</option>
            ))}
          </select>

          {/* Status filter */}
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1 focus:outline-none focus:border-indigo-500"
          >
            <option value="">All statuses</option>
            <option value="done">Done</option>
            <option value="error">Error</option>
            <option value="skipped">Skipped</option>
          </select>
        </div>
      </div>

      {loading && (
        <p className="text-slate-500 text-sm text-center py-6">Loading…</p>
      )}
      {error && (
        <p className="text-red-400 text-sm text-center py-6">{error}</p>
      )}

      {!loading && !error && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-slate-400 border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-slate-500 uppercase tracking-wide text-left">
                  <th className="pb-2 pr-4">Destination</th>
                  <th className="pb-2 pr-4">Started</th>
                  <th className="pb-2 pr-4">Duration</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Fam</th>
                  <th className="pb-2 pr-4">Vault</th>
                  <th className="pb-2">Avg rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-slate-600">
                      No history yet.
                    </td>
                  </tr>
                )}
                {rows.map(row => {
                  const isSkipped = row.status === 'skipped';
                  return (
                    <tr key={row.id} className="hover:bg-slate-800/30">
                      <td className="py-2 pr-4 text-slate-300 font-medium">
                        {row.hostname ?? row.destination ?? '—'}
                      </td>
                      <td className="py-2 pr-4">{formatDate(row.startedAt)}</td>
                      <td className="py-2 pr-4">{formatDuration(row.duration)}</td>
                      <td className="py-2 pr-4">
                        <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${STATUS_PILL[row.status] ?? 'text-slate-500'}`}>
                          {row.status}
                        </span>
                      </td>
                      <td className="py-2 pr-4">
                        {isSkipped
                          ? <span className="text-slate-600 italic">manifest match</span>
                          : formatBytes(row.famBytes)}
                      </td>
                      <td className="py-2 pr-4">
                        {isSkipped
                          ? <span className="text-slate-600 italic">manifest match</span>
                          : formatBytes(row.vaultBytes)}
                      </td>
                      <td className="py-2">{formatRate(row.avgRate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-end gap-3 mt-3 text-xs text-slate-500">
              <span>Page {page + 1} of {totalPages}</span>
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-2 py-1 rounded border border-slate-700 hover:border-slate-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                ← Prev
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="px-2 py-1 rounded border border-slate-700 hover:border-slate-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
