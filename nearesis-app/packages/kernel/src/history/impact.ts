import type { Session } from "../auth.ts";
import type { Db, Tx } from "../db/pool.ts";
import { noWorkspaceAccess } from "../workspace.ts";

export interface DepEdge {
  from_node: string;
  to_node: string;
  relation: string;
}

/**
 * Dependency direction (ch.10 "Evidence graph semantics"): `A derived_from B`, `A reproduces B` and `A references B`
 * make A depend on B; `B supports A` makes A depend on B. `contradicts`, `monitors` and `supersedes` are not
 * dependencies: a contradicted claim is not invalidated by a change to what contradicts it.
 */
export function dependentIndex(edges: DepEdge[]): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  const add = (dependency: string, dependent: string) => {
    const l = idx.get(dependency);
    if (l) l.push(dependent);
    else idx.set(dependency, [dependent]);
  };
  for (const e of edges) {
    if (e.relation === "derived_from" || e.relation === "reproduces" || e.relation === "references")
      add(e.to_node, e.from_node);
    else if (e.relation === "supports") add(e.from_node, e.to_node);
  }
  return idx;
}

export interface Traversal {
  /** Affected node ids in breadth-first order with their distance from the nearest root (roots are depth 0). */
  affected: Array<{ nodeId: string; depth: number }>;
  /** True when `maxDepth` stopped the walk with nodes still unvisited. */
  truncated: boolean;
  /** Dependency cycles inside the visited set (strongly connected components of more than one node). */
  cycles: string[][];
}

/**
 * Iterative (no recursion, so a 5,000-node chain cannot exhaust the stack), cycle-safe breadth-first traversal that
 * visits each node exactly once. `blocked` nodes are never entered or reported (ACL cut).
 */
export function traverseDependents(
  roots: string[],
  idx: Map<string, string[]>,
  opts: { maxDepth?: number; blocked?: (id: string) => boolean } = {},
): Traversal {
  const depth = new Map<string, number>();
  const order: string[] = [];
  const queue: string[] = [];
  for (const r of roots) {
    if (opts.blocked?.(r) || depth.has(r)) continue;
    depth.set(r, 0);
    order.push(r);
    queue.push(r);
  }
  let truncated = false;
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    const d = depth.get(id)!;
    for (const dep of idx.get(id) ?? []) {
      if (depth.has(dep) || opts.blocked?.(dep)) continue;
      if (opts.maxDepth !== undefined && d + 1 > opts.maxDepth) {
        truncated = true;
        continue;
      }
      depth.set(dep, d + 1);
      order.push(dep);
      queue.push(dep);
    }
  }
  return {
    affected: order.map((nodeId) => ({ nodeId, depth: depth.get(nodeId)! })),
    truncated,
    cycles: sccs(order, idx, depth),
  };
}

/** Iterative Tarjan over the visited subgraph. Only components with more than one node are cycles (self edges are refused at write time). */
function sccs(nodes: string[], idx: Map<string, string[]>, inSet: Map<string, number>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: Array<{ v: string; i: number }> = [{ v: start, i: 0 }];
    index.set(start, counter);
    low.set(start, counter++);
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const top = work[work.length - 1]!;
      const succ = (idx.get(top.v) ?? []).filter((x) => inSet.has(x));
      if (top.i < succ.length) {
        const w = succ[top.i++]!;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter++);
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1]!;
          low.set(parent.v, Math.min(low.get(parent.v)!, low.get(top.v)!));
        }
        if (low.get(top.v) === index.get(top.v)) {
          const comp: string[] = [];
          let x: string;
          do {
            x = stack.pop()!;
            onStack.delete(x);
            comp.push(x);
          } while (x !== top.v);
          if (comp.length > 1) out.push(comp.sort());
        }
      }
    }
  }
  return out.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

export const DEFAULT_REVALIDATION_CAP = 100;

export interface ImpactReport {
  metricId: string;
  currentVersion: string | null;
  roots: string[];
  affected: Array<{ nodeId: string; depth: number }>;
  cycles: string[][];
  truncated: boolean;
}

