import React, { useState } from 'react';
import { saveManualRates } from '../../api/maeving';

export default function ManualRatesPanel({ rates, onClose, onSaved }) {
  const [cfra, setCfra] = useState(rates.cfra_cents != null ? String(rates.cfra_cents) : '');
  const [pea, setPea] = useState(rates.pea_cents != null ? String(rates.pea_cents) : '');
  const [saving, setSaving] = useState(false);

  const monthYear = rates.rate_month
    ? new Date(rates.rate_month + '-01').toLocaleString('en-US', { month: 'long', year: 'numeric' })
    : 'Current Month';

  async function handleSave() {
    setSaving(true);
    try {
      const updated = await saveManualRates(
        cfra !== '' ? parseFloat(cfra) : null,
        pea !== '' ? parseFloat(pea) : null
      );
      onSaved(updated);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 bg-slate-800 border border-slate-600 rounded-lg shadow-xl p-4 w-80">
      <div className="flex justify-between items-start mb-3">
        <div>
          <div className="text-slate-100 font-semibold text-sm">Monthly Rate Entry</div>
          <div className="text-slate-400 text-xs">{monthYear}</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-200 text-lg leading-none">×</button>
      </div>
      <p className="text-slate-400 text-xs mb-3">
        Enter values from the current ComEd/ICC filings. Leave a field blank to exclude it.
      </p>
      <div className="space-y-2 mb-3">
        <div>
          <label className="text-slate-300 text-xs block mb-1">
            CFRA (¢/kWh) <span className="text-slate-500">— Negative = credit</span>
          </label>
          <input
            type="number"
            step="0.001"
            value={cfra}
            onChange={e => setCfra(e.target.value)}
            placeholder="e.g. -1.344"
            className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-100 text-sm"
          />
        </div>
        <div>
          <label className="text-slate-300 text-xs block mb-1">
            PEA (¢/kWh) <span className="text-slate-500">— Negative = credit</span>
          </label>
          <input
            type="number"
            step="0.001"
            value={pea}
            onChange={e => setPea(e.target.value)}
            placeholder="e.g. 0.23"
            className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-100 text-sm"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs rounded px-3 py-1.5"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-xs rounded px-3 py-1.5"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
