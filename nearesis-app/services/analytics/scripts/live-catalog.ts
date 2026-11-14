import { createCh } from "../src/ch.ts";
import { LIVE_DATABASE } from "../src/live/definition.ts";
import { liveCatalog } from "../src/live/catalog.ts";

const ch = createCh({ database: LIVE_DATABASE });
console.log(JSON.stringify(await liveCatalog(ch), null, 2));
await ch.close();
