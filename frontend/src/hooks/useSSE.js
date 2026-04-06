import { useEffect, useRef } from 'react';
import { useJobStore } from '../store/jobStore.js';

const BASE_DELAY = 1_000;
const MAX_DELAY  = 30_000;

/**
 * Opens a persistent SSE connection to /api/events and pipes job update
 * events into the Zustand job store.  Reconnects automatically on error.
 *
 * Call once at the App root.
 */
export function useSSE() {
  const upsertJob = useJobStore(s => s.upsertJob);
  const delay     = useRef(BASE_DELAY);
  const esRef     = useRef(null);

  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const es = new EventSource('/api/events');
      esRef.current = es;

      es.addEventListener('connected', () => {
        delay.current = BASE_DELAY; // reset backoff on successful connection
      });

      es.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data);
          upsertJob(payload);
        } catch { /* malformed event */ }
      };

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
  }, [upsertJob]);
}
