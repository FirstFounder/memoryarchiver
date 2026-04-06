import { create } from 'zustand';

export const useSyncStore = create((set) => ({
  /** @type {Map<number, object>} */
  syncJobs: new Map(),

  setSyncJobs(arr) {
    set({ syncJobs: new Map(arr.map(j => [j.id, j])) });
  },

  upsertSyncJob(job) {
    // Ignore placeholder events with null id (e.g. the 'queued' notification
    // emitted immediately after auto-queueing; the full list refresh will follow)
    if (job.id == null) return;
    set(state => {
      const next = new Map(state.syncJobs);
      next.set(job.id, { ...(next.get(job.id) ?? {}), ...job });
      return { syncJobs: next };
    });
  },

  removeSyncJob(id) {
    set(state => {
      const next = new Map(state.syncJobs);
      next.delete(id);
      return { syncJobs: next };
    });
  },
}));
