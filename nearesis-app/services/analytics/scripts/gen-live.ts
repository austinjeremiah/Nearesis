import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SERVICE_ROOT } from "../src/ch.ts";
import { LIVE_CUBES } from "../src/live/definition.ts";
import { buildLiveRegistry, LIVE_REGISTRY_FILE } from "../src/live/registry.ts";
import { renderCubeFile } from "../src/model/generate.ts";
import { stringifyRegistry } from "../src/registry/registry.ts";

const reg = buildLiveRegistry();
writeFileSync(LIVE_REGISTRY_FILE, stringifyRegistry(reg));
const dir = join(SERVICE_ROOT, "cube-live", "model");
mkdirSync(dir, { recursive: true });
for (const c of LIVE_CUBES) writeFileSync(join(dir, `${c.view}.yml`), renderCubeFile(c, reg));
console.log(
  `live registry ${reg.contentHash.slice(0, 12)}: ${reg.metrics.length} metrics, ${LIVE_CUBES.length} views`,
);
