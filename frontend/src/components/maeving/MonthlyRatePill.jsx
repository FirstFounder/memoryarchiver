import React, { useState } from 'react';
import ManualRatesPanel from './ManualRatesPanel';

function formatCents(val, partial = false) {
  if (val == null) return '—';
  const sign = val < 0 ? '–' : '+';
  return `${sign}${Math.abs(val).toFixed(2)}¢${partial ? ' (est)' : ''}`;
}

function monthLabel(rateMonth) {
  if (!rateMonth) return '';
  const [year, month] = rateMonth.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'short' });
}

export default function MonthlyRatePill({ rates, onUpdated }) {
  const [showManual, setShowManual] = useState(false);

  const label = monthLabel(rates.rate_month);

  return (
    <>
      <div
        className="bg-white rounded px-1.5 py-0.5 text-xs font-mono flex gap-1.5 items-center"
        style={{ color: '#0047AB' }}
      >
        <span>
          {label} CFRA:{' '}
          {rates.cfra_status === 'fail' ? (
            <button
              onClick={() => setShowManual(true)}
              className="underline hover:opacity-70"
            >
              fail ↗
            </button>
          ) : (
            formatCents(rates.cfra_cents, rates.cfra_partial === 1)
          )}
        </span>
        <span>
          PEA:{' '}
          {rates.pea_status === 'fail' ? (
            <button
              onClick={() => setShowManual(true)}
              className="underline hover:opacity-70"
            >
              fail ↗
            </button>
          ) : (
            formatCents(rates.pea_cents)
          )}
        </span>
      </div>
      {showManual && (
        <ManualRatesPanel
          rates={rates}
          onClose={() => setShowManual(false)}
          onSaved={(updated) => {
            setShowManual(false);
            if (onUpdated) onUpdated(updated);
          }}
        />
      )}
    </>
  );
}
