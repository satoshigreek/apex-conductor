import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dir = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL ?? "postgres://apex:apex@localhost:5432/apex_conductor";

if (url.startsWith("memory://")) {
  console.log("DATABASE_URL=memory:// — in-memory store needs no migrations.");
  process.exit(0);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(`CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())`);
const applied = new Set((await client.query(`SELECT name FROM _migrations`)).rows.map((r: { name: string }) => r.name));

for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  if (applied.has(file)) continue;
  console.log(`applying ${file}`);
  await client.query("BEGIN");
  try {
    await client.query(readFileSync(join(dir, file), "utf8"));
    await client.query(`INSERT INTO _migrations (name) VALUES ($1)`, [file]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
await client.end();
console.log("migrations complete");
