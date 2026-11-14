import { createCh, migrate } from "../src/ch.ts";
import { migratePg } from "../src/pg.ts";

const ch = createCh();
console.log("clickhouse applied:", await migrate(ch));
await ch.close();
console.log("postgres applied:", await migratePg());
