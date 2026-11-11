import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ANONYMOUS, createPublicMcpServer } from "./server.ts";
import type { Principal } from "./server.ts";
import { parseStrictJson } from "@nearesis/strict-json";

const MAX_BODY = 1_000_000;

/**
 * Stateless streamable-HTTP endpoint (POST /mcp). One server and transport per request. The principal comes from
 * `resolvePrincipal`; the default resolver returns anonymous for everyone, so a stock deployment can never serve
 * restricted tools. Binds 127.0.0.1 by default and rejects foreign Host headers (DNS rebinding).
 */
export interface HttpOptions {
  port?: number;
  host?: string;
  capsuleRoot?: string;
  resolvePrincipal?: (req: IncomingMessage) => Principal;
  allowedHosts?: string[];
}

export async function startPublicMcpHttp(
  o: HttpOptions = {},
): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const host = o.host ?? "127.0.0.1";
  const resolve = o.resolvePrincipal ?? (() => ANONYMOUS);
  const http = createServer((req, res) => {
    void (async () => {
      const hostHeader = (req.headers.host ?? "").replace(/:\d+$/, "");
      const allowed = o.allowedHosts ?? ["127.0.0.1", "localhost", "[::1]"];
      if (!allowed.includes(hostHeader)) {
        res
          .writeHead(403, { "content-type": "application/json" })
          .end(JSON.stringify({ errorCode: "FORBIDDEN", reasonCode: "HOST_NOT_ALLOWED" }));
        return;
      }
      if (req.url?.split("?")[0] !== "/mcp" || req.method !== "POST") {
        res.writeHead(req.url?.split("?")[0] === "/mcp" ? 405 : 404, { allow: "POST" }).end();
        return;
      }
      if (String(req.headers["content-encoding"] ?? "identity").toLowerCase() !== "identity") {
        res.writeHead(400).end();
        return;
      }
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > MAX_BODY) {
        res.writeHead(413).end();
        req.resume(); // drain without buffering so the client sees the 413 rather than a reset
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_BODY) {
          res.writeHead(413).end();
          req.resume();
          return;
        }
        chunks.push(c as Buffer);
      }
      const parsed = parseStrictJson(Buffer.concat(chunks), { maxBytes: MAX_BODY });
      if (!parsed.ok) {
        res.writeHead(parsed.code === "TOO_LARGE" ? 413 : 400).end();
        return;
      }
      const body: unknown = parsed.value;
      const mcp = createPublicMcpServer({
        principal: resolve(req),
        ...(o.capsuleRoot ? { capsuleRoot: o.capsuleRoot } : {}),
      });
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((r) => http.listen(o.port ?? 0, host, r));
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server: http, port, close: () => new Promise<void>((r) => http.close(() => r())) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startPublicMcpHttp({ port: Number(process.env.NEARESIS_MCP_PUBLIC_PORT ?? 4750) });
  console.log(JSON.stringify({ msg: "nearesis public MCP (read-only) listening", host: "127.0.0.1", port }));
}
