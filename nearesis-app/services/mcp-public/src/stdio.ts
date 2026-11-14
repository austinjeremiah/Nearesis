import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ANONYMOUS, createPublicMcpServer } from "./server.ts";

// stdio is a local, single-user transport but still serves the public tool set only (anonymous principal).
await createPublicMcpServer({ principal: ANONYMOUS }).connect(new StdioServerTransport());
