import React, { useState } from 'react';
import { useReceiptsStore } from '../../store/receiptsStore.js';
import { deleteReceipt } from '../../api/receipts.js';
import { LineItemDrawer } from './LineItemDrawer.jsx';

const PAGE_SIZE = 10;

function fmtDate(iso) {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

function fmtMoney(val) {
  if (val == null) return '—';
  return `$${Number(val).toFixed(2)}`;
}

export function RecentImportsTable() {
  const { receipts, removeReceipt } = useReceiptsStore();
  const [expandedId, setExpandedId] = useState(null);
  const [deleting,   setDeleting]   = useState(null);
  const [page,       setPage]       = useState(0);

  const pageCount  = Math.ceil(receipts.length / PAGE_SIZE);
  const pageSlice  = receipts.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function toggleRow(id) {
    setExpandedId(prev => (prev === id ? null : id));
  }

  async function handleDelete(e, id) {
    e.stopPropagation();
    setDeleting(id);
    try {
      await deleteReceipt(id);
      removeReceipt(id);
      if (expandedId === id) setExpandedId(null);
    } catch (err) {
      console.error('[RecentImportsTable] delete error:', err);
    } finally {
      setDeleting(null);
    }
  }

  if (receipts.length === 0) {
    return <p className="text-slate-500 text-sm">No receipts imported yet.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full text-sm text-left">
          <thead>
            <tr className="text-slate-500 border-b border-slate-800">
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Store #</th>
              <th className="px-3 py-2 font-medium text-right">Items</th>
              <th className="px-3 py-2 font-medium text-right">Total</th>
              <th className="px-3 py-2 font-medium text-right">Tax</th>
              <th className="px-3 py-2 font-medium text-right">Cashback</th>
              <th className="px-3 py-2 font-medium">Source File</th>
              <th className="px-3 py-2 font-medium">Warnings</th>
              <th className="px-3 py-2 font-medium w-16"></th>
            </tr>
          </thead>
          <tbody>
            {pageSlice.map(r => (
              <React.Fragment key={r.id}>
                <tr
                  onClick={() => toggleRow(r.id)}
                  className="border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors cursor-pointer select-none"
                >
                  <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{fmtDate(r.receipt_date)}</td>
                  <td className="px-3 py-2 text-slate-400">{r.store_number ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-400 text-right tabular-nums">{r.item_count}</td>
                  <td className="px-3 py-2 text-slate-300 text-right tabular-nums">{fmtMoney(r.purchase_amount)}</td>
                  <td className="px-3 py-2 text-slate-400 text-right tabular-nums">{fmtMoney(r.tax_amount)}</td>
                  <td className="px-3 py-2 text-slate-500 text-right tabular-nums">{fmtMoney(r.cashback_amount)}</td>
                  <td className="px-3 py-2 text-slate-500 max-w-xs">
                    <span className="truncate block" title={r.source_file}>{r.source_file ?? '—'}</span>
                  </td>
                  <td className="px-3 py-2 text-slate-500">—</td>
                  <td className="px-3 py-2">
                    <button
                      onClick={(e) => handleDelete(e, r.id)}
                      disabled={deleting === r.id}
                      className="text-xs text-red-500 hover:text-red-400 disabled:opacity-40 transition-colors"
                      title="Delete receipt"
                    >
                      {deleting === r.id ? '…' : '✕'}
                    </button>
                  </td>
                </tr>
                {expandedId === r.id && (
                  <tr className="border-b border-slate-800/60">
                    <td colSpan={9} className="p-0">
                      <LineItemDrawer receiptId={r.id} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            className="px-2 py-0.5 rounded border border-slate-700 disabled:opacity-40 hover:border-slate-500 transition-colors"
          >
            ‹
          </button>
          <span>{page + 1} / {pageCount}</span>
          <button
            onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
            disabled={page === pageCount - 1}
            className="px-2 py-0.5 rounded border border-slate-700 disabled:opacity-40 hover:border-slate-500 transition-colors"
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}
