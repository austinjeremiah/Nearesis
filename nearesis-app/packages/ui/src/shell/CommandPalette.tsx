import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { type ReactNode, useEffect } from "react";
import { Kbd } from "../primitives";

export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  icon?: ReactNode;
  hint?: string;
  shortcut?: string;
  keywords?: string[];
  run: () => void;
}

/** ⌘K / Ctrl+K opens, Escape closes. Returns nothing; the host owns `open`. */
export function useCommandPaletteShortcut(setOpen: (fn: (o: boolean) => boolean) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);
}

export function CommandPalette({
  open,
  onOpenChange,
  commands,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  commands: PaletteCommand[];
}) {
  const groups = Array.from(new Set(commands.map((c) => c.group)));
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="nz-overlay" />
        <Dialog.Content className="nz-palette" aria-describedby={undefined}>
          <Dialog.Title className="nz-sr-only">Command palette</Dialog.Title>
          <Command label="Command palette" loop>
            <Command.Input placeholder="Search panels, runs, sources or type a command" autoFocus />
            <Command.List>
              <Command.Empty>No results. Try a panel name, a run, or &quot;ask&quot;.</Command.Empty>
              {groups.map((g) => (
                <Command.Group key={g} heading={g}>
                  {commands
                    .filter((c) => c.group === g)
                    .map((c) => (
                      <Command.Item
                        key={c.id}
                        value={`${c.label} ${c.keywords?.join(" ") ?? ""}`}
                        onSelect={() => {
                          onOpenChange(false);
                          c.run();
                        }}
                      >
                        {c.icon}
                        <span className="nz-grow">{c.label}</span>
                        {c.hint ? (
                          <span style={{ color: "var(--fg-subtle)", fontSize: "var(--text-xs)" }}>
                            {c.hint}
                          </span>
                        ) : null}
                        {c.shortcut ? <Kbd>{c.shortcut}</Kbd> : null}
                      </Command.Item>
                    ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
          <div className="nz-palette-foot" aria-hidden="true">
            <span>
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
            </span>
            <span>
              <Kbd>↵</Kbd> select
            </span>
            <span>
              <Kbd>esc</Kbd> close
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
