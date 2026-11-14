import { hashCanonical } from "@nearesis/canvas-schema";
import { parseSource, semantic, sessionFor, watermarks } from "../../../../../lib/server/semantic.ts";
import {
  THESIS_SERIES,
  ThesisWindow,
  type ThesisData,
  type ThesisSeries,
} from "../../../../../components/thesis/model.ts";

export const runtime = "nodejs";
const DAY = 86_400_000;
const MAX_DAYS = 400;

/**
 * Thesis series: the client chooses only a date window and the data source; each AST is built here from the
 * certified whitelist and executed by the guarded semantic gateway with the server-bound session.
 */
export async function GET(req: Request, ctx: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await ctx.params;
  const session = await sessionFor(workspaceId);
  if (!session) return Response.json({ errorCode: "NOT_FOUND" }, { status: 404 });
  const q = new URL(req.url).searchParams;
  const win = ThesisWindow.safeParse({ from: q.get("from"), to: q.get("to") });
  if (!win.success)
    return Response.json(
      { errorCode: "VALIDATION_FAILED", message: "from/to must be YYYY-MM-DD" },
      { status: 422 },
    );
  const fromMs = Date.parse(`${win.data.from}T00:00:00Z`);
  const toMs = Date.parse(`${win.data.to}T00:00:00Z`) + DAY; // inclusive end day
  const days = Math.round((toMs - fromMs) / DAY);
  if (days < 1 || days > MAX_DAYS)
    return Response.json(
      { errorCode: "VALIDATION_FAILED", message: `window must be 1..${MAX_DAYS} days` },
      { status: 422 },
    );
  const source = parseSource(q.get("source"));
  const sem = semantic(source);

  const series: ThesisSeries[] = await Promise.all(
    THESIS_SERIES.map(async (d): Promise<ThesisSeries> => {
      const def =
        source === "live"
          ? {
              ...d,
              member: d.live.member,
              timeField: d.live.timeField,
              definition: d.live.definition ?? d.definition,
              limitation: d.live.limitation ?? d.limitation,
            }
          : d;
      const ast = {
        semanticVersion: sem.registry.semanticVersion,
        measures: [def.member],
        dimensions: [],
        time: {
          field: def.timeField,
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
          grain: "day" as const,
        },
        filters: [],
        order: [],
        limit: 10000,
      };
      const metric = sem.registry.metrics.find((m) => m.id === def.member);
      const base = {
        key: def.key,
        label: def.label,
        member: def.member,
        unit: metric?.unit ?? null,
        definition: def.definition,
        limitation: def.limitation,
      };
      const r = await sem.gateway.query(session, ast);
      if (!r.ok)
        return {
          ...base,
          rows: [],
          coverage: { expectedDays: days, observedDays: 0, missingDays: days, partialDays: 0 },
          gaps: [],
          provenance: {
            queryHash: "",
            semanticVersion: ast.semanticVersion,
            semanticModelHash: "",
            sourceSnapshotId: null,
            certification: "unavailable",
            sources: [],
            watermark: null,
            ast,
            resultHash: "",
          },
          error: {
            status: r.status,
            code: r.error.reasonCode ?? r.error.errorCode,
            message: r.error.message,
          },
        };
      const env = r.envelope;
      const ti = env.columns.findIndex((c) => c.type === "time");
      const named = env.columns.findIndex((c) => c.name === def.member || c.name === metric?.cubeMember);
      const vi = named >= 0 ? named : env.columns.findIndex((c) => c.type !== "time");
      // Values keep their source precision; strings (exact decimals) are converted only for plotting.
      const rows: Array<[string, number | null]> = env.rows.map((row) => {
        const t = row[ti];
        const v = row[vi];
        const n = v === null || v === undefined ? null : Number(v);
        return [new Date(String(t)).toISOString().slice(0, 10), n !== null && Number.isFinite(n) ? n : null];
      });
      const observed = rows.filter((x) => x[1] !== null).length;
      const partial = (env.rowCoverage ?? []).filter((c) => c === "partial").length;
      const wm =
        Object.values(env.sourceWatermarks)
          .filter((x): x is string => !!x)
          .sort()
          .at(-1) ?? null;
      return {
        ...base,
        rows,
        coverage: {
          expectedDays: days,
          observedDays: observed,
          missingDays: days - observed,
          partialDays: partial,
        },
        gaps: env.gaps,
        provenance: {
          queryHash: env.queryHash,
          semanticVersion: env.semanticVersion,
          semanticModelHash: env.semanticModelHash,
          sourceSnapshotId: env.sourceSnapshotId,
          certification: env.certification,
          sources: [...new Set((metric?.sources ?? []).map((x) => x.split(":")[0]!))],
          watermark: wm,
          ast,
          resultHash: hashCanonical({ columns: env.columns, rows: env.rows }),
        },
        error: null,
      };
    }),
  );
  const body: ThesisData = {
    window: { from: win.data.from, to: win.data.to },
    // Fixture cubes hold SYNTHETIC fixture data; the live layer is real data.
    sourceLabel: source === "live" ? "LIVE" : "SYNTHETIC",
    dataSource: source,
    series,
    watermarks: await watermarks(source).catch(() => ({})),
    generatedAt: new Date().toISOString(),
  };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
