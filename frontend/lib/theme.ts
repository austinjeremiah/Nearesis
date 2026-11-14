/** Theme cookie shared by the server layout and the client toggle (kept out of 'use client' modules so the server reads the values). */
export type Theme = 'dark' | 'light';
export const THEME_COOKIE = 'nx-theme';
/** The product opens in the upstream look (light theme) unless the reader chose dark. */
export const DEFAULT_THEME: Theme = 'light';
