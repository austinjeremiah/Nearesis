import { ApprovalService } from "./approvals.ts";
import { Db } from "./db/pool.ts";
import { DevAuthProvider, IdentityPolicy } from "./auth.ts";
import type { AuthProvider } from "./auth.ts";
import { CanvasService } from "./canvas.ts";
import type { SemanticValidator } from "./canvas.ts";
import { CommandBus } from "./commands.ts";
import { EvidenceGraphService } from "./graph.ts";
import { KernelToolGateway } from "./gateway.ts";
import { EventJournal } from "./journal.ts";
import { LeaseService } from "./leases.ts";
import { OutboxPublisher } from "./outbox.ts";
import { PluginManager } from "./plugins/manager.ts";
import type { PluginManagerConfig } from "./plugins/manager.ts";
import { EventStreamService } from "./stream.ts";
import type { StreamOptions } from "./stream.ts";
import { WorkspaceRegistry } from "./workspace.ts";

export interface KernelConfig {
  db: Db;
  plugins: PluginManagerConfig;
  authProvider?: AuthProvider;
  sessionSecret?: string;
  nodeEnv?: string;
  /** Engine B canvas-schema semantic validation hook (runs inside the command transaction). */
  semanticValidator?: SemanticValidator;
  stream?: StreamOptions;
}

export const DEFAULT_ENGINE_INTERFACES = ["kernel.tool_gateway@1", "kernel.journal@1", "kernel.leases@1"];

/** Composition root of the modular monolith. */
export class Kernel {
  readonly db: Db;
  readonly journal: EventJournal;
  readonly plugins: PluginManager;
  readonly leases: LeaseService;
  readonly gateway: KernelToolGateway;
  readonly workspaces: WorkspaceRegistry;
  readonly commands: CommandBus;
  readonly outbox: OutboxPublisher;
  readonly canvas: CanvasService;
  readonly stream: EventStreamService;
  readonly graph: EvidenceGraphService;
  readonly approvals: ApprovalService;
  readonly identity: IdentityPolicy;
  readonly devAuth: DevAuthProvider | undefined;
  readonly engine: { inspect: PluginManager["inspect"] };

  constructor(cfg: KernelConfig) {
    this.db = cfg.db;
    this.journal = new EventJournal();
    this.plugins = new PluginManager(cfg.db, cfg.plugins);
    this.leases = new LeaseService(cfg.db);
    this.approvals = new ApprovalService();
    this.gateway = new KernelToolGateway(cfg.db, this.plugins, this.leases, this.approvals);
    this.workspaces = new WorkspaceRegistry(cfg.db, this.journal);
    this.commands = new CommandBus(cfg.db, this.journal, this.plugins, this.approvals);
    this.outbox = new OutboxPublisher(cfg.db);
    this.stream = new EventStreamService(cfg.db, this.journal, cfg.stream);
    this.canvas = new CanvasService(cfg.db, cfg.semanticValidator);
    this.commands.register("canvas.apply_patch", this.canvas.handler);
    this.graph = new EvidenceGraphService(cfg.db);
    this.commands.register("graph.save_layout", this.graph.saveLayoutHandler);
    const nodeEnv = cfg.nodeEnv ?? process.env.NODE_ENV;
    this.devAuth = cfg.authProvider ? undefined : new DevAuthProvider(cfg.db, cfg.sessionSecret, nodeEnv);
    this.identity = new IdentityPolicy(cfg.db, cfg.authProvider ?? this.devAuth!);
    this.engine = { inspect: () => this.plugins.inspect() };
  }

  async boot(): Promise<void> {
    await this.plugins.boot();
  }

  async close(): Promise<void> {
    this.outbox.stop();
    await this.db.close();
  }
}
