import { describe, expect, test } from "bun:test";
import { config } from "./helpers";

const DSN = Bun.env.TEST_DATABASE_URL;

async function setup(overrides: Record<string, string> = {}) {
  const { createDb } = await import("../src/db/client");
  const { runMigrations } = await import("../src/db/migrate");
  const { ArtifactService } = await import("../src/artifacts/service");
  const { user } = await import("../src/db/schema");
  const cfg = config({ DATABASE_URL: DSN!, ...overrides });
  const { db, sql } = createDb(cfg);
  await runMigrations(cfg);
  const ownerId = crypto.randomUUID();
  const now = new Date();
  await db.insert(user).values({
    id: ownerId, name: "content tester", email: `${ownerId}@test.local`,
    emailVerified: false, createdAt: now, updatedAt: now,
  });
  return { service: new ArtifactService(db, cfg), ownerId, sql };
}

describe.skipIf(!DSN)("format-aware artifact service", () => {
  test("stores a stable format and canonical content", async () => {
    const { service, ownerId, sql } = await setup();
    try {
      const created = await service.create(ownerId, "notes", "# Hello", "markdown");
      expect(created.artifact.format).toBe("markdown");
      expect(created.version.content).toBe("# Hello");
      expect(created.version.byteSize).toBe(7);
    } finally {
      await sql.close();
    }
  });

  test("rejects a version that changes the artifact format", async () => {
    const { service, ownerId, sql } = await setup();
    try {
      const created = await service.create(ownerId, "notes", "# Hello", "markdown");
      await expect(service.createVersion(ownerId, created.artifact.id, created.version.id, "<p>Hello</p>", "html"))
        .rejects.toMatchObject({ code: "ARTIFACT_FORMAT_MISMATCH" });
    } finally {
      await sql.close();
    }
  });

  test("applies the per-user storage limit to new versions", async () => {
    const { service, ownerId, sql } = await setup({ MAX_ARTIFACT_CONTENT_BYTES: "5", MAX_STORAGE_BYTES_PER_USER: "5" });
    try {
      const created = await service.create(ownerId, "notes", "12345", "plain_text");
      await expect(service.createVersion(ownerId, created.artifact.id, created.version.id, "x", "plain_text"))
        .rejects.toMatchObject({ code: "USER_STORAGE_LIMIT_EXCEEDED" });
    } finally {
      await sql.close();
    }
  });
});
