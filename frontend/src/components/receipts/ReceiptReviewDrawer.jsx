import { useState } from 'react';
import { patchReceipt, pdfUrl } from '../../api/receipts.js';

export function ReceiptReviewDrawer({ receipt, onClose, onSaved }) {
  const [storeNumber,  setStoreNumber]  = useState(receipt.store_number  ?? '');
  const [receiptDate,  setReceiptDate]  = useState(receipt.receipt_date?.slice(0, 10) ?? '');
  const [subtotal,     setSubtotal]     = useState(receipt.subtotal      ?? '');
  const [taxAmount,    setTaxAmount]    = useState(receipt.tax_amount    ?? '');
  const [parseStatus,  setParseStatus]  = useState(receipt.parse_status  ?? 'partial');
  const [saving,       setSaving]       = useState(false);
  const [error,        setError]        = useState(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const patch = {};
      const origStore  = receipt.store_number  ?? '';
      const origDate   = receipt.receipt_date?.slice(0, 10) ?? '';
      const origSub    = receipt.subtotal      ?? '';
      const origTax    = receipt.tax_amount    ?? '';

      if (String(storeNumber) !== String(origStore))
        patch.store_number = storeNumber === '' ? null : Number(storeNumber);
      if (receiptDate !== origDate)
        patch.receipt_date = receiptDate === '' ? null : receiptDate;
      if (String(subtotal) !== String(origSub))
        patch.subtotal = subtotal === '' ? null : Number(subtotal);
      if (String(taxAmount) !== String(origTax))
        patch.tax_amount = taxAmount === '' ? null : Number(taxAmount);
      if (parseStatus !== receipt.parse_status)
        patch.parse_status = parseStatus;

      const updated = await patchReceipt(receipt.id, patch);
      onSaved(updated);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      <div className="fixed inset-y-0 right-0 z-50 w-[600px] bg-slate-900 border-l border-slate-700 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 shrink-0">
          <div className="min-w-0">
            <h3 className="text-slate-100 font-semibold text-sm">Review Receipt</h3>
            <p
              className="text-slate-500 text-xs truncate max-w-[480px]"
              title={receipt.pdf_filename}
            >
              {receipt.pdf_filename}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-300 text-xl leading-none ml-4 shrink-0"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 flex overflow-hidden">
          {/* PDF viewer — left half */}
          <div className="w-1/2 border-r border-slate-700">
            <iframe
              src={pdfUrl(receipt.id)}
              className="w-full h-full"
              title="Receipt PDF"
            />
          </div>

          {/* Edit form — right half */}
          <div className="w-1/2 overflow-y-auto px-5 py-5 space-y-4">
            <div className="space-y-1">
              <label className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                Store #
              </label>
              <input
                type="number"
                value={storeNumber}
                onChange={e => setStoreNumber(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="space-y-1">
              <label className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                Date
              </label>
              <input
                type="date"
                value={receiptDate}
                onChange={e => setReceiptDate(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="space-y-1">
              <label className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                Subtotal
              </label>
              <input
                type="number"
                step="0.01"
                value={subtotal}
                onChange={e => setSubtotal(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="space-y-1">
              <label className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                Tax
              </label>
              <input
                type="number"
                step="0.01"
                value={taxAmount}
                onChange={e => setTaxAmount(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="space-y-1">
              <label className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                Status
              </label>
              <select
                value={parseStatus}
                onChange={e => setParseStatus(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
              >
                <option value="ok">ok</option>
                <option value="partial">partial</option>
                <option value="failed">failed</option>
                <option value="flagged">flagged</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                Parse Notes
              </label>
              <input
                type="text"
                value={receipt.parse_notes ?? ''}
                readOnly
                className="w-full bg-slate-800/50 border border-slate-700 text-slate-500 text-sm rounded-lg px-3 py-2 cursor-default"
              />
            </div>

            <div className="space-y-1">
              <label className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                Item Count
              </label>
              <input
                type="text"
                value={receipt.item_count ?? '—'}
                readOnly
                className="w-full bg-slate-800/50 border border-slate-700 text-slate-500 text-sm rounded-lg px-3 py-2 cursor-default"
              />
            </div>

            {error && (
              <p className="text-red-400 text-xs bg-red-950/40 rounded p-2">{error}</p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-slate-800 flex justify-end gap-3 shrink-0">
          <button
            onClick={onClose}
            className="text-sm text-slate-400 hover:text-slate-200 px-4 py-2 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="text-sm px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </>
  );
}
