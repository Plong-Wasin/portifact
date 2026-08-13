CREATE TABLE "schema_meta" (
	"id" integer PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
INSERT INTO "schema_meta" ("id", "version", "updated_at") VALUES (1, 1, now());
