import { useEffect, useState } from 'react';
import { getSyncJobs } from '../api/sync.js';
import { useSyncStore } from '../store/syncStore.js';

/**
 * Fetches the full sync job list once on mount.
 * The SSE hook keeps it live after that.
 * Also re-fetches whenever a 'queued' sync:update arrives (null id)
 * so newly auto-queued file syncs appear without a manual refresh.
 */
export function useSyncJobs() {
  const setSyncJobs  = useSyncStore(s => s.setSyncJobs);
  const syncJobs     = useSyncStore(s => s.syncJobs);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    getSyncJobs()
      .then(setSyncJobs)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [setSyncJobs]);

  const jobArray = Array.from(syncJobs.values()).sort((a, b) => b.created_at - a.created_at);
  return { syncJobs: jobArray, loading, error, refresh: () => getSyncJobs().then(setSyncJobs) };
}
