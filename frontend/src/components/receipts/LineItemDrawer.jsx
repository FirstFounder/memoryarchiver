import { useState, useEffect } from 'react';
import { getReceiptItems } from '../../api/receipts.js';

function fmtMoney(val) {
  if (val == null) return '—';
  return `$${Number(val).toFixed(2)}`;
}

function fmtQty(item) {
  if (item.is_weight_item) return `${item.quantity} lb`;
  return item.quantity ?? '—';
}

function dealDesc(item) {
  if (!item.is_weight_item) return '—';
  if (item.quantity != null && item.unit_price != null) {
    return `${item.quantity} lb @ ${fmtMoney(item.unit_price)}/lb`;
  }
  return '—';
}

export function LineItemDrawer({ receiptId }) {
  const [items,   setItems]   = useState(null);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    setItems(null);
    setError(null);
    getReceiptItems(receiptId)
      .then(setItems)
      .catch(err => setError(err.message));
  }, [receiptId]);

  if (error) {
    return <p className="text-red-400 text-xs px-3 py-2">{error}</p>;
  }

  if (!items) {
    return <p className="text-slate-500 text-xs px-3 py-2">Loading…</p>;
  }

  return (
    <div className="overflow-x-auto bg-slate-900/60 border-t border-slate-800">
      <table className="w-full text-xs text-left">
        <thead>
          <tr className="text-slate-500 border-b border-slate-800">
            <th className="px-3 py-1.5 font-medium w-10">#</th>
            <th className="px-3 py-1.5 font-medium">Description</th>
            <th className="px-3 py-1.5 font-medium text-right">Qty</th>
            <th className="px-3 py-1.5 font-medium text-right">Unit Price</th>
            <th className="px-3 py-1.5 font-medium text-right">Total</th>
            <th className="px-3 py-1.5 font-medium">Deal</th>
            <th className="px-3 py-1.5 font-medium w-16">Tax Code</th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <tr key={item.id} className="border-b border-slate-800/40">
              <td className="px-3 py-1 text-slate-500">{item.line_order + 1}</td>
              <td className="px-3 py-1 text-slate-200">
                <span className="flex items-center gap-1">
                  {!item.item_type_id && (
                    <span className="text-amber-400" title="Unresolved item type">⚠</span>
                  )}
                  {item.description}
                </span>
              </td>
              <td className={`px-3 py-1 text-right tabular-nums ${item.is_weight_item ? 'text-slate-600' : 'text-slate-400'}`}>
                {fmtQty(item)}
              </td>
              <td className={`px-3 py-1 text-right tabular-nums ${item.is_weight_item ? 'text-slate-600' : 'text-slate-400'}`}>
                {item.is_weight_item ? '—' : fmtMoney(item.unit_price)}
              </td>
              <td className="px-3 py-1 text-right tabular-nums text-slate-300">
                {fmtMoney(item.price)}
              </td>
              <td className="px-3 py-1 text-slate-400">{dealDesc(item)}</td>
              <td className="px-3 py-1 text-slate-500">{item.price_code ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
