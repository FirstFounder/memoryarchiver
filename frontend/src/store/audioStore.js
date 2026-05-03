import { create } from 'zustand';

export const useAudioStore = create((set, get) => ({
  files:   [],
  loaded:  false,

  setFiles: (files) => set({ files, loaded: true }),

  upsertFile: (record) => set(state => {
    const idx = state.files.findIndex(f => f.id === record.id);
    if (idx === -1) {
      return { files: [record, ...state.files] };
    }
    const files = [...state.files];
    files[idx] = { ...files[idx], ...record };
    return { files };
  }),
}));
