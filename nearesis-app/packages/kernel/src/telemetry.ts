import type { DomainEvent } from "@nearesis/contracts";
import { TelemetryExporter, publicValue, type TelemetryAttr } from "./classification.ts";
import type { OutboxPublisher } from "./outbox.ts";

/**
 * Production telemetry (SEC21, ch.12): domain events leave the workspace as OTLP/HTTP spans through the outbox's BROAD
 * consumer path. The broad path hands the consumer `fanoutEvent(event)`, so only identifiers, change types and enum values
 * ever reach this code; the exporter then withholds every string that is not explicitly cleared and not content-named.
 * Nothing is exported unless an OTLP endpoint is configured.
 */
export function otlpTracesEndpoint(
  env: (n: string) => string | undefined = (n) => process.env[n],
): string | null {
  const explicit = env("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")?.trim();
  const base = env("OTEL_EXPORTER_OTLP_ENDPOINT")?.trim();
  const raw = explicit || (base ? `${base.replace(/\/+$/, "")}/v1/traces` : "");
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export const TELEMETRY_CONSUMER = "telemetry";

/** The attributes of one fan-out event span. Everything structural is cleared; free text cannot be in the event. */
export function eventSpanAttrs(e: DomainEvent): Record<string, TelemetryAttr> {
  const attrs: Record<string, TelemetryAttr> = {
    "event.type": publicValue(e.type),
    "event.seq": e.seq,
    "event.schema_version": e.schemaVersion,
    ...(e.workspaceId ? { "event.workspace_id": publicValue(e.workspaceId) } : {}),
  };
  for (const [k, v] of Object.entries(e.data ?? {})) {
    if (typeof v === "number" || typeof v === "boolean") attrs[`event.data.${k}`] = v;
    else if (typeof v === "string") attrs[`event.data.${k}`] = publicValue(v);
  }
  return attrs;
}

export class TelemetryPipeline {
  private timer: NodeJS.Timeout | undefined;
  readonly errors: string[] = [];
  constructor(
    readonly exporter: TelemetryExporter,
    private readonly log: (line: Record<string, unknown>) => void = (l) =>
      process.stderr.write(JSON.stringify(l) + "\n"),
  ) {}

  /** Null when no OTLP endpoint is configured: telemetry is then off and no consumer is registered. */
  static fromEnv(
    env: (n: string) => string | undefined = (n) => process.env[n],
    fetchImpl?: ConstructorParameters<typeof TelemetryExporter>[2],
  ): TelemetryPipeline | null {
    const endpoint = otlpTracesEndpoint(env);
    return endpoint
      ? new TelemetryPipeline(
          new TelemetryExporter(endpoint, env("OTEL_SERVICE_NAME") || "nearesis", fetchImpl),
        )
      : null;
  }

  /** Registers the broad outbox consumer: it receives only `fanoutEvent(event)`. */
  attach(outbox: OutboxPublisher): void {
    outbox.register(
      TELEMETRY_CONSUMER,
      async ({ event }) => {
        this.exporter.span("nearesis.event", eventSpanAttrs(event));
      },
      { broad: true },
    );
  }

  async flush(): Promise<number> {
    try {
      return await this.exporter.flush();
    } catch (e) {
      // a down collector never affects the workspace; the error text carries no span content
      this.log({ msg: "telemetry.flush_failed", reason: (e as Error).message.slice(0, 120) });
      this.errors.push((e as Error).message.slice(0, 120));
      return 0;
    }
  }

  start(intervalMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }
}
