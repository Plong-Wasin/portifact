import { describe, expect, test } from "bun:test";
import { config } from "./helpers";

const DSN = Bun.env.TEST_DATABASE_URL;

async function setup() {
  const { createDb } = await import("../src/db/client");
  const { runMigrations } = await import("../src/db/migrate");
  const { ArtifactService } = await import("../src/artifacts/service");
  const { user } = await import("../src/db/schema");
  const cfg = config({ DATABASE_URL: DSN! });
  const { db, sql } = createDb(cfg);
  await runMigrations(cfg);
  const now = new Date();
  const ownerId = crypto.randomUUID();
  await db.insert(user).values({
    id: ownerId, name: "tester", email: `${ownerId}@test.local`,
    emailVerified: false, createdAt: now, updatedAt: now,
  });
  const service = new ArtifactService(db, cfg);
  return { db, sql, service, ownerId };
}

describe.skipIf(!DSN)("share lifecycle", () => {
  test("publish then rotate revokes the old token and issues a new one", async () => {
    const { sql, service, ownerId } = await setup();
    try {
      const created = await service.create(ownerId, "doc", "<p>hi</p>", "html");
      const version = (await service.versions(ownerId, created.artifact.id))[0];

      const pub1 = await service.publish(ownerId, created.artifact.id, version.id);
      const shared1 = await service.shared(pub1.token);
      expect(shared1.version.id).toBe(version.id);

      const pub2 = await service.rotate(ownerId, created.artifact.id);
      expect(pub2.token).not.toBe(pub1.token);

      const history = await service.shareLinks(ownerId, created.artifact.id);
      expect(history.map((link) => link.token)).toEqual([pub2.token, pub1.token]);
      expect(history[0]?.revokedAt).toBeNull();
      expect(history[1]?.revokedAt).toBeInstanceOf(Date);

      await expect(service.shared(pub1.token)).rejects.toThrow(); // revoked
      const shared2 = await service.shared(pub2.token);
      expect(shared2.version.id).toBe(version.id);

      await service.remove(ownerId, created.artifact.id);
    } finally {
      await sql.close();
    }
  });

  test("delete revokes active share link", async () => {
    const { sql, service, ownerId } = await setup();
    try {
      const created = await service.create(ownerId, "doc", "<p>x</p>", "html");
      const version = (await service.versions(ownerId, created.artifact.id))[0];
      const pub = await service.publish(ownerId, created.artifact.id, version.id);

      await service.remove(ownerId, created.artifact.id);
      await expect(service.shared(pub.token)).rejects.toThrow();
    } finally {
      await sql.close();
    }
  });

  test("restore cancels the pending purge job", async () => {
    const { db, sql, service, ownerId } = await setup();
    try {
      const { eq } = await import("drizzle-orm");
      const { job } = await import("../src/db/schema");
      const created = await service.create(ownerId, "doc", "<p>x</p>", "html");
      await service.remove(ownerId, created.artifact.id);
      const before = await db.select().from(job).where(eq(job.artifactId, created.artifact.id));
      expect(before.length).toBe(1);
      await service.restore(ownerId, created.artifact.id);
      const after = await db.select().from(job).where(eq(job.artifactId, created.artifact.id));
      expect(after.length).toBe(0);
    } finally {
      await sql.close();
    }
  });
});
