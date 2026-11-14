'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

import { DEFAULT_THEME, THEME_COOKIE, type Theme } from '@/lib/theme';

function apply(t: Theme) {
  document.documentElement.dataset.theme = t;
  document.querySelectorAll<HTMLElement>('.nx').forEach((el) => (el.dataset.theme = t));
}

/** Mirrors the server-rendered theme onto <html> so the page background and charts follow it. */
export function ThemeSync({ theme }: { theme: Theme }) {
  useEffect(() => {
    apply(theme);
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [theme]);
  return null;
}

/** Topbar switch. The choice is kept in a cookie so the next page load renders in it without a flash. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    if (t === 'light' || t === 'dark') setTheme(t);
  }, []);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="btn ghost"
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      data-testid="theme-toggle"
      onClick={() => {
        apply(next);
        setTheme(next);
        document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
      }}
    >
      {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  );
}
