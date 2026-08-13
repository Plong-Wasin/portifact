import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";
import type { Config } from "../config";

export function createDb(config: Config) {
  const sql = new SQL(config.databaseUrl);
  const db = drizzle({ client: sql, schema });
  return { db, sql };
}

export type Database = ReturnType<typeof createDb>["db"];
