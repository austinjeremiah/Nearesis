import { DEFAULT_ADMIN_URL } from "./pool.ts";
import { migrate } from "./migrate.ts";

const applied = await migrate(process.env.DATABASE_URL ?? DEFAULT_ADMIN_URL);
console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
