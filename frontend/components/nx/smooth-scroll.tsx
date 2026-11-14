'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import Lenis from 'lenis';

/**
 * Smooth scrolling for the reading column.
 *
 * Three rules keep this from becoming a liability on a data application.
 *
 * It only ever drives the main reading column. A screen built as a fixed frame
 * with an inspector, the Canvas above all, keeps native scrolling, because a
 * panel drag, a chart brush and an inertial scroller fighting over the same
 * pointer is how a canvas starts feeling broken.
 *
 * It yields during a gesture. While a panel is being dragged or a chart
 * brushed, the instance is stopped and the browser is in charge again.
 *
 * It respects the reduced-motion preference by not running at all. Someone who
 * has asked the system for less movement is not asking for eased inertia.
 */
export default function SmoothScroll() {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches) return;

    const wrapper = document.querySelector<HTMLElement>('.main');
    const content = document.querySelector<HTMLElement>('.main-inner');
    if (!wrapper || !content) return;

    // A fixed-frame screen scrolls its own panes. Leave those alone.
    // The Agent page is a fixed frame with its own scrolling zones, and a page can opt out explicitly.
    if (wrapper.querySelector('.with-inspector, .ag-page, [data-no-smooth]')) return;

    const lenis = new Lenis({
      wrapper,
      content,
      // Short and firm. This is a document, not a landing page: the easing is
      // there to take the edge off a wheel tick, not to glide.
      duration: 0.75,
      easing: (t: number) => 1 - Math.pow(1 - t, 3),
      smoothWheel: true,
      // Touch devices already have inertia from the platform, and overriding it
      // makes a phone feel worse rather than better.
      syncTouch: false,
    });

    let frame = requestAnimationFrame(function raf(time: number) {
      lenis.raf(time);
      frame = requestAnimationFrame(raf);
    });

    // Hand control back while something is being dragged or brushed.
    const pause = () => lenis.stop();
    const resume = () => lenis.start();
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('.cgrid-item, .chart, .graph, canvas, input[type="range"]')) pause();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', resume, true);
    window.addEventListener('pointercancel', resume, true);

    // The scroll height changes as panels, tables and charts settle.
    const ro = new ResizeObserver(() => lenis.resize());
    ro.observe(content);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', resume, true);
      window.removeEventListener('pointercancel', resume, true);
      ro.disconnect();
      lenis.destroy();
    };
  }, [pathname]);

  // A new page starts at the top. The reading column persists across routes,
  // so without this a deep scroll would carry over into the next screen.
  useEffect(() => {
    document.querySelector('.main')?.scrollTo({ top: 0 });
  }, [pathname]);

  return null;
}
