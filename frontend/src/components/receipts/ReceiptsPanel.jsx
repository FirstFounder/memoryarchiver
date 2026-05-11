import { useState, useEffect, useCallback, useRef } from 'react';
import { useReceiptsStore } from '../../store/receiptsStore.js';
import {
  importAll,
  getReceipts,
  getFlagged,
  reImport,
} from '../../api/receipts.js';
import { RecentImportsTable } from './RecentImportsTable.jsx';
import { ReceiptReviewDrawer } from './ReceiptReviewDrawer.jsx';

function ImportResult({ result }) {
  const [errOpen, setErrOpen] = useState(false);
  if (!result) return null;
  const { processed = 0, ok = 0, partial = 0, failed = 0, errors = [] } = result;
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/40 px-4 py-3 text-sm flex flex-col gap-1">
      <span className="text-slate-200">
        Processed {processed}:{' '}
        <span className="text-green-400">{ok} ok</span>
        {' / '}
        <span className="text-yellow-400">{partial} partial</span>
        {' / '}
        <span className="text-red-400">{failed} failed</span>
      </span>
      {errors.length > 0 && (
        <div>
          <button
            onClick={() => setErrOpen(o => !o)}
            className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            {errOpen ? '▼' : '▶'} {errors.length} error{errors.length !== 1 ? 's' : ''}
          </button>
          {errOpen && (
            <ul className="mt-1 pl-3 flex flex-col gap-0.5">
              {errors.map((e, i) => (
                <li key={i} className="text-xs text-red-400">{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function FlaggedSection({ onReImport }) {
  const { upsertReceipt } = useReceiptsStore();

  const [open,          setOpen]          = useState(true);
  const [flagged,       setFlagged]       = useState(null);
  const [loading,       setLoading]       = useState(true);
  const [reviewReceipt, setReviewReceipt] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    getFlagged()
      .then(data => setFlagged(data.receipts ?? []))
      .catch(err => { console.error('[FlaggedSection]', err); setFlagged([]); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return null;
  if (!flagged?.length) return null;

  return (
    <>
      <div className="rounded-xl border border-amber-800/50 bg-amber-950/20">
        <button
          onClick={() => setOpen(o => !o)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm text-amber-300 hover:text-amber-200 transition-colors"
        >
          <span className="font-medium">Needs Review ({flagged.length})</span>
          <span>{open ? '▼' : '▶'}</span>
        </button>
        {open && (
          <div className="px-4 pb-4">
            <RecentImportsTable
              receipts={flagged}
              onRemove={(id) => setFlagged(prev => prev.filter(r => r.id !== id))}
              onReImport={async (id) => {
                const updated = await onReImport(id);
                if (updated) {
                  setFlagged(prev => prev.filter(r => r.id !== id));
                }
              }}
              onRowClick={setReviewReceipt}
            />
          </div>
        )}
      </div>

      {reviewReceipt && (
        <ReceiptReviewDrawer
          receipt={reviewReceipt}
          onClose={() => setReviewReceipt(null)}
          onSaved={(updated) => {
            upsertReceipt(updated);
            setReviewReceipt(null);
            load();
          }}
        />
      )}
    </>
  );
}

export function ReceiptsPanel() {
  const { receipts, total, page, limit, setReceipts, removeReceipt, upsertReceipt } =
    useReceiptsStore();

  const [importing,    setImporting]    = useState(false);
  const [importResult, setImportResult] = useState(null);

  const [store,     setStore]     = useState('');
  const [status,    setStatus]    = useState('');
  const [dateFrom,  setDateFrom]  = useState('');
  const [dateTo,    setDateTo]    = useState('');

  const [curPage,   setCurPage]   = useState(1);
  const [loading,   setLoading]   = useState(false);

  const flaggedRef = useRef(null);

  const load = useCallback((pg = 1) => {
    setLoading(true);
    getReceipts({
      page:      pg,
      limit:     50,
      store:     store || undefined,
      status:    status || undefined,
      date_from: dateFrom || undefined,
      date_to:   dateTo   || undefined,
    })
      .then(data => { setReceipts(data); setCurPage(pg); })
      .catch(err => console.error('[ReceiptsPanel] load:', err))
      .finally(() => setLoading(false));
  }, [store, status, dateFrom, dateTo, setReceipts]);

  useEffect(() => { load(1); }, [load]);

  async function handleImportAll() {
    setImporting(true);
    setImportResult(null);
    try {
      const result = await importAll();
      setImportResult(result);
      load(1);
      flaggedRef.current?.();
    } catch (err) {
      setImportResult({ processed: 0, ok: 0, partial: 0, failed: 0, errors: [err.message] });
    } finally {
      setImporting(false);
    }
  }

  async function handleReImport(id) {
    try {
      const updated = await reImport(id);
      upsertReceipt(updated);
      return updated;
    } catch (err) {
      console.error('[ReceiptsPanel] re-import:', err);
      return null;
    }
  }

  const pageCount = limit > 0 ? Math.ceil(total / limit) : 1;

  return (
    <div className="flex flex-col gap-5">

      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handleImportAll}
          disabled={importing}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          {importing && (
            <span className="inline-block w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          )}
          {importing ? 'Importing…' : 'Import All'}
        </button>
      </div>

      {importResult && <ImportResult result={importResult} />}

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500">Store #</label>
          <input
            type="number"
            value={store}
            onChange={e => setStore(e.target.value)}
            placeholder="Any"
            className="w-24 rounded-lg bg-slate-800 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500">Status</label>
          <select
            value={status}
            onChange={e => setStatus(e.target.value)}
            className="rounded-lg bg-slate-800 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
          >
            <option value="">All</option>
            <option value="ok">ok</option>
            <option value="partial">partial</option>
            <option value="failed">failed</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500">Date from</label>
          <input
            type="date"
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            className="rounded-lg bg-slate-800 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500">Date to</label>
          <input
            type="date"
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            className="rounded-lg bg-slate-800 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
          />
        </div>
      </div>

      {/* Flagged / needs-review section */}
      <FlaggedSection onReImport={handleReImport} />

      {/* Receipt list */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-slate-400 text-sm">
            {loading ? 'Loading…' : `${total} receipt${total !== 1 ? 's' : ''}`}
          </span>
          {pageCount > 1 && (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <button
                onClick={() => load(curPage - 1)}
                disabled={curPage <= 1 || loading}
                className="px-2 py-0.5 rounded border border-slate-700 disabled:opacity-40 hover:border-slate-500 transition-colors"
              >
                ‹
              </button>
              <span>{curPage} / {pageCount}</span>
              <button
                onClick={() => load(curPage + 1)}
                disabled={curPage >= pageCount || loading}
                className="px-2 py-0.5 rounded border border-slate-700 disabled:opacity-40 hover:border-slate-500 transition-colors"
              >
                ›
              </button>
            </div>
          )}
        </div>

        <RecentImportsTable
          receipts={receipts}
          onRemove={(id) => { removeReceipt(id); }}
          onReImport={handleReImport}
        />

        {pageCount > 1 && (
          <div className="flex items-center gap-2 text-sm text-slate-400 justify-end">
            <button
              onClick={() => load(curPage - 1)}
              disabled={curPage <= 1 || loading}
              className="px-2 py-0.5 rounded border border-slate-700 disabled:opacity-40 hover:border-slate-500 transition-colors"
            >
              ‹
            </button>
            <span>{curPage} / {pageCount}</span>
            <button
              onClick={() => load(curPage + 1)}
              disabled={curPage >= pageCount || loading}
              className="px-2 py-0.5 rounded border border-slate-700 disabled:opacity-40 hover:border-slate-500 transition-colors"
            >
              ›
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
