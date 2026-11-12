type Props = {
  /** 'black' = dark ink on the pale header, 'white' = pale ink on the dark header. */
  tone?: "black" | "white";
  /** Cap height of the mark; the word scales with it. */
  size?: number;
  className?: string;
};

/**
 * The Nearesis wordmark, drawn in markup rather than shipped as an <img>, so the
 * word renders in the same third-family face as the hero's "RERUN." slab
 * (an external SVG cannot reach the page's webfonts).
 */
export default function Wordmark({
  tone = "black",
  size = 32,
  className,
}: Props) {
  const ink = tone === "white" ? "var(--_color---main-color--pale)" : "#000";
  const markBg = tone === "white" ? "var(--_color---main-color--pale)" : "#000";
  const markFg =
    tone === "white" ? "#000" : "var(--_color---main-color--green-neon)";

  // `display` stays out of the outer element's inline style: the header toggles the
  // light/dark wordmark with `display: none`, and an inline value would outrank it.
  return (
    <div className={className}>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: size * 0.26,
          lineHeight: 1,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: size,
            height: size,
            background: markBg,
            flex: "none",
            display: "block",
          }}
        >
          <svg
            viewBox="0 0 29 29"
            width={size}
            height={size}
            fill="none"
            aria-hidden="true"
          >
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
          style={{
            fontFamily: "var(--_base---font-family--third-family)",
            fontWeight: 400,
            fontSize: size * 0.94,
            letterSpacing: "-.03em",
            color: ink,
            whiteSpace: "nowrap",
          }}
        >
          Nearesis
        </span>
      </span>
    </div>
  );
}
