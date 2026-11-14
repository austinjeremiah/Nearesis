import type { SVGProps } from "react";

/** Small stroke icon set (16px grid, 1.5px stroke). No emoji, no icon font, no network. */
type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className: "nz-icon",
  "aria-hidden": true,
  focusable: false,
  ...p,
});
const mk = (d: string) =>
  function Icon(p: P) {
    return (
      <svg {...base(p)}>
        <path d={d} />
      </svg>
    );
  };

export const IconSidebar = (p: P) => (
  <svg {...base(p)}>
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <path d="M6 3v10" />
  </svg>
);
export const IconChat = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h-.5" />
  </svg>
);
export const IconSearch = (p: P) => (
  <svg {...base(p)}>
    <circle cx="7" cy="7" r="4" />
    <path d="m10 10 3 3" />
  </svg>
);
export const IconChevron = mk("m6 4 4 4-4 4");
export const IconChevronDown = mk("m4 6 4 4 4-4");
export const IconCheck = mk("m3.5 8.5 3 3 6-7");
export const IconX = mk("m4 4 8 8M12 4l-8 8");
export const IconPlus = mk("M8 3v10M3 8h10");
export const IconUndo = mk("M6 4 3 7l3 3M3 7h6a4 4 0 0 1 0 8H7");
export const IconRedo = mk("m10 4 3 3-3 3M13 7H7a4 4 0 0 0 0 8h2");
export const IconSend = mk("M8 13V3M4 7l4-4 4 4");
export const IconStop = (p: P) => (
  <svg {...base(p)}>
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
  </svg>
);
export const IconGrip = (p: P) => (
  <svg {...base({ strokeWidth: 2, ...p })}>
    <path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01" />
  </svg>
);
export const IconMore = (p: P) => (
  <svg {...base({ strokeWidth: 2, ...p })}>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" />
  </svg>
);
export const IconInvestigation = (p: P) => (
  <svg {...base(p)}>
    <circle cx="7" cy="7" r="4" />
    <path d="m10 10 3 3M5.5 7h3M7 5.5v3" />
  </svg>
);
export const IconSource = (p: P) => (
  <svg {...base(p)}>
    <ellipse cx="8" cy="4.5" rx="5" ry="2" />
    <path d="M3 4.5v7c0 1.1 2.2 2 5 2s5-.9 5-2v-7M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
  </svg>
);
export const IconReport = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3M6 9h4M6 11.5h4" />
  </svg>
);
export const IconSettings = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.8 3.8l1 1M11.2 11.2l1 1M12.2 3.8l-1 1M4.8 11.2l-1 1" />
  </svg>
);
export const IconCanvas = (p: P) => (
  <svg {...base(p)}>
    <rect x="2.5" y="2.5" width="5" height="5" rx="1" />
    <rect x="9" y="2.5" width="4.5" height="3" rx="1" />
    <rect x="2.5" y="9" width="5" height="4.5" rx="1" />
    <rect x="9" y="7" width="4.5" height="6.5" rx="1" />
  </svg>
);
export const IconBranch = (p: P) => (
  <svg {...base(p)}>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="6.5" r="1.5" />
    <path d="M4.5 5v6M11.5 8c0 2-2 2.5-4.5 2.5" />
  </svg>
);
export const IconQuery = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 4 2.5 8 5 12M11 4l2.5 4L11 12M9 3.5 7 12.5" />
  </svg>
);
export const IconShield = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 2 3 4v4c0 3 2 5 5 6 3-1 5-3 5-6V4z" />
    <path d="m6 8 1.5 1.5L10 7" />
  </svg>
);
export const IconWarn = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 2.5 14 13H2zM8 6.5v3M8 11.2h.01" />
  </svg>
);
export const IconLink = mk(
  "M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8",
);
export const IconMoon = mk("M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z");
export const IconSun = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="2.8" />
    <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />
  </svg>
);
export const IconBell = mk("M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3zM6.5 14h3");
