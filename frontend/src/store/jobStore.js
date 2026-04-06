import { create } from 'zustand';

/**
 * Central store for job queue state.
 *
 * Populated by:
 *   - useJobs hook on mount (initial fetch)
 *   - useSSE hook on every incoming server-sent event (real-time updates)
 */
export const useJobStore = create((set) => ({
  /** @type {Map<number, object>} */
  jobs: new Map(),

  /** Replace the entire job map (used on initial load) */
  setJobs(jobArray) {
    set({ jobs: new Map(jobArray.map(j => [j.id, j])) });
  },

  /** Insert or update a single job */
  upsertJob(job) {
    set(state => {
      const next = new Map(state.jobs);
      next.set(job.id, { ...(next.get(job.id) ?? {}), ...job });
      return { jobs: next };
    });
  },

  /** Remove a job from the store */
  removeJob(id) {
    set(state => {
      const next = new Map(state.jobs);
      next.delete(id);
      return { jobs: next };
    });
  },
}));
