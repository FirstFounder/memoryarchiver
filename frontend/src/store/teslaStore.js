import { create } from 'zustand';

export const useTeslaStore = create((set) => ({
  vehicles: [],
  vehicleStatus: {},
  manualEntries: {},
  plans: {},
  sessions: {},
  sessionTotals: {},
  settings: null,
  selectedGarageVin: null,

  setVehicles(arr) {
    set({ vehicles: arr });
  },

  setVehicleStatus(vin, status) {
    set(state => ({
      vehicleStatus: {
        ...state.vehicleStatus,
        [vin]: status,
      },
    }));
  },

  setManualEntry(vin, entry) {
    set(state => ({
      manualEntries: {
        ...state.manualEntries,
        [vin]: entry,
      },
    }));
  },

  setPlan(vin, plan) {
    set(state => ({
      plans: {
        ...state.plans,
        [vin]: plan,
      },
    }));
  },

  setSessions(vin, sessions, total, offset = 0, limit = sessions.length) {
    set(state => ({
      sessions: {
        ...state.sessions,
        [vin]: sessions,
      },
      sessionTotals: {
        ...state.sessionTotals,
        [vin]: { total, offset, limit },
      },
    }));
  },

  appendSessions(vin, sessions, total) {
    set(state => {
      const existing = state.sessions[vin] ?? [];
      const merged = [...existing];
      for (const session of sessions) {
        if (!merged.some(existingSession => existingSession.id === session.id)) {
          merged.push(session);
        }
      }

      return {
        sessions: {
          ...state.sessions,
          [vin]: merged,
        },
        sessionTotals: {
          ...state.sessionTotals,
          [vin]: {
            total,
            offset: existing.length,
            limit: sessions.length,
          },
        },
      };
    });
  },

  setSettings(settings) {
    set({ settings });
  },

  setSelectedGarageVin(vin) {
    set({ selectedGarageVin: vin });
  },
}));
