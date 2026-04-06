import { useEffect, useState } from 'react';
import { getJobs } from '../api/jobs.js';
import { useJobStore } from '../store/jobStore.js';

/**
 * Fetches the full job list once on mount and loads it into the store.
 * After that, the SSE hook keeps the store updated in real time.
 */
export function useJobs() {
  const setJobs = useJobStore(s => s.setJobs);
  const jobs    = useJobStore(s => s.jobs);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    getJobs()
      .then(setJobs)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [setJobs]);

  // Return as a sorted array (newest first) for easy rendering
  const jobArray = Array.from(jobs.values()).sort((a, b) => b.created_at - a.created_at);

  return { jobs: jobArray, loading, error };
}
