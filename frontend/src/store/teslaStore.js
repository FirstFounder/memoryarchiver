import { create } from 'zustand';

export const useTeslaStore = create((set) => ({
  vehicles: [],
  vehicleStatus: {},
  manualEntries: {},
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

  setSelectedGarageVin(vin) {
    set({ selectedGarageVin: vin });
  },
}));
