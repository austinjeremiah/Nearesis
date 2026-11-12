import type { CommandBus } from "./commands.ts";
import type { Kernel } from "./kernel.ts";
import { HistoryService } from "./history/service.ts";

export * from "./history/service.ts";
export { idFor } from "./history/runner.ts";
export type { CollabConnection, CollabFrame, CollabService } from "./history/collab.ts";

/**
 * Seam kept for the command bus. History commands (`snapshot.create`, `branch.*`, `merge.*`, `graph.add_*`) run through
 * `HistoryRunner`, which applies the same transaction discipline as the bus but is not limited by the contract command
 * envelope enum (owned by the monitoring contracts; see INTEGRATION_QUEUE). Nothing to register on the bus.
 */
export function registerHistoryCommands(_bus: CommandBus): void {
  // intentionally empty: see HistoryService
}

const services = new WeakMap<Kernel, HistoryService>();

/** One HistoryService per kernel instance. */
export function historyService(kernel: Kernel): HistoryService {
  let s = services.get(kernel);
  if (!s) {
    s = new HistoryService({
      db: kernel.db,
      journal: kernel.journal,
      canvas: kernel.canvas,
      graph: kernel.graph,
      commands: kernel.commands,
    });
    services.set(kernel, s);
  }
  return s;
}
