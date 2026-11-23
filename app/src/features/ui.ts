/** Layout state that only matters on a narrow screen (a phone). */
import { create } from 'zustand';

interface UiState {
  /** The list of essays is showing as a drawer. On a wide screen it is always visible. */
  navOpen: boolean;
  setNavOpen(open: boolean): void;
}

export const useUi = create<UiState>((set) => ({
  navOpen: false,
  setNavOpen: (navOpen) => set({ navOpen }),
}));
