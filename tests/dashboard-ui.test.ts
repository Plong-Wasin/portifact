import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { ArtifactService } from "../src/artifacts/service";
import { config } from "./helpers";

const owner = { id: "owner-1", name: "Person Example", email: "person@example.com", emailVerified: true };
const artifact = {
  id: "artifact-1",
  ownerId: owner.id,
  name: "Design document",
  format: "html" as const,
  latestVersionId: "version-1",
  publishedVersionId: "version-1",
  deletedAt: null,
  purgeAfter: null,
  createdAt: new Date("2026-08-29T00:00:00.000Z"),
  updatedAt: new Date("2026-08-29T00:00:00.000Z"),
};
const version = {
  id: "version-1",
  artifactId: artifact.id,
  parentVersionId: null,
  ordinal: 1,
  content: "<h1>Hello</h1>",
  byteSize: 14,
  digest: "a".repeat(64),
  source: "dashboard",
  creatorId: owner.id,
  createdAt: artifact.createdAt,
};
const activeLink = {
  id: "share-active",
  token: "active-token",
  url: "/s/active-token",
  revokedAt: null,
  createdAt: new Date("2026-08-29T00:02:00.000Z"),
};
const oldLink = {
  id: "share-old",
  token: "old-token",
  url: "/s/old-token",
  revokedAt: new Date("2026-08-29T00:01:00.000Z"),
  createdAt: new Date("2026-08-29T00:01:00.000Z"),
};

function appWithSession() {
  return createApp({} as never, config(), {
    api: { getSession: async () => ({ user: owner }) },
  } as never);
}

function requestHeaders() {
  return { cookie: "portifact_csrf=csrf-token" };
}

describe("dashboard artifact UI", () => {
  test("keeps long version digests inside the versions card and shows copyable link history", async () => {
    const originalGet = ArtifactService.prototype.get;
    const originalVersionsMeta = ArtifactService.prototype.versionsMeta;
    const originalShareLinks = (ArtifactService.prototype as any).shareLinks;
    ArtifactService.prototype.get = async () => artifact as any;
    ArtifactService.prototype.versionsMeta = async () => [version] as any;
    (ArtifactService.prototype as any).shareLinks = async () => [activeLink, oldLink];

    try {
      const response = await appWithSession().handle(new Request("http://localhost/artifacts/artifact-1", { headers: requestHeaders() }));
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain('class="table-wrap"');
      expect(body).toContain('class="digest"');
      expect(body).toContain("overflow-wrap: anywhere");
      expect(body).toContain("http://localhost/s/old-token");
      expect(body).toContain('data-copy-url="http://localhost/s/old-token"');
      expect(body).toContain("Revoked");
    } finally {
      ArtifactService.prototype.get = originalGet;
      ArtifactService.prototype.versionsMeta = originalVersionsMeta;
      (ArtifactService.prototype as any).shareLinks = originalShareLinks;
    }
  });

  test("uses the dashboard shell for private and public preview pages", async () => {
    const originalGet = ArtifactService.prototype.get;
    const originalVersion = ArtifactService.prototype.version;
    const originalShared = ArtifactService.prototype.shared;
    ArtifactService.prototype.get = async () => artifact as any;
    ArtifactService.prototype.version = async () => version as any;
    ArtifactService.prototype.shared = async () => ({ artifact, version }) as any;

    try {
      const app = appWithSession();
      const privatePreview = await app.handle(new Request("http://localhost/artifacts/artifact-1/versions/version-1/preview", { headers: requestHeaders() }));
      const privateBody = await privatePreview.text();
      const publicPreview = await app.handle(new Request("http://localhost/s/active-token"));
      const publicBody = await publicPreview.text();

      expect(privatePreview.status).toBe(200);
      expect(privateBody).toContain('class="brand-mark"');
      expect(privateBody).toContain('class="artifact-frame"');
      expect(privateBody).not.toContain('style="width:100%;height:80vh"');
      expect(publicPreview.status).toBe(200);
      expect(publicBody).toContain('class="brand-mark"');
      expect(publicBody).toContain('class="artifact-frame"');
    } finally {
      ArtifactService.prototype.get = originalGet;
      ArtifactService.prototype.version = originalVersion;
      ArtifactService.prototype.shared = originalShared;
    }
  });

  test("shows the published link immediately and uses the rotate result URL", async () => {
    const originalPublish = ArtifactService.prototype.publish;
    const originalRotate = ArtifactService.prototype.rotate;
    ArtifactService.prototype.publish = async () => ({ artifact, version, token: "active-token", url: "/s/active-token" }) as any;
    ArtifactService.prototype.rotate = async () => ({ token: "rotated-token", url: "/s/rotated-token" }) as any;

    try {
      const app = appWithSession();
      const publishResponse = await app.handle(new Request("http://localhost/artifacts/artifact-1/publish/version-1", {
        method: "POST",
        headers: { ...requestHeaders(), origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf: "csrf-token" }),
      }));
      const publishBody = await publishResponse.text();
      const rotateResponse = await app.handle(new Request("http://localhost/artifacts/artifact-1/rotate", {
        method: "POST",
        headers: { ...requestHeaders(), origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf: "csrf-token" }),
      }));
      const rotateBody = await rotateResponse.text();

      expect(publishResponse.status).toBe(200);
      expect(publishBody).toContain("http://localhost/s/active-token");
      expect(publishBody).toContain('data-copy-url="http://localhost/s/active-token"');
      expect(rotateResponse.status).toBe(200);
      expect(rotateBody).toContain("http://localhost/s/rotated-token");
      expect(rotateBody).not.toContain("[object Object]");
    } finally {
      ArtifactService.prototype.publish = originalPublish;
      ArtifactService.prototype.rotate = originalRotate;
    }
  });
});
