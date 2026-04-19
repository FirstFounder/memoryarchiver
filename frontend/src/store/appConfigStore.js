import { create } from 'zustand';

/**
 * Stores the server-side app configuration fetched from /api/config on load.
 * deviceRole drives conditional rendering of hub-only panels.
 */
export const useAppConfigStore = create((set) => ({
  deviceRole:      'remote',
  nasOutputRoot:   '',
  syncDestRoot:    '',
  pushTargets:     [],
  nfsDestinations: [],
  coopEnabled:     false,
  teslaEnabled:    false,
  caEnabled:       false,
  hubUrl:          '',
  loaded:          false,

  setConfig: (cfg) => set({ ...cfg, loaded: true }),
}));
