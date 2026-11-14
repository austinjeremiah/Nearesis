'use client';

import { createContext, useContext } from 'react';

/** The docked Ask panel's open state, shared between the top bar, the page header button and the palette. */
export type AskDockState = {
  /** True on a workspace page, where the dock can open bound to that workspace. */
  available: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
};

export const AskDockContext = createContext<AskDockState>({ available: false, open: false, setOpen: () => undefined });
export const useAskDock = () => useContext(AskDockContext);
