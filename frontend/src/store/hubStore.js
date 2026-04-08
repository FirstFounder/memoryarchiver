import { create } from 'zustand';

/**
 * Hub store.
 *
 *  destinations  — fetched from GET /api/hub/destinations on mount
 *  liveState     — keyed by destinationId, updated from SSE hub-sync events
 */
export const useHubStore = create((set) => ({
  /** @type {Array} */
  destinations: [],

  /** @type {Record<number, object>} */
  liveState: {},

  setDestinations(arr) {
    set({ destinations: arr });
  },

  upsertLiveState(destinationId, update) {
    set(state => ({
      liveState: {
        ...state.liveState,
        [destinationId]: {
          ...(state.liveState[destinationId] ?? {}),
          ...update,
        },
      },
    }));
  },
}));
