import type { CommandBus } from "./commands.ts";

/** Seam for history commands (branches, snapshots). Filled additively by its owner. */
export function registerHistoryCommands(_bus: CommandBus): void {
  // intentionally empty
}
