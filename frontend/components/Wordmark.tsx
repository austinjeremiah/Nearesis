type Props = {
  /** 'black' = dark ink on the pale header, 'white' = pale ink on the dark header. */
  tone?: 'black' | 'white';
  /** Cap height of the mark; the word scales with it. */
  size?: number;
  className?: string;
};

/**
 * The Nearesis wordmark, drawn in markup rather than shipped as an <img>, so the
 * word renders in the same face as the hero's "RERUN." slab (an external SVG
 * cannot reach the page's webfonts).
 *
 * Colours and the font are named literally rather than through CSS variables.
 * The marketing site and the app load different stylesheets, so a variable used
 * here resolves on one and silently fails on the other. That is exactly how the
 * mark ended up as an empty black square in the app: its lime stroke referenced
 * a Webflow variable the app never loads.
 */
const NEAR_GREEN = '#00ec97';
const PALE = '#f1efe2';
const INK = '#000000';

export default function Wordmark({ tone = 'black', size = 32, className }: Props) {
  const ink = tone === 'white' ? PALE : INK;
  const markBg = tone === 'white' ? PALE : INK;
  const markFg = tone === 'white' ? INK : NEAR_GREEN;

  // `display` stays out of the outer element's inline style: the header toggles
  // the light/dark wordmark with `display: none`, and an inline value would
  // outrank it. The word is a separate element so a collapsed sidebar can hide
  // it in CSS and leave the mark centred.
  return (
    <div className={`wordmark ${className ?? ''}`.trim()}>
      <span className="wordmark-row">
        <span
          aria-hidden="true"
          className="wordmark-mark"
          style={{ width: size, height: size, background: markBg }}
        >
          <svg viewBox="0 0 29 29" width={size} height={size} fill="none" aria-hidden="true">
            <path
              d="M9 22.5 V6.5 L20 22.5 V6.5"
              stroke={markFg}
              strokeWidth="3"
              strokeLinecap="square"
              strokeLinejoin="miter"
            />
          </svg>
        </span>
        <span
          className="wordmark-text"
          style={{
            fontFamily: "'Stack Sans Notch', 'Inter Tight', system-ui, sans-serif",
            fontSize: size * 0.94,
            marginLeft: size * 0.26,
            color: ink,
          }}
        >
          Nearesis
        </span>
      </span>
    </div>
  );
}
