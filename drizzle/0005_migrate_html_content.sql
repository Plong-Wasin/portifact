UPDATE "artifact" SET "format" = 'html' WHERE "format" IS NULL;--> statement-breakpoint
UPDATE "artifact_version" SET "content" = "html" WHERE "content" IS NULL;--> statement-breakpoint
ALTER TABLE "artifact" ALTER COLUMN "format" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_version" ALTER COLUMN "content" SET NOT NULL;--> statement-breakpoint
UPDATE "schema_meta" SET "version" = 6, "updated_at" = now() WHERE "id" = 1;
