/**
 * Coordination CLI — the ONLY supported way for engines/subagents to write shared status.
 *   pnpm coord heartbeat --engine ENGINE_A --session <id> [--task "..."] [--phase P01]
 *   pnpm coord event --engine ENGINE_A --session <id> --kind task.completed --subject T-P01-KERNEL [--detail "..."]
 *   pnpm coord agent --file <agent-record.json>              (validates AgentRecord, writes coordination/agents/<agentId>.json)
 *   pnpm coord agent-heartbeat --id A2 [--status RUNNING] [--passed N] [--failed N] [--commit sha]
 *   pnpm coord task --id T-P01-KERNEL --status RUNNING        (locked read-modify-write of TASK_BOARD.json)
 *   pnpm coord test --file <test-result.json>                (validates TestResult, writes reports/TESTS/<id>/<runId>.json)
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  AgentRecord,
  CoordinationEvent,
  EngineStatus,
  TaskBoard,
  TaskStatus,
  TestResult,
} from "@nearesis/contracts";
import { COORD, REPORTS, appendEvent, gitHead, readJson, withLock, writeJsonAtomic } from "./coord-lib.ts";

const [cmd, ...rest] = process.argv.slice(2);
const { values: a } = parseArgs({
  args: rest,
  options: {
    engine: { type: "string" },
    session: { type: "string" },
    task: { type: "string" },
    phase: { type: "string" },
    kind: { type: "string" },
    subject: { type: "string" },
    detail: { type: "string" },
    file: { type: "string" },
    id: { type: "string" },
    status: { type: "string" },
    passed: { type: "string" },
    failed: { type: "string" },
    commit: { type: "string" },
  },
});
const now = () => new Date().toISOString();
const need = (k: keyof typeof a): string => {
  const v = a[k];
  if (typeof v !== "string" || !v) throw new Error(`--${k} required`);
  return v;
};

switch (cmd) {
  case "heartbeat": {
    const engine = need("engine");
    const p = join(COORD, `${engine}_STATUS.json`);
    withLock(p, () => {
      const cur = EngineStatus.parse(readJson(p));
      const next = EngineStatus.parse({
        ...cur,
        initialized: true,
        sessionId: need("session"),
        heartbeatAt: now(),
        lastCommit: gitHead(),
        currentTask: a.task ?? cur.currentTask,
        currentPhase: a.phase ?? cur.currentPhase,
      });
      writeJsonAtomic(p, next);
    });
    appendEvent(
      CoordinationEvent.parse({
        ts: now(),
        session: need("session"),
        engine,
        kind: "heartbeat",
        subject: engine,
      }),
    );
    break;
  }
  case "event":
    appendEvent(
      CoordinationEvent.parse({
        ts: now(),
        session: need("session"),
        engine: need("engine"),
        kind: need("kind"),
        subject: need("subject"),
        detail: a.detail,
      }),
    );
    break;
  case "agent": {
    const rec = AgentRecord.parse(readJson(need("file")));
    writeJsonAtomic(join(COORD, "agents", `${rec.agentId}.json`), rec);
    break;
  }
  case "agent-heartbeat": {
    const p = join(COORD, "agents", `${need("id")}.json`);
    withLock(p, () => {
      const cur = AgentRecord.parse(readJson(p));
      writeJsonAtomic(
        p,
        AgentRecord.parse({
          ...cur,
          heartbeatAt: now(),
          status: a.status ?? cur.status,
          testsPassed: a.passed ? Number(a.passed) : cur.testsPassed,
          testsFailed: a.failed ? Number(a.failed) : cur.testsFailed,
          commitSha: a.commit ?? cur.commitSha,
        }),
      );
    });
    break;
  }
  case "task": {
    const p = join(COORD, "TASK_BOARD.json");
    const status = TaskStatus.parse(need("status"));
    withLock(p, () => {
      const b = TaskBoard.parse(readJson(p));
      const t = b.tasks.find((x) => x.id === need("id"));
      if (!t) throw new Error(`unknown task ${a.id}`);
      t.status = status;
      writeJsonAtomic(p, TaskBoard.parse({ ...b, version: b.version + 1, updatedAt: now() }));
    });
    break;
  }
  case "test": {
    const r = TestResult.parse(readJson(need("file")));
    writeJsonAtomic(join(REPORTS, "TESTS", r.testId, `${r.runId}.json`), r);
    break;
  }
  default:
    console.error("usage: coord heartbeat|event|agent|agent-heartbeat|task|test ...");
    process.exit(2);
}
