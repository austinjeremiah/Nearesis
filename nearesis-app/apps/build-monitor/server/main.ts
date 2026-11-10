import { defaultPaths } from "./paths.ts";
import { startMonitor } from "./server.ts";

const port = Number(process.env.MONITOR_PORT ?? 4400);
const paths = defaultPaths();
const m = await startMonitor({ paths, port });
console.log(`build-monitor listening on ${m.url}`);
console.log(`  coordination: ${paths.coordDir}`);
console.log(`  reports:      ${paths.reportsDir}`);
console.log(`  test index:   ${paths.testIndex}`);
const stop = (): void => {
  void m.close().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
