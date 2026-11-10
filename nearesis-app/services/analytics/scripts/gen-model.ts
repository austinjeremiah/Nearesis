import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderAll } from "../src/model/generate.ts";
import { loadRegistry } from "../src/registry/registry.ts";
import { SERVICE_ROOT } from "../src/ch.ts";

const dir = join(SERVICE_ROOT, "cube", "model");
mkdirSync(dir, { recursive: true });
const files = renderAll(loadRegistry());
for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
console.log(`generated ${Object.keys(files).length} model files in ${dir}`);
