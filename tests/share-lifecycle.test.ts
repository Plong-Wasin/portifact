import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
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
  const viewerId = crypto.randomUUID();
  await db.insert(user).values([
    { id: ownerId, name: "owner", email: `${ownerId}@test.local`, emailVerified: false, createdAt: now, updatedAt: now },
    { id: viewerId, name: "viewer", email: `${viewerId}@test.local`, emailVerified: false, createdAt: now, updatedAt: now },
  ]);
  const service = new ArtifactService(db, cfg);
  return { db, sql, service, ownerId, viewerId };
}

describe.skipIf(!DSN)("artifact access lifecycle", () => {
  test("keeps one canonical link while general access selects the shared version", async () => {
    const { sql, service, ownerId, viewerId } = await setup();
    try {
      const created = await service.create(ownerId, "doc", "<p>v1</p>", "html");
      const v1 = (await service.versions(ownerId, created.artifact.id))[0]!;
      const v2 = (await service.createVersion(ownerId, created.artifact.id, v1.id, "<p>v2</p>", "html")).version;
      expect((await service.createVersion(ownerId, created.artifact.id, v2.id, "<p>v2</p>", "html")).version.id).toBe(v2.id);
      await expect(service.createVersion(ownerId, created.artifact.id, v1.id, "<p>v3</p>", "html")).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

      await service.setGeneralAccess(ownerId, created.artifact.id, "anyone_with_the_link");
      await service.setSharedVersion(ownerId, created.artifact.id, "latest");
      expect((await service.viewerVersion(null, created.artifact.id)).version.id).toBe(v2.id);
      await service.setSharedVersion(ownerId, created.artifact.id, v1.id);
      const publicView = await service.viewerVersion(null, created.artifact.id);
      expect(publicView.version.id).toBe(v1.id);
      await expect(service.viewerVersion(null, created.artifact.id, v2.id)).rejects.toMatchObject({ code: "VERSION_FORBIDDEN" });

      await service.grantAccess(ownerId, created.artifact.id, viewerId, "viewer");
      expect((await service.viewerVersion(viewerId, created.artifact.id, v2.id)).version.id).toBe(v2.id);
    } finally {
      await sql.close();
    }
  });

  test("delete makes access unavailable and restore returns the artifact as private", async () => {
    const { sql, service, ownerId, viewerId } = await setup();
    try {
      const created = await service.create(ownerId, "doc", "<p>x</p>", "html");
      await service.grantAccess(ownerId, created.artifact.id, viewerId, "viewer");
      await service.setGeneralAccess(ownerId, created.artifact.id, "anyone_with_the_link");
      await service.remove(ownerId, created.artifact.id);
      await expect(service.getForViewer(viewerId, created.artifact.id)).rejects.toThrow();

      await service.restore(ownerId, created.artifact.id);
      const restored = await service.get(ownerId, created.artifact.id);
      expect(restored.generalAccess).toBe("only_people_with_access");
      expect((await service.getForViewer(viewerId, created.artifact.id)).access.kind).toBe("viewer");
      await expect(service.getForViewer(null, created.artifact.id)).rejects.toThrow();
    } finally {
      await sql.close();
    }
  });

  test("explicit roles bypass the shared version and keep mutation boundaries", async () => {
    const { db, sql, service, ownerId, viewerId } = await setup();
    try {
      const { user } = await import("../src/db/schema");
      const editorId = crypto.randomUUID();
      const now = new Date();
      await db.insert(user).values({ id: editorId, name: "editor", email: `${editorId}@test.local`, emailVerified: false, createdAt: now, updatedAt: now });
      const created = await service.create(ownerId, "doc", "<p>v1</p>", "html");
      const v1 = created.version;
      const v2 = (await service.createVersion(ownerId, created.artifact.id, v1.id, "<p>v2</p>", "html")).version;
      await service.setGeneralAccess(ownerId, created.artifact.id, "anyone_with_the_link");
      await service.setSharedVersion(ownerId, created.artifact.id, v1.id);
      await service.grantAccess(ownerId, created.artifact.id, editorId, "editor");
      await service.grantAccess(ownerId, created.artifact.id, viewerId, "viewer");

      expect((await service.viewerVersion(editorId, created.artifact.id, v2.id)).version.id).toBe(v2.id);
      expect((await service.viewerVersion(viewerId, created.artifact.id, v2.id)).version.id).toBe(v2.id);
      await expect(service.createVersion(viewerId, created.artifact.id, v2.id, "<p>nope</p>", "html")).rejects.toMatchObject({ code: "VERSION_CREATE_FORBIDDEN" });
      await expect(service.rename(editorId, created.artifact.id, "not allowed")).rejects.toThrow();
    } finally {
      await sql.close();
    }
  });

  test("keeps General access out of dashboard discovery and isolates personal pins", async () => {
    const { sql, service, ownerId, viewerId } = await setup();
    try {
      const created = await service.create(ownerId, "doc", "<p>x</p>", "html");
      await service.setGeneralAccess(ownerId, created.artifact.id, "anyone_with_the_link");
      expect(await service.listForUser(viewerId, "all")).toHaveLength(0);

      await service.grantAccess(ownerId, created.artifact.id, viewerId, "viewer");
      expect((await service.listForUser(viewerId, "shared"))[0]?.accessRole).toBe("viewer");
      expect((await service.listForUser(viewerId, "yours"))).toHaveLength(0);
      expect((await service.listForUser(ownerId, "yours"))[0]?.pinned).toBe(false);
      await service.pin(viewerId, created.artifact.id);
      expect((await service.listForUser(viewerId, "all"))[0]?.pinned).toBe(true);
      expect((await service.listForUser(ownerId, "all"))[0]?.pinned).toBe(false);
    } finally {
      await sql.close();
    }
  });

  test("preserves version history when a contributor is deleted", async () => {
    const { db, sql, service, ownerId } = await setup();
    try {
      const { user } = await import("../src/db/schema");
      const contributorId = crypto.randomUUID();
      const now = new Date();
      await db.insert(user).values({ id: contributorId, name: "contributor", email: `${contributorId}@test.local`, emailVerified: false, createdAt: now, updatedAt: now });
      const created = await service.create(ownerId, "doc", "<p>v1</p>", "html");
      await service.grantAccess(ownerId, created.artifact.id, contributorId, "editor");
      const version = (await service.createVersion(contributorId, created.artifact.id, created.version.id, "<p>v2</p>", "html")).version;

      await db.delete(user).where(eq(user.id, contributorId));

      const history = await service.versionsMeta(ownerId, created.artifact.id);
      expect(history.find((item) => item.id === version.id)?.creatorId).toBeNull();
    } finally {
      await sql.close();
    }
  });
});
