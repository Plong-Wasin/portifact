CREATE TABLE "artifact" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"latest_version_id" text,
	"published_version_id" text,
	"deleted_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_version" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"parent_version_id" text,
	"ordinal" integer NOT NULL,
	"html" text NOT NULL,
	"byte_size" integer NOT NULL,
	"digest" text NOT NULL,
	"source" text NOT NULL,
	"creator_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_key" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"client_id" text NOT NULL,
	"tool" text NOT NULL,
	"request_hash" text NOT NULL,
	"result" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"artifact_id" text,
	"status" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"refresh_token_expires_at" timestamp with time zone NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text,
	"scopes" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_application" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"metadata" text,
	"client_id" text NOT NULL,
	"client_secret" text,
	"redirect_urls" text NOT NULL,
	"type" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scopes" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"consent_given" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_link" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"encrypted_token" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_version" ADD CONSTRAINT "artifact_version_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_version" ADD CONSTRAINT "artifact_version_creator_id_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_oauth_application_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_application"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_application" ADD CONSTRAINT "oauth_application_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_oauth_application_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_application"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_version_artifact_ordinal_idx" ON "artifact_version" USING btree ("artifact_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_scope_idx" ON "idempotency_key" USING btree ("owner_id","client_id","tool","id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_access_token_access_idx" ON "oauth_access_token" USING btree ("access_token");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_access_token_refresh_idx" ON "oauth_access_token" USING btree ("refresh_token");--> statement-breakpoint
CREATE INDEX "oauth_access_token_client_id_idx" ON "oauth_access_token" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_user_id_idx" ON "oauth_access_token" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_application_client_id_idx" ON "oauth_application" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_application_user_id_idx" ON "oauth_application" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_consent_client_id_idx" ON "oauth_consent" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_consent_user_id_idx" ON "oauth_consent" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "share_link_artifact_idx" ON "share_link" USING btree ("artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "share_link_token_idx" ON "share_link" USING btree ("token_hash");--> statement-breakpoint
UPDATE "schema_meta" SET "version" = 4, "updated_at" = now() WHERE "id" = 1;