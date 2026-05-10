import { create } from 'zustand';

export const useReceiptsStore = create((set) => ({
  receipts: [],
  loaded:   false,

  setReceipts(rows) {
    set({ receipts: rows, loaded: true });
  },

  removeReceipt(id) {
    set(s => ({ receipts: s.receipts.filter(r => r.id !== id) }));
  },
}));
