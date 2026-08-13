DROP INDEX "share_link_artifact_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "share_link_artifact_active_idx" ON "share_link" USING btree ("artifact_id") WHERE "share_link"."revoked_at" is null;