import { useState, useEffect } from 'react';
import { getReceipt } from '../../api/receipts.js';

function fmtMoney(val) {
  if (val == null) return '—';
  return `$${Number(val).toFixed(2)}`;
}

export function LineItemDrawer({ receiptId }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setItems(null);
    setError(null);
    getReceipt(receiptId)
      .then(data => setItems(data.items ?? []))
      .catch(err => setError(err.message));
  }, [receiptId]);

  if (error) {
    return <p className="text-red-400 text-xs px-3 py-2">{error}</p>;
  }

  if (!items) {
    return <p className="text-slate-500 text-xs px-3 py-2">Loading…</p>;
  }

  if (items.length === 0) {
    return <p className="text-slate-500 text-xs px-3 py-2">No items.</p>;
  }

  return (
    <div className="overflow-x-auto bg-slate-900/60 border-t border-slate-800">
      <table className="w-full text-xs text-left">
        <thead>
          <tr className="text-slate-500 border-b border-slate-800">
            <th className="px-3 py-1.5 font-medium w-10">#</th>
            <th className="px-3 py-1.5 font-medium">Description</th>
            <th className="px-3 py-1.5 font-medium text-right">Price</th>
            <th className="px-3 py-1.5 font-medium">Code</th>
            <th className="px-3 py-1.5 font-medium text-right">Qty</th>
            <th className="px-3 py-1.5 font-medium text-right">Unit Price</th>
            <th className="px-3 py-1.5 font-medium text-right">Weight</th>
            <th className="px-3 py-1.5 font-medium text-right">Rate/lb</th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <tr key={item.id} className="border-b border-slate-800/40">
              <td className="px-3 py-1 text-slate-500">{item.sort_order ?? '—'}</td>
              <td className="px-3 py-1 text-slate-200">
                {item.is_weight_item ? (
                  <span className="flex items-center gap-1">
                    <span className="text-slate-500 text-xs">⚖</span>
                    {item.description}
                  </span>
                ) : item.description}
              </td>
              <td className="px-3 py-1 text-right tabular-nums text-slate-300">
                {fmtMoney(item.price)}
              </td>
              <td className="px-3 py-1 text-slate-500">{item.price_code ?? '—'}</td>
              <td className="px-3 py-1 text-right tabular-nums text-slate-400">
                {item.is_weight_item ? '—' : (item.quantity ?? '—')}
              </td>
              <td className="px-3 py-1 text-right tabular-nums text-slate-400">
                {item.is_weight_item ? '—' : fmtMoney(item.unit_price)}
              </td>
              <td className="px-3 py-1 text-right tabular-nums text-slate-400">
                {item.is_weight_item && item.weight != null ? `${item.weight} lb` : '—'}
              </td>
              <td className="px-3 py-1 text-right tabular-nums text-slate-400">
                {item.is_weight_item && item.rate_per_lb != null ? fmtMoney(item.rate_per_lb) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
