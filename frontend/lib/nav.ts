import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Bell,
  BookOpen,
  Bot,
  Boxes,
  Braces,
  Clock,
  Coins,
  Database,
  FileText,
  FlaskConical,
  GitBranch,
  Gauge,
  History,
  Home,
  LayoutGrid,
  Lightbulb,
  Network,
  Package,
  Radio,
  Scale,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Tag,
} from 'lucide-react';

/**
 * Route inventory from Frontend Product Spec v1 section 2.1.
 *
 * Kept as data rather than JSX so the sidebar, the command palette and the
 * breadcrumb trail all read from the same list. Spec 2.2 warns against twenty
 * permanently visible nav items, which is why the workspace routes are grouped
 * and the groups remember their expanded state.
 */

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown in the command palette to disambiguate similarly named screens. */
  hint?: string;
};

export type NavGroup = {
  id: string;
  label: string;
  items: NavItem[];
  /** Collapsed by default to keep the first screenful short. */
  defaultOpen?: boolean;
};

/** Global area. Visible with or without an active workspace. */
export const GLOBAL_NAV: NavItem[] = [
  { href: '/home', label: 'Home', icon: Home, hint: 'What needs your attention' },
  { href: '/thesis', label: 'NEAR Thesis', icon: Scale, hint: 'Intents vs price: the verdict and the evidence' },
  { href: '/agent', label: 'Agent', icon: Bot, hint: 'Ask, chart and investigate' },
  { href: '/workspaces', label: 'Workspaces', icon: Boxes, hint: 'Portfolio of investigations' },
  { href: '/data', label: 'Explore data', icon: Database, hint: 'Certified metric catalog' },
  { href: '/publications', label: 'Publications', icon: BookOpen, hint: 'Published theses' },
  { href: '/notifications', label: 'Notifications', icon: Bell, hint: 'Approvals and findings' },
  { href: '/credits', label: 'Credits', icon: Coins, hint: 'NEAR testnet credits and top-ups' },
  { href: '/system', label: 'System health', icon: Gauge, hint: 'Source and service health' },
];

/** Workspace area. `:wid` is substituted at render time. */
export const WORKSPACE_NAV: NavGroup[] = [
  {
    id: 'main',
    label: '',
    defaultOpen: true,
    items: [
      { href: '/w/:wid/overview', label: 'Overview', icon: LayoutGrid },
      { href: '/w/:wid/investigate', label: 'Investigate', icon: Sparkles, hint: 'Ask and plan' },
      { href: '/w/:wid/canvas', label: 'Canvas', icon: Braces, hint: 'Panels and markers' },
    ],
  },
  {
    id: 'research',
    label: 'Research',
    defaultOpen: true,
    items: [
      { href: '/w/:wid/hypotheses', label: 'Hypotheses', icon: Lightbulb },
      { href: '/w/:wid/experiments', label: 'Experiments', icon: FlaskConical },
      { href: '/w/:wid/evidence', label: 'Evidence graph', icon: Network },
    ],
  },
  {
    id: 'automation',
    label: 'Automation',
    items: [
      { href: '/w/:wid/markers', label: 'Markers', icon: Tag },
      { href: '/w/:wid/monitors', label: 'Monitors', icon: Radio },
      { href: '/w/:wid/agents', label: 'Agents and runs', icon: Activity },
    ],
  },
  {
    id: 'history',
    label: 'History',
    items: [
      { href: '/w/:wid/timeline', label: 'Timeline', icon: Clock },
      { href: '/w/:wid/history', label: 'Time machine', icon: History },
      { href: '/w/:wid/branches', label: 'Branches', icon: GitBranch },
    ],
  },
  {
    id: 'publish',
    label: 'Publish',
    items: [
      { href: '/w/:wid/thesis', label: 'Thesis and reports', icon: FileText },
      { href: '/w/:wid/capsules', label: 'Capsules', icon: Package },
      { href: '/w/:wid/cost', label: 'Cost', icon: Coins, hint: 'Spend, caps and forecast' },
    ],
  },
];

/** Not in the sidebar but reachable, and needed by the palette and breadcrumbs. */
export const WORKSPACE_EXTRA: NavItem[] = [
  { href: '/w/:wid/approvals', label: 'Approvals', icon: ShieldCheck },
  { href: '/w/:wid/settings', label: 'Workspace settings', icon: Settings },
];

export const DATA_NAV: NavItem[] = [
  { href: '/data', label: 'Metric catalog', icon: Database },
  { href: '/data/sources', label: 'Sources', icon: Network },
  { href: '/data/quotes', label: 'Quote observatory', icon: Search },
  { href: '/data/intents', label: 'Intents analytics', icon: Search },
  { href: '/data/ecosystem', label: 'Ecosystem entities', icon: Network },
  { href: '/data/accounts', label: 'Accounts', icon: Network },
  { href: '/data/economics', label: 'Economics', icon: Database },
  { href: '/data/realtime', label: 'Real-time feed', icon: Radio },
];

export function withWorkspace(href: string, wid: string): string {
  return href.replace(':wid', wid);
}

/** Flat list of every navigable screen, for the command palette. */
export function allRoutes(wid: string | null): NavItem[] {
  const out = [...GLOBAL_NAV, ...DATA_NAV];
  if (wid) {
    for (const g of WORKSPACE_NAV) {
      for (const i of g.items) out.push({ ...i, href: withWorkspace(i.href, wid) });
    }
    for (const i of WORKSPACE_EXTRA) out.push({ ...i, href: withWorkspace(i.href, wid) });
  }
  // De-duplicate: /data appears in both the global list and the data list.
  const seen = new Set<string>();
  return out.filter((i) => (seen.has(i.href) ? false : (seen.add(i.href), true)));
}
