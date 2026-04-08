import { useEffect, useRef } from 'react';
import { useJobStore } from '../store/jobStore.js';
import { useSyncStore } from '../store/syncStore.js';
import { useHubStore } from '../store/hubStore.js';
import { getSyncJobs } from '../api/sync.js';

const BASE_DELAY = 1_000;
const MAX_DELAY  = 30_000;

/**
 * Opens a persistent SSE connection to /api/events and routes named events
 * into their respective Zustand stores.
 *
 * Named event types (set by the server):
 *   connected  — stream is live
 *   job        — encoding job update  → jobStore
 *   sync       — sync job update      → syncStore
 *                When id is null the server is signalling a new auto-queued sync;
 *                we do a full refresh of the sync list to pick it up.
 *
 * Call once at the App root.
 */
export function useSSE() {
  const upsertJob       = useJobStore(s => s.upsertJob);
  const upsertSyncJob   = useSyncStore(s => s.upsertSyncJob);
  const setSyncJobs     = useSyncStore(s => s.setSyncJobs);
  const upsertLiveState = useHubStore(s => s.upsertLiveState);
  const delay           = useRef(BASE_DELAY);
  const esRef           = useRef(null);

  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const es = new EventSource('/api/events');
      esRef.current = es;

      es.addEventListener('connected', () => {
        delay.current = BASE_DELAY;
      });

      es.addEventListener('job', (e) => {
        try { upsertJob(JSON.parse(e.data)); } catch { /* ignore */ }
      });

      es.addEventListener('sync', (e) => {
        try {
          const payload = JSON.parse(e.data);
          if (payload.id == null) {
            // A new file sync was auto-queued — refresh the full list
            getSyncJobs().then(setSyncJobs).catch(() => {});
          } else {
            upsertSyncJob(payload);
          }
        } catch { /* ignore */ }
      });

      es.addEventListener('hub-sync', (e) => {
        try {
          const payload = JSON.parse(e.data);
          if (payload.destinationId != null) {
            upsertLiveState(payload.destinationId, payload);
          }
        } catch { /* ignore */ }
      });

      es.onerror = () => {
        es.close();
        if (cancelled) return;
        setTimeout(connect, delay.current);
        delay.current = Math.min(delay.current * 2, MAX_DELAY);
      };
    }

    connect();
    return () => {
      cancelled = true;
      esRef.current?.close();
    };
  }, [upsertJob, upsertSyncJob, setSyncJobs, upsertLiveState]);
}
