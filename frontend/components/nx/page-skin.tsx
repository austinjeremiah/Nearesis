'use client';

import { useEffect } from 'react';

/**
 * Per-page background skin.
 *
 * The marketing site changes paper between sections: greige, cream, and the
 * dark panel with the faint question-mark field. A page declares which one it
 * wants and the shell paints it, so the skin covers the header and the content
 * together rather than stopping at a container edge.
 *
 * It is set on the document element and cleared on unmount, so a route that
 * says nothing goes back to the default paper.
 */
export default function PageSkin({ tone }: { tone: 'ink' | 'cream' | 'greige' }) {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.skin;
    root.dataset.skin = tone;
    return () => {
      if (previous) root.dataset.skin = previous;
      else delete root.dataset.skin;
    };
  }, [tone]);

  return null;
}
