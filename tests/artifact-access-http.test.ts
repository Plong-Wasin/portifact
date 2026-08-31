import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
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
  const owner = { id: crypto.randomUUID(), name: "HTTP owner", email: `${crypto.randomUUID()}@test.local`, emailVerified: false };
  const viewer = { id: crypto.randomUUID(), name: "HTTP viewer", email: `${crypto.randomUUID()}@test.local`, emailVerified: false };
  await db.insert(user).values([
    { ...owner, createdAt: now, updatedAt: now },
    { ...viewer, createdAt: now, updatedAt: now },
  ]);
  const service = new ArtifactService(db, cfg);
  return { cfg, db, sql, owner, viewer, service };
}

function appFor(db: unknown, cfg: ReturnType<typeof config>, current: { id: string; name: string; email: string; emailVerified: boolean } | null) {
  return createApp(db as never, cfg, { api: { getSession: async () => current ? { user: current } : null } } as never);
}

describe.skipIf(!DSN)("artifact access through the application", () => {
  test("uses the same route for private, explicit, login-only, and link-only access", async () => {
    const { cfg, db, sql, owner, viewer, service } = await setup();
    try {
      const created = await service.create(owner.id, "http doc", "<p>v1</p>", "html");
      const v1 = created.version;
      const v2 = (await service.createVersion(owner.id, created.artifact.id, v1.id, "<p>v2</p>", "html")).version;
      const path = `/artifacts/${created.artifact.id}`;

      expect((await appFor(db, cfg, owner).handle(new Request(`http://localhost${path}`))).status).toBe(200);
      expect((await appFor(db, cfg, null).handle(new Request(`http://localhost${path}`))).status).toBe(404);

      await service.grantAccess(owner.id, created.artifact.id, viewer.id, "viewer");
      const explicitBody = await (await appFor(db, cfg, viewer).handle(new Request(`http://localhost${path}`))).text();
      expect(explicitBody).toContain("Version history");
      expect(explicitBody).toContain("Download");

      const upload = new FormData();
      upload.set("csrf", "csrf-token");
      upload.set("parent_version_id", v2.id);
      upload.set("file", new File(["<p>v3</p>"], "http-doc.html", { type: "text/html" }));
      const uploaded = await appFor(db, cfg, owner).handle(new Request(`http://localhost${path}/versions`, {
        method: "POST",
        headers: { cookie: "portifact_csrf=csrf-token", origin: "http://localhost" },
        body: upload,
      }));
      expect(uploaded.status).toBe(302);
      expect(uploaded.headers.get("location")).toContain("?version=");

      await service.setGeneralAccess(owner.id, created.artifact.id, "anyone_with_the_link");
      await service.setSharedVersion(owner.id, created.artifact.id, v1.id);
      const publicPage = await appFor(db, cfg, null).handle(new Request(`http://localhost${path}`));
      const publicBody = await publicPage.text();
      expect(publicPage.status).toBe(200);
      expect(publicBody).toContain(`/artifacts/${created.artifact.id}/content?version=${v1.id}`);
      expect(publicBody).not.toContain("Version history");
      expect((await appFor(db, cfg, null).handle(new Request(`http://localhost${path}/content?version=${v1.id}`))).status).toBe(200);
      expect((await appFor(db, cfg, null).handle(new Request(`http://localhost${path}/content?version=${v2.id}`))).status).toBe(403);

      await service.setGeneralAccess(owner.id, created.artifact.id, "everyone_with_login");
      const loginRequired = await appFor(db, cfg, null).handle(new Request(`http://localhost${path}`));
      expect(loginRequired.status).toBe(302);
      expect(loginRequired.headers.get("location")).toContain("/login?returnTo=");
      expect((await appFor(db, cfg, viewer).handle(new Request(`http://localhost${path}`))).status).toBe(200);
    } finally {
      await sql.close();
    }
  });
});
