import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { ARTIFACT_FORMATS } from "../artifacts/content";

export const oauthApplication = pgTable("oauth_application", {
  id: text("id").primaryKey().notNull(),
  name: text("name").notNull(),
  icon: text("icon"),
  metadata: text("metadata"),
  clientId: text("client_id").notNull(),
  clientSecret: text("client_secret"),
  redirectUrls: text("redirect_urls").notNull(),
  type: text("type").notNull(),
  disabled: boolean("disabled").default(false).notNull(),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => ({
  clientIdUnique: uniqueIndex("oauth_application_client_id_idx").on(table.clientId),
  userIdIndex: index("oauth_application_user_id_idx").on(table.userId),
}));

export const oauthAccessToken = pgTable("oauth_access_token", {
  id: text("id").primaryKey().notNull(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }).notNull(),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }).notNull(),
  clientId: text("client_id").notNull().references(() => oauthApplication.clientId, { onDelete: "cascade" }),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  scopes: text("scopes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => ({
  accessUnique: uniqueIndex("oauth_access_token_access_idx").on(table.accessToken),
  refreshUnique: uniqueIndex("oauth_access_token_refresh_idx").on(table.refreshToken),
  clientIdIndex: index("oauth_access_token_client_id_idx").on(table.clientId),
  userIdIndex: index("oauth_access_token_user_id_idx").on(table.userId),
}));

export const oauthConsent = pgTable("oauth_consent", {
  id: text("id").primaryKey().notNull(),
  clientId: text("client_id").notNull().references(() => oauthApplication.clientId, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  scopes: text("scopes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  consentGiven: boolean("consent_given").notNull(),
}, (table) => ({
  clientIdIndex: index("oauth_consent_client_id_idx").on(table.clientId),
  userIdIndex: index("oauth_consent_user_id_idx").on(table.userId),
}));

export const jwks = pgTable("jwks", {
  id: text("id").primaryKey().notNull(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export const artifact = pgTable("artifact", {
  id: text("id").primaryKey().notNull(),
  ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  format: text("format", { enum: ARTIFACT_FORMATS }).notNull(),
  latestVersionId: text("latest_version_id"),
  publishedVersionId: text("published_version_id"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  purgeAfter: timestamp("purge_after", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const artifactVersion = pgTable("artifact_version", {
  id: text("id").primaryKey().notNull(),
  artifactId: text("artifact_id").notNull().references(() => artifact.id, { onDelete: "cascade" }),
  parentVersionId: text("parent_version_id"),
  ordinal: integer("ordinal").notNull(),
  content: text("content").notNull(),
  byteSize: integer("byte_size").notNull(),
  digest: text("digest").notNull(),
  source: text("source").notNull(),
  creatorId: text("creator_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => ({ artifactOrdinal: uniqueIndex("artifact_version_artifact_ordinal_idx").on(table.artifactId, table.ordinal) }));

export const shareLink = pgTable("share_link", {
  id: text("id").primaryKey().notNull(),
  artifactId: text("artifact_id").notNull().references(() => artifact.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  encryptedToken: text("encrypted_token").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => ({
  artifactActiveUnique: uniqueIndex("share_link_artifact_active_idx").on(table.artifactId).where(sql`${table.revokedAt} is null`),
  tokenUnique: uniqueIndex("share_link_token_idx").on(table.tokenHash),
}));

export const job = pgTable("job", {
  id: text("id").primaryKey().notNull(),
  kind: text("kind").notNull(),
  artifactId: text("artifact_id").references(() => artifact.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const idempotencyKey = pgTable("idempotency_key", {
  id: text("id").primaryKey().notNull(),
  ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull(),
  tool: text("tool").notNull(),
  requestHash: text("request_hash").notNull(),
  result: text("result").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => ({ scope: uniqueIndex("idempotency_scope_idx").on(table.ownerId, table.clientId, table.tool, table.id) }));

export type Artifact = typeof artifact.$inferSelect;
export type ArtifactVersion = typeof artifactVersion.$inferSelect;
export type ShareLink = typeof shareLink.$inferSelect;
