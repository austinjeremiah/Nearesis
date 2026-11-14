import { DEFAULT_DATABASE_URL, migrate } from "../db.ts";

const applied = await migrate(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
