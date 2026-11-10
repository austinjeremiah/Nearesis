import type { FastifyInstance } from "fastify";
import { createTestDb, seedOrg, testKernel } from "@nearesis/kernel/testing";
import type { TestDb } from "@nearesis/kernel/testing";
import type { Kernel } from "@nearesis/kernel";
import { buildApp } from "../src/app.ts";

export interface ApiFixture {
  db: TestDb;
  kernel: Kernel;
  app: FastifyInstance;
  close(): Promise<void>;
}
export async function apiFixture(): Promise<ApiFixture> {
  const db = await createTestDb();
  const kernel = testKernel(db);
  const app = await buildApp({ kernel, nodeEnv: "test" });
  return {
    db,
    kernel,
    app,
    async close() {
      await app.close();
      await db.drop();
    },
  };
}

export { seedOrg };

export async function login(app: FastifyInstance, subject: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/v1/dev/login", payload: { oidcSubject: subject } });
  if (r.statusCode !== 200) throw new Error(`login failed: ${r.statusCode}`);
  return (r.json() as { token: string }).token;
}

export const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/** Strip the per-request traceId so response bodies can be compared for existence leaks. */
export function sansTrace(body: unknown): unknown {
  const { traceId: _t, ...rest } = body as Record<string, unknown>;
  return rest;
}
