'use client';

import { useEffect } from 'react';

// Same files, same order as the <script> tags at the end of the Webflow page.
const JQUERY = '/js/jquery-3.5.1.min.js';
const SCRIPTS = [
  JQUERY,
  '/js/webflow.schunk.a3140c51201be139.js',
  '/js/webflow.schunk.7f02404addf2d9bb.js',
  '/js/webflow.54de4acb.9272109727951c45.js',
  '/js/gsap.min.js',
  '/js/SplitText.min.js',
  '/js/ScrollTrigger.min.js',
  '/js/lenis.min.js',
  '/js/custom.js',
];

type JQueryLike = ((fn: () => void) => void) & { holdReady(hold: boolean): void };

let started = false;

function load(src: string, onload?: () => void) {
  return new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    // async=false: download in parallel, execute strictly in insertion order
    el.async = false;
    el.onload = () => {
      onload?.();
      resolve();
    };
    el.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.body.appendChild(el);
  });
}

/**
 * On the Webflow page the scripts are parsed with the document, which fixes the order
 *   scripts run -> DOM ready (Webflow.ready: sliders, tabs, IX2, Lenis) -> window load (IX3 intro)
 * Here they are injected after hydration, when the document may already be "complete".
 * Left alone, IX3 would then start the moment webflow.js is evaluated - before GSAP has
 * even arrived - and the intro animations would never play. So the page is presented
 * as still "interactive" until Webflow.ready has run, then load is delivered.
 */
async function boot() {
  let loadSwallowed = false;
  const swallowLoad = (e: Event) => {
    loadSwallowed = true;
    e.stopImmediatePropagation();
  };
  window.addEventListener('load', swallowLoad, true);
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'interactive' });

  const finish = () => {
    window.removeEventListener('load', swallowLoad, true);
    delete (document as { readyState?: string }).readyState;
    if (loadSwallowed || document.readyState === 'complete') {
      document.dispatchEvent(new Event('readystatechange'));
      window.dispatchEvent(new Event('load'));
    }
  };

  let $: JQueryLike | undefined;
  try {
    await Promise.all(
      SCRIPTS.map((src) =>
        load(
          src,
          src === JQUERY
            ? () => {
                // hold DOM-ready until every script in the list has run
                $ = (window as unknown as { jQuery: JQueryLike }).jQuery;
                $.holdReady(true);
              }
            : undefined,
        ),
      ),
    );
  } catch (err) {
    finish();
    throw err;
  }
  if (!$) return finish();
  $.holdReady(false);
  // queued behind Webflow.ready, so it runs once the DOM-ready work is done
  $(finish);
}

/**
 * Boots the untouched Webflow runtime (interactions, sliders, tabs, forms) after
 * hydration. It must not run earlier: the runtime rewrites the DOM (SplitText,
 * slider nav, inline styles) and React would discard a tree that changed under it.
 */
export default function WebflowRuntime() {
  useEffect(() => {
    if (started) return;
    started = true;
    boot().catch((err) => console.error('[webflow runtime]', err));
  }, []);
  return null;
}
