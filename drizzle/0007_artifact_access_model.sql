ALTER TABLE "artifact" ADD COLUMN "general_access" text DEFAULT 'only_people_with_access' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact" ADD COLUMN "shared_version_id" text;--> statement-breakpoint
CREATE TABLE "artifact_access" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE TABLE "artifact_pin" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
ALTER TABLE "artifact_access" ADD CONSTRAINT "artifact_access_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_access" ADD CONSTRAINT "artifact_access_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_pin" ADD CONSTRAINT "artifact_pin_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_pin" ADD CONSTRAINT "artifact_pin_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_access_artifact_user_idx" ON "artifact_access" USING btree ("artifact_id","user_id");--> statement-breakpoint
CREATE INDEX "artifact_access_artifact_idx" ON "artifact_access" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "artifact_access_user_idx" ON "artifact_access" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_pin_artifact_user_idx" ON "artifact_pin" USING btree ("artifact_id","user_id");--> statement-breakpoint
CREATE INDEX "artifact_pin_user_idx" ON "artifact_pin" USING btree ("user_id");--> statement-breakpoint
DROP TABLE "share_link";--> statement-breakpoint
ALTER TABLE "artifact" DROP COLUMN "published_version_id";--> statement-breakpoint
UPDATE "schema_meta" SET "version" = 8, "updated_at" = now() WHERE "id" = 1;
