import { migrate } from "drizzle-orm/bun-sql/migrator";
import { eq } from "drizzle-orm";
import { loadConfig, type Config } from "../config";
import { createDb } from "./client";
import { schemaMeta } from "./schema";
import { createErrorTelemetry, flushErrorTelemetry, type ErrorTelemetry } from "../telemetry";

export async function runMigrations(config: Config, telemetry: ErrorTelemetry = createErrorTelemetry(config)) {
  const resources = createDb(config);
  try {
    await migrate(resources.db, { migrationsFolder: "./drizzle" });
    const [meta] = await resources.db.select().from(schemaMeta).where(eq(schemaMeta.id, 1));
    if (!meta || meta.version !== config.requiredMigrationVersion) {
      throw new Error(`migration version ${meta?.version} does not match required ${config.requiredMigrationVersion}`);
    }
  } catch (error) {
    try {
      telemetry.captureException(error, { service: "migration", status: 500, errorCode: "MIGRATION_FAILED" });
    } catch {
      // Telemetry must never hide the migration failure.
    }
    throw error;
  } finally {
    await resources.sql.close();
  }
}

if (import.meta.main) {
  const config = loadConfig();
  const telemetry = createErrorTelemetry(config);
  try {
    await runMigrations(config, telemetry);
    console.log(JSON.stringify({ event: "database_migrated", version: config.requiredMigrationVersion }));
  } catch (error) {
    console.error(JSON.stringify({ event: "database_migration_failed", error: error instanceof Error ? error.message : undefined }));
    process.exitCode = 1;
  } finally {
    await flushErrorTelemetry(telemetry, config.sentryFlushTimeoutMs);
  }
}
