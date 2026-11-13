/** Theme cookie shared by the server layout and the client toggle (kept out of 'use client' modules so the server reads the values). */
export type Theme = 'dark' | 'light';
export const THEME_COOKIE = 'nx-theme';
/** The product opens dark unless the reader chose light. */
export const DEFAULT_THEME: Theme = 'dark';
