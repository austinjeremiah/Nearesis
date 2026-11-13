'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, Menu as MenuIcon, PanelLeftClose, Search, Sparkles } from 'lucide-react';
import Wordmark from '@/components/Wordmark';
import {
  GLOBAL_NAV,
  WORKSPACE_NAV,
  WORKSPACE_EXTRA,
  withWorkspace,
  type NavItem,
} from '@/lib/nav';
import { IconButton } from './ui';

/**
 * Application shell: sidebar, topbar, page header, inspector and run strip.
 * Geometry comes from Frontend Product Spec v1 section 2.3; the look is the
 * marketing site's.
 */

function usePersistentSet(key: string, initial: string[]) {
  const [value, setValue] = useState<Set<string>>(() => new Set(initial));
  // Read after mount so the server and client render the same first paint.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) setValue(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* private mode or blocked storage: the default set is fine */
    }
  }, [key]);
  const toggle = (id: string) => {
    setValue((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        /* non-fatal: group state is a convenience, not durable state */
      }
      return next;
    });
  };
  return [value, toggle] as const;
}

function NavLink({ item, wid }: { item: NavItem; wid: string | null }) {
  const pathname = usePathname();
  const href = wid ? withWorkspace(item.href, wid) : item.href;
  const active = pathname === href || pathname.startsWith(`${href}/`);
  const Icon = item.icon;
  return (
    <Link href={href} className="nav-item" aria-current={active ? 'page' : undefined}>
      <Icon className="ico" size={15} strokeWidth={1.75} />
      <span className="nav-label grow">{item.label}</span>
    </Link>
  );
}

export function AppShell({
  workspaceId = null,
  workspaceName,
  children,
  onOpenPalette,
  aside,
  asideOpen = false,
  onToggleAside,
}: {
  workspaceId?: string | null;
  workspaceName?: string;
  children: ReactNode;
  onOpenPalette?: () => void;
  /** The agent panel. Docked beside the content, not floated over it. */
  aside?: ReactNode;
  asideOpen?: boolean;
  onToggleAside?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [open, toggleGroup] = usePersistentSet(
    'nx.nav.groups',
    WORKSPACE_NAV.filter((g) => g.defaultOpen).map((g) => g.id),
  );

  const navState = mobileOpen ? 'open' : collapsed ? 'collapsed' : 'expanded';

  return (
    <div className="shell" data-nav={navState} data-ask={asideOpen ? 'open' : 'closed'}>
      <nav className="nav" aria-label="Primary">
        <div className="nav-top">
          {/* The collapse control belongs with the mark it collapses, not at the
              far bottom of the rail where it reads as a stray button. */}
          <div className="nav-brand">
            <Link href="/home" aria-label="Nearesis home">
              <Wordmark tone="black" size={24} />
            </Link>
            <button
              type="button"
              className="nav-collapse"
              onClick={() => setCollapsed((c) => !c)}
              aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
              title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            >
              <PanelLeftClose size={15} strokeWidth={1.75} />
            </button>
          </div>
          {workspaceName && (
            <div className="nav-label col gap1">
              <span className="label">Workspace</span>
              <span className="small strong" title={workspaceName}>
                {workspaceName}
              </span>
            </div>
          )}
        </div>

        <div className="nav-scroll">
          {/*
            Spec 2.2 warns against twenty permanently visible nav items. With a
            workspace open the portfolio list is not what the person is working
            on, so it collapses behind its heading and the workspace block takes
            the weight. Without a workspace it stays open, because then it is
            the only menu there is.
          */}
          <div className="nav-section">
            {workspaceId ? (
              <button
                type="button"
                className="nav-group-head"
                aria-expanded={open.has('portfolio')}
                onClick={() => toggleGroup('portfolio')}
              >
                Portfolio
                <ChevronDown className="chev" size={13} />
              </button>
            ) : (
              <span className="nav-group-head" aria-hidden="true">
                Portfolio
              </span>
            )}
            {(!workspaceId || open.has('portfolio')) &&
              GLOBAL_NAV.map((i) => <NavLink key={i.href} item={i} wid={null} />)}
          </div>

          {workspaceId && (
            <div className="nav-section workspace">
              {WORKSPACE_NAV.map((g) =>
                g.label === '' ? (
                  <div key={g.id}>
                    {g.items.map((i) => (
                      <NavLink key={i.href} item={i} wid={workspaceId} />
                    ))}
                  </div>
                ) : (
                  <div key={g.id}>
                    <button
                      type="button"
                      className="nav-group-head"
                      aria-expanded={open.has(g.id)}
                      onClick={() => toggleGroup(g.id)}
                    >
                      {g.label}
                      <ChevronDown className="chev" size={13} />
                    </button>
                    {open.has(g.id) &&
                      g.items.map((i) => <NavLink key={i.href} item={i} wid={workspaceId} />)}
                  </div>
                ),
              )}
            </div>
          )}
        </div>

        <div className="nav-foot">
          {workspaceId &&
            WORKSPACE_EXTRA.map((i) => <NavLink key={i.href} item={i} wid={workspaceId} />)}
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <IconButton
            label="Open navigation"
            onClick={() => setMobileOpen((v) => !v)}
            className="btn icon ghost nav-toggle"
          >
            <MenuIcon size={16} />
          </IconButton>
          <div className="grow" />
          <button type="button" className="btn ghost" onClick={onOpenPalette}>
            <Search size={14} />
            Search
            <kbd className="mono tiny dim" style={{ marginLeft: 6 }}>
              ⌘K
            </kbd>
          </button>
          {onToggleAside && (
            <button
              type="button"
              className="btn ghost"
              onClick={onToggleAside}
              aria-pressed={asideOpen}
              title="Agent panel"
            >
              <Sparkles size={14} />
              Ask
              <kbd className="mono tiny dim" style={{ marginLeft: 6 }}>
                ⌘J
              </kbd>
            </button>
          )}
        </header>
        {children}
      </div>
      {asideOpen && aside}
    </div>
  );
}

/** Breadcrumb trail. Separated so a hero header can carry one too. */
export function Crumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb" style={{ padding: '10px 20px 0' }}>
      {items.map((c, i) => (
        <span key={`${c.label}-${i}`} className="row gap2">
          {i > 0 && <span className="sep">/</span>}
          {c.href ? <Link href={c.href}>{c.label}</Link> : <span className="here">{c.label}</span>}
        </span>
      ))}
    </nav>
  );
}

