'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Dialog as RxDialog, DropdownMenu, Tooltip as RxTooltip } from 'radix-ui';
import { X } from 'lucide-react';
import { Button, IconButton } from './ui';

/**
 * Overlays built on Radix primitives.
 *
 * Radix is used for behaviour only: focus trapping, escape handling, typeahead,
 * collision-aware positioning and the ARIA wiring. Every visual is our own CSS,
 * so these match the marketing site rather than looking like a component kit.
 */

/**
 * Radix portals render into <body>, outside the `.nx` wrapper that carries the theme, fonts and the scoped component
 * styles, so overlays lost their styling. Portal into the wrapper instead; null (render in body) until it is found.
 */
function usePortalContainer(): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setEl(document.querySelector<HTMLElement>('.nx'));
  }, []);
  return el;
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RxTooltip.Provider delayDuration={300}>{children}</RxTooltip.Provider>;
}

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <RxTooltip.Root>
      <RxTooltip.Trigger asChild>{children}</RxTooltip.Trigger>
      <RxTooltip.Portal container={usePortalContainer()}>
        <RxTooltip.Content className="tooltip" sideOffset={6} collisionPadding={8}>
          {label}
        </RxTooltip.Content>
      </RxTooltip.Portal>
    </RxTooltip.Root>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  wide,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  wide?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <RxDialog.Root open={open} onOpenChange={onOpenChange}>
      <RxDialog.Portal container={usePortalContainer()}>
        <RxDialog.Overlay className="scrim" />
        <RxDialog.Content className={`dialog ${wide ? 'wide' : ''}`.trim()}>
          <div className="dialog-head row between">
            <div className="grow">
              <RxDialog.Title className="h3">{title}</RxDialog.Title>
              {description && (
                <RxDialog.Description className="small dim">{description}</RxDialog.Description>
              )}
            </div>
            <RxDialog.Close asChild>
              <IconButton label="Close">
                <X size={15} />
              </IconButton>
            </RxDialog.Close>
          </div>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-foot">{footer}</div>}
        </RxDialog.Content>
      </RxDialog.Portal>
    </RxDialog.Root>
  );
}

/**
 * Spec 3.4: a destructive action needs an explicit confirmation and must not sit
 * next to a primary run button. `confirmWord` forces the user to type the object
 * name for the irreversible cases, such as archiving a workspace.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  onConfirm,
  danger,
  pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  danger?: boolean;
  pending?: boolean;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            pending={pending}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="small muted">{body}</p>
    </Modal>
  );
}

export function Drawer({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <RxDialog.Root open={open} onOpenChange={onOpenChange}>
      <RxDialog.Portal container={usePortalContainer()}>
        <RxDialog.Overlay className="scrim" />
        <RxDialog.Content className="drawer">
          <div className="dialog-head row between">
            <RxDialog.Title className="h3 grow">{title}</RxDialog.Title>
            <RxDialog.Close asChild>
              <IconButton label="Close">
                <X size={15} />
              </IconButton>
            </RxDialog.Close>
          </div>
          <div className="dialog-body">{children}</div>
        </RxDialog.Content>
      </RxDialog.Portal>
    </RxDialog.Root>
  );
}

export type MenuItem =
  | { kind: 'separator' }
  | {
      kind?: 'item';
      label: string;
      onSelect?: () => void;
      href?: string;
      icon?: ReactNode;
      danger?: boolean;
      /** A disabled item states why. Spec 3.4 forbids an unexplained dead item. */
      disabledReason?: string;
    };

export function Menu({
  trigger,
  items,
  align = 'end',
}: {
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'start' | 'end';
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal container={usePortalContainer()}>
        <DropdownMenu.Content className="popover" align={align} sideOffset={4} collisionPadding={8}>
          {items.map((it, i) =>
            it.kind === 'separator' ? (
              <DropdownMenu.Separator key={i} className="menu-sep" />
            ) : (
              <DropdownMenu.Item
                key={it.label}
                className={`menu-item ${it.danger ? 'danger' : ''}`.trim()}
                disabled={Boolean(it.disabledReason)}
                title={it.disabledReason}
                onSelect={() => {
                  if (it.disabledReason) return;
                  if (it.href) window.location.assign(it.href);
                  it.onSelect?.();
                }}
              >
                {it.icon}
                <span className="grow">{it.label}</span>
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
