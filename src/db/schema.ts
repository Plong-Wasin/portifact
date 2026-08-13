import { integer, pgTable, timestamp } from "drizzle-orm/pg-core";

export * from "./auth-schema";
export * from "./artifact-schema";

export const schemaMeta = pgTable("schema_meta", {
  id: integer("id").primaryKey(),
  version: integer("version").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export type SchemaMeta = typeof schemaMeta.$inferSelect;
