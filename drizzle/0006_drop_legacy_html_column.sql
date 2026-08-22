ALTER TABLE "artifact_version" DROP COLUMN "html";--> statement-breakpoint
UPDATE "schema_meta" SET "version" = 7, "updated_at" = now() WHERE "id" = 1;
