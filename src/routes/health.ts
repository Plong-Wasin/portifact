import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import type { Config } from "../config";
import { schemaMeta } from "../db/schema";
import { shutdown } from "../runtime";

const json = (body: object, status = 200) => Response.json(body, { status });

export function registerHealthRoutes(db: ReturnType<typeof import("../db/client").createDb>["db"], config: Config) {
  const app = new Elysia();
  return app
    .get("/health/live", () => json({ status: "ok" }))
    .get("/health/ready", async () => {
      if (shutdown.draining) return json({ status: "draining" }, 503);
      try {
        // Bound every readiness probe so a hung database cannot pin it.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.readyDbTimeoutMs);
        try {
          await db.execute(sql`select 1`);
          const [meta] = await db.select({ version: schemaMeta.version }).from(schemaMeta).where(sql`${schemaMeta.id} = 1`);
          if (!meta || meta.version !== config.requiredMigrationVersion) return json({ status: "unready" }, 503);
        } finally {
          clearTimeout(timeout);
        }
        return json({ status: "ok" });
      } catch {
        return json({ status: "unready" }, 503);
      }
    });
}
