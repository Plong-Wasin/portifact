ALTER TABLE "artifact" ADD COLUMN "format" text;--> statement-breakpoint
ALTER TABLE "artifact_version" ADD COLUMN "content" text;--> statement-breakpoint
UPDATE "schema_meta" SET "version" = 5, "updated_at" = now() WHERE "id" = 1;