/**
 * Page header. Spec 2.3 allows a title, a one-line description and one or two
 * primary actions. Context marks such as the snapshot or data mode sit between
 * the title and the actions so they read as part of the page, not decoration.
 */
export function PageHeader({
  title,
  description,
  context,
  actions,
  crumbs,
}: {
  title: string;
  description?: string;
  context?: ReactNode;
  actions?: ReactNode;
  crumbs?: { label: string; href?: string }[];
}) {
  return (
    <>
      {crumbs && crumbs.length > 0 && <Crumbs items={crumbs} />}
      <header className="pagehead">
        <div className="titles grow">
          <h1 className="h2">{title}</h1>
          {description && <p className="small dim">{description}</p>}
        </div>
        {context && <div className="row gap2">{context}</div>}
        {actions && <div className="actions">{actions}</div>}
      </header>
    </>
  );
}

export function Content({ children, flush }: { children: ReactNode; flush?: boolean }) {
  return <div className={`content ${flush ? 'flush' : ''}`.trim()}>{children}</div>;
}

/** Right inspector. Not a second chat sidebar: it describes the selection. */
export function Inspector({
  title,
  children,
  open = true,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  if (!open) return null;
  return (
    <aside className="inspector" aria-label={title}>
      <div className="inspector-head">
        <span className="label">{title}</span>
      </div>
      <div className="inspector-body">{children}</div>
    </aside>
  );
}

/**
 * Bottom run strip. Spec 2.3: appears only while something is actively running
 * and must never cover a chart tooltip, which is why it is a sticky row in the
 * flow rather than a floating element.
 */
export function RunStrip({
  label,
  detail,
  href,
}: {
  label: string;
  detail?: string;
  href: string;
}) {
  return (
    <div className="runstrip" role="status">
      <span className="badge accent">Running</span>
      <span className="small strong">{label}</span>
      {detail && <span className="small" style={{ opacity: 0.7 }}>{detail}</span>}
      <div className="grow" />
      <Link href={href} className="small" style={{ textDecoration: 'underline' }}>
        View run
      </Link>
    </div>
  );
}
