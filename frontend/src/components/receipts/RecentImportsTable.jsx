import React, { useState } from 'react';
import { deleteReceipt } from '../../api/receipts.js';
import { LineItemDrawer } from './LineItemDrawer.jsx';

function fmtDate(iso) {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

function fmtMoney(val) {
  if (val == null) return '—';
  return `$${Number(val).toFixed(2)}`;
}

const STATUS_BADGE = {
  ok:      'bg-green-900  text-green-300',
  partial: 'bg-yellow-900 text-yellow-300',
  failed:  'bg-red-900    text-red-300',
  flagged: 'bg-amber-900  text-amber-300',
};

function StatusBadge({ status }) {
  const cls = STATUS_BADGE[status] ?? 'bg-slate-800 text-slate-400';
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status ?? '—'}
    </span>
  );
}

export function RecentImportsTable({ receipts, onRemove, onReImport, onRowClick }) {
  const [expandedId, setExpandedId] = useState(null);
  const [deleting,   setDeleting]   = useState(null);
  const [reimporting, setReimporting] = useState(null);

  function handleRowClick(r) {
    if (onRowClick) {
      onRowClick(r);
    } else {
      setExpandedId(prev => (prev === r.id ? null : r.id));
    }
  }

  async function handleDelete(e, id) {
    e.stopPropagation();
    setDeleting(id);
    try {
      await deleteReceipt(id);
      onRemove?.(id);
      if (expandedId === id) setExpandedId(null);
    } catch (err) {
      console.error('[RecentImportsTable] delete:', err);
    } finally {
      setDeleting(null);
    }
  }

  async function handleReImport(e, id) {
    e.stopPropagation();
    setReimporting(id);
    try {
      await onReImport?.(id);
    } finally {
      setReimporting(null);
    }
  }

  if (!receipts?.length) {
    return <p className="text-slate-500 text-sm">No receipts found.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800">
      <table className="w-full text-sm text-left">
        <thead>
          <tr className="text-slate-500 border-b border-slate-800">
            <th className="px-3 py-2 font-medium">Date</th>
            <th className="px-3 py-2 font-medium">Store #</th>
            <th className="px-3 py-2 font-medium text-right">Items</th>
            <th className="px-3 py-2 font-medium text-right">Subtotal</th>
            <th className="px-3 py-2 font-medium text-right">Tax</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">File</th>
            <th className="px-3 py-2 font-medium w-24"></th>
          </tr>
        </thead>
        <tbody>
          {receipts.map(r => (
            <React.Fragment key={r.id}>
              <tr
                onClick={() => handleRowClick(r)}
                className="border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors cursor-pointer select-none"
              >
                <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{fmtDate(r.receipt_date)}</td>
                <td className="px-3 py-2 text-slate-400">{r.store_number ?? '—'}</td>
                <td className="px-3 py-2 text-slate-400 text-right tabular-nums">{r.item_count ?? '—'}</td>
                <td className="px-3 py-2 text-slate-300 text-right tabular-nums">{fmtMoney(r.subtotal)}</td>
                <td className="px-3 py-2 text-slate-400 text-right tabular-nums">{fmtMoney(r.tax_amount)}</td>
                <td className="px-3 py-2">
                  <StatusBadge status={r.parse_status} />
                </td>
                <td className="px-3 py-2 text-slate-500 max-w-[12rem]">
                  <span className="truncate block" title={r.pdf_filename}>{r.pdf_filename ?? '—'}</span>
                </td>
                <td className="px-3 py-2 flex items-center gap-2" onClick={e => e.stopPropagation()}>
                  {onReImport && (
                    <button
                      onClick={(e) => handleReImport(e, r.id)}
                      disabled={reimporting === r.id}
                      className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-40 transition-colors"
                      title="Re-import"
                    >
                      {reimporting === r.id ? '…' : '↻'}
                    </button>
                  )}
                  <button
                    onClick={(e) => handleDelete(e, r.id)}
                    disabled={deleting === r.id}
                    className="text-xs text-red-500 hover:text-red-400 disabled:opacity-40 transition-colors"
                    title="Delete"
                  >
                    {deleting === r.id ? '…' : '✕'}
                  </button>
                </td>
              </tr>
              {expandedId === r.id && (
                <tr className="border-b border-slate-800/60">
                  <td colSpan={8} className="p-0">
                    <LineItemDrawer receiptId={r.id} />
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
