import { create } from 'zustand';

export const useReceiptsStore = create((set) => ({
  receipts: [],
  total:    0,
  page:     1,
  limit:    50,
  loaded:   false,

  setReceipts(data) {
    set({
      receipts: data.receipts ?? [],
      total:    data.total   ?? 0,
      page:     data.page    ?? 1,
      limit:    data.limit   ?? 50,
      loaded:   true,
    });
  },

  removeReceipt(id) {
    set(s => ({
      receipts: s.receipts.filter(r => r.id !== id),
      total:    Math.max(0, s.total - 1),
    }));
  },

  upsertReceipt(receipt) {
    set(s => {
      const idx = s.receipts.findIndex(r => r.id === receipt.id);
      if (idx === -1) {
        return { receipts: [receipt, ...s.receipts] };
      }
      const next = [...s.receipts];
      next[idx] = receipt;
      return { receipts: next };
    });
  },
}));
