import { useEffect, useRef, useState } from "react";

/** Durations (ms) and easings mirrored from the CSS tokens, for JS-driven motion. */
export const motionTokens = {
  instant: 80,
  fast: 140,
  base: 200,
  slow: 320,
  easeStandard: [0.2, 0, 0, 1] as const,
  easeEnter: [0.16, 1, 0.3, 1] as const,
  easeExit: [0.4, 0, 1, 1] as const,
  /** Spring for layout moves (panel reorder, dock). */
  spring: { type: "spring", stiffness: 420, damping: 34, mass: 0.9 } as const,
};

/** True when the user asked for reduced motion, or the page forces it with data-motion="reduced". */
export function useReducedMotion(): boolean {
  const get = () => {
    if (typeof window === "undefined") return false;
    if (document.documentElement.dataset.motion === "reduced") return true;
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  };
  const [reduced, setReduced] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(get());
    mq?.addEventListener("change", update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    return () => {
      mq?.removeEventListener("change", update);
      mo.disconnect();
    };
  }, []);
  return reduced;
}

/** Returns true for `ms` after `trigger` changes (not on first render). Drives the "patch applied" ring. */
export function useFlashOnChange(trigger: unknown, ms = 1400): boolean {
  const [on, setOn] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setOn(true);
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [trigger, ms]);
  return on;
}
