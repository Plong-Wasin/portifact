import { migrate } from "drizzle-orm/bun-sql/migrator";
import { eq } from "drizzle-orm";
import { loadConfig, type Config } from "../config";
import { createDb } from "./client";
import { schemaMeta } from "./schema";

export async function runMigrations(config: Config) {
  const { db, sql } = createDb(config);
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
    const [meta] = await db.select().from(schemaMeta).where(eq(schemaMeta.id, 1));
    if (!meta || meta.version !== config.requiredMigrationVersion) {
      throw new Error(`migration version ${meta?.version} does not match required ${config.requiredMigrationVersion}`);
    }
  } finally {
    await sql.close();
  }
}

if (import.meta.main) {
  const config = loadConfig();
  try {
    await runMigrations(config);
    console.log(JSON.stringify({ event: "database_migrated", version: config.requiredMigrationVersion }));
  } catch (error) {
    console.error(JSON.stringify({ event: "database_migration_failed", error: error instanceof Error ? error.message : undefined }));
    process.exitCode = 1;
  }
}
