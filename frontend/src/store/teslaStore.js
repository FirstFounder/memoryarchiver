import { create } from 'zustand';

export const useTeslaStore = create((set) => ({
  vehicles: [],
  vehicleStatus: {},
  manualEntries: {},
  plans: {},
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

  setSettings(settings) {
    set({ settings });
  },

  setSelectedGarageVin(vin) {
    set({ selectedGarageVin: vin });
  },
}));
