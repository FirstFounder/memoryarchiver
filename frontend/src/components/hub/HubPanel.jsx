import { useEffect, useCallback } from 'react';
import { getDestinations } from '../../api/hub.js';
import { useHubStore } from '../../store/hubStore.js';
import { DestinationCard } from './DestinationCard.jsx';
import { SyncHistoryTable } from './SyncHistoryTable.jsx';

export function HubPanel() {
  const destinations    = useHubStore(s => s.destinations);
  const liveState       = useHubStore(s => s.liveState);
  const setDestinations = useHubStore(s => s.setDestinations);

  const refresh = useCallback(() => {
    getDestinations().then(setDestinations).catch(() => {});
  }, [setDestinations]);

  // Initial fetch on mount
  useEffect(() => { refresh(); }, [refresh]);

  // Merge REST destinations with live SSE state for each card
  const mergedDestinations = destinations.map(d => ({
    ...d,
    _live: liveState[d.id] ?? null,
  }));

  return (
    <div className="flex flex-col">
      {/* Section header */}
      <div className="flex items-center justify-between mb-4 pt-4 border-t border-slate-800">
        <h2 className="text-slate-200 font-semibold text-sm">Hub Destinations</h2>
        <button
          onClick={refresh}
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          title="Refresh"
        >
          ↻ Refresh
        </button>
      </div>

      {destinations.length === 0 && (
        <p className="text-slate-600 text-xs text-center py-8">
          Loading destinations…
        </p>
      )}

      {/* 2×2 destination card grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {mergedDestinations.map(dest => (
          <DestinationCard
            key={dest.id}
            destination={dest}
            onRefresh={refresh}
          />
        ))}
      </div>

      {/* Global sync history table */}
      <SyncHistoryTable destinations={destinations} />
    </div>
  );
}
