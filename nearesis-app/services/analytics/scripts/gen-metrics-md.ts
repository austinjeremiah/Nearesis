import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SERVICE_ROOT } from "../src/ch.ts";
import { generateMetricsMd } from "../src/registry/metricsdoc.ts";
import { loadRegistry } from "../src/registry/registry.ts";

const out = join(SERVICE_ROOT, "..", "..", "docs", "metrics", "METRICS.md");
writeFileSync(out, generateMetricsMd(loadRegistry()));
console.log("wrote", out);