/** Read-only impact analysis with node-level ACL. Hidden nodes are cut from the walk and never counted or named. */
export class ImpactOps {
  constructor(private readonly db: Db) {}

  /** Node ids the caller may not see: restricted nodes without a grant for this user. */
  static async hiddenFor(tx: Tx, workspaceId: string, userId: string): Promise<Set<string>> {
    const r = await tx.query<{ id: string }>(
      `SELECT n.id FROM evidence_nodes n
        WHERE n.workspace_id = $1 AND n.restricted
          AND NOT EXISTS (SELECT 1 FROM evidence_node_grants g WHERE g.node_id = n.id AND g.user_id = $2)`,
      [workspaceId, userId],
    );
    return new Set(r.rows.map((x) => x.id));
  }

  private async compute(
    tx: Tx,
    workspaceId: string,
    userId: string,
    metricId: string,
    maxDepth?: number,
  ): Promise<ImpactReport> {
    const cur =
      (
        await tx.query<{ version: string }>(
          "SELECT version FROM semantic_versions WHERE workspace_id = $1 AND metric_id = $2 ORDER BY seq DESC LIMIT 1",
          [workspaceId, metricId],
        )
      ).rows[0]?.version ?? null;
    const hidden = await ImpactOps.hiddenFor(tx, workspaceId, userId);
    const nodes = (
      await tx.query<{ id: string; v: string | null; tombstone: boolean }>(
        "SELECT id, semantic_pins ->> $2 AS v, tombstone FROM evidence_nodes WHERE workspace_id = $1",
        [workspaceId, metricId],
      )
    ).rows;
    const live = new Set(nodes.filter((n) => !n.tombstone).map((n) => n.id));
    const roots = nodes.filter((n) => !n.tombstone && n.v !== null && n.v !== cur).map((n) => n.id);
    const edges = (
      await tx.query<DepEdge>(
        "SELECT from_node, to_node, relation FROM evidence_edges WHERE workspace_id = $1 AND removed_at IS NULL",
        [workspaceId],
      )
    ).rows;
    const t = traverseDependents(roots, dependentIndex(edges), { maxDepth, blocked: (id) => hidden.has(id) });
    return {
      metricId,
      currentVersion: cur,
      roots: roots.filter((r) => !hidden.has(r)),
      affected: t.affected.filter((a) => live.has(a.nodeId)),
      cycles: t.cycles.filter((c) => c.every((id) => !hidden.has(id))),
      truncated: t.truncated,
    };
  }

  async impact(
    session: Session,
    workspaceId: string,
    q: { metricId: string; maxDepth?: number },
  ): Promise<ImpactReport> {
    return this.db.tx(this.ctx(session), async (tx) => {
      await this.assertWorkspace(tx, workspaceId);
      return this.compute(tx, workspaceId, session.userId, q.metricId, q.maxDepth);
    });
  }

  private ctx(session: Session) {
    return { orgId: session.principal.orgId, userId: session.userId, actorKind: session.principal.kind };
  }

  private async assertWorkspace(tx: Tx, workspaceId: string) {
    const ws = (await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId])).rows[0];
    if (!ws) throw noWorkspaceAccess();
  }

  /** Revalidation backlog as the caller sees it: only tasks for nodes inside the caller's visible impact set. */
  async revalidationStatus(session: Session, workspaceId: string) {
    return this.db.tx(this.ctx(session), async (tx) => {
      await this.assertWorkspace(tx, workspaceId);
      const rows = (
        await tx.query<{ node_id: string; metric_id: string; status: string }>(
          "SELECT node_id, metric_id, status FROM revalidation_tasks WHERE workspace_id = $1",
          [workspaceId],
        )
      ).rows;
      const visible = new Map<string, Set<string>>();
      for (const metricId of new Set(rows.map((r) => r.metric_id)))
        visible.set(
          metricId,
          new Set(
            (await this.compute(tx, workspaceId, session.userId, metricId)).affected.map((a) => a.nodeId),
          ),
        );
      const mine = rows.filter((r) => visible.get(r.metric_id)!.has(r.node_id));
      const count = (st: string) => mine.filter((r) => r.status === st).length;
      return { created: count("created"), queued: count("queued"), done: count("done") };
    });
  }
}
