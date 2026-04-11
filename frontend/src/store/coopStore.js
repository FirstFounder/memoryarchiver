import { create } from 'zustand';

export const useCoopStore = create((set) => ({
  // Last known state from any poll or action
  doorState:       null,   // 'open' | 'closed' | 'moving' | null
  schedulerActive: null,   // true | false | null
  openAt:          null,   // '08:00' | null
  closeAt:         null,   // '19:00' | null
  lastPolledAt:    null,   // JS Date | null
  unreachable:     false,  // true if last poll/action got an SSH error

  // Post-action move tracking
  isMoving:      false,
  moveAction:    null,   // 'open' | 'close'
  moveStartedAt: null,   // JS Date

  // Last scheduled check (from DB)
  lastCheck: null,   // object from GET /api/coop/last-check | null

  applyStatus(statusJson) {
    if (statusJson?.error === 'unreachable') {
      set({ unreachable: true });
      return;
    }
    set({
      unreachable:     false,
      doorState:       statusJson?.state           ?? null,
      schedulerActive: statusJson?.schedulerActive ?? null,
      openAt:          statusJson?.openAt          ?? null,
      closeAt:         statusJson?.closeAt         ?? null,
      lastPolledAt:    new Date(),
    });
  },

  setLastCheck(row) {
    set({ lastCheck: row });
  },

  startMove(action) {
    set({ isMoving: true, moveAction: action, moveStartedAt: new Date() });
  },

  clearMove() {
    set({ isMoving: false, moveAction: null, moveStartedAt: null });
  },
}));
