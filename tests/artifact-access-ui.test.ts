import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { ArtifactService } from "../src/artifacts/service";
import { DomainError } from "../src/artifacts/domain";
import { config } from "./helpers";

const owner = { id: "owner-1", name: "Owner Example", email: "owner@example.com", emailVerified: true };
const artifact = {
  id: "artifact-1",
  ownerId: owner.id,
  name: "Design document",
  format: "html" as const,
  latestVersionId: "version-2",
  generalAccess: "only_people_with_access" as const,
  sharedVersionId: null,
  deletedAt: null,
  purgeAfter: null,
  createdAt: new Date("2026-08-29T00:00:00.000Z"),
  updatedAt: new Date("2026-08-29T00:00:00.000Z"),
};
const version = {
  id: "version-2",
  artifactId: artifact.id,
  parentVersionId: "version-1",
  ordinal: 2,
  content: "<h1>Latest</h1>",
  byteSize: 16,
  digest: "a".repeat(64),
  source: "dashboard",
  creatorId: owner.id,
  createdAt: artifact.updatedAt,
};

function appWithSession(user: typeof owner | null = owner) {
  return createApp({} as never, config(), {
    api: { getSession: async () => user ? { user } : null },
  } as never);
}

function requestHeaders() {
  return { cookie: "portifact_csrf=csrf-token" };
}

describe("canonical Artifact workspace access", () => {
  test("opens the Owner's latest Preview through the canonical Artifact link", async () => {
    const originalViewer = (ArtifactService.prototype as any).getForViewer;
    const originalVersion = (ArtifactService.prototype as any).viewerVersion;
    const originalSettings = (ArtifactService.prototype as any).shareSettings;
    const originalVersions = (ArtifactService.prototype as any).versionsMetaForViewer;
    const originalPinned = (ArtifactService.prototype as any).isPinned;
    const ownerAccess = { kind: "owner", canManage: true, canContribute: true, canBrowseVersions: true, canViewSource: true, canDownload: true };
    (ArtifactService.prototype as any).getForViewer = async () => ({ artifact, access: ownerAccess });
    (ArtifactService.prototype as any).viewerVersion = async () => ({ artifact, access: ownerAccess, version });
    (ArtifactService.prototype as any).shareSettings = async () => ({ artifact, people: [{ user: owner, role: "owner" }], canManage: true });
    (ArtifactService.prototype as any).versionsMetaForViewer = async () => [version];
    (ArtifactService.prototype as any).isPinned = async () => false;

    try {
      const response = await appWithSession().handle(new Request("http://localhost/artifacts/artifact-1", { headers: requestHeaders() }));
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain("Design document");
      expect(body).toContain("Artifact preview");
      expect(body).toContain("Share");
      expect(body).toContain("Version history");
      expect(body).toContain('data-artifact-link="/artifacts/artifact-1"');
      expect(body).toContain('/artifacts/artifact-1/content?version=version-2');
      expect((await appWithSession().handle(new Request("http://localhost/artifacts/artifact-1/versions/version-2/preview", { headers: requestHeaders() }))).status).toBe(404);
    } finally {
      (ArtifactService.prototype as any).getForViewer = originalViewer;
      (ArtifactService.prototype as any).viewerVersion = originalVersion;
      (ArtifactService.prototype as any).shareSettings = originalSettings;
      (ArtifactService.prototype as any).versionsMetaForViewer = originalVersions;
      (ArtifactService.prototype as any).isPinned = originalPinned;
    }
  });

  test("does not expose a private Artifact to an anonymous viewer", async () => {
    const originalViewer = (ArtifactService.prototype as any).getForViewer;
    (ArtifactService.prototype as any).getForViewer = async () => {
      throw new DomainError("ARTIFACT_NOT_FOUND", "artifact not found", 404);
    };

    try {
      const response = await appWithSession(null).handle(new Request("http://localhost/artifacts/artifact-1"));

      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("Design document");
    } finally {
      (ArtifactService.prototype as any).getForViewer = originalViewer;
    }
  });

  test("redirects anonymous users to sign in for login-only General access", async () => {
    const originalViewer = (ArtifactService.prototype as any).getForViewer;
    (ArtifactService.prototype as any).getForViewer = async () => {
      throw new DomainError("LOGIN_REQUIRED", "sign in required", 401);
    };

    try {
      const response = await appWithSession(null).handle(new Request("http://localhost/artifacts/artifact-1"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("http://localhost/login?returnTo=%2Fartifacts%2Fartifact-1");
    } finally {
      (ArtifactService.prototype as any).getForViewer = originalViewer;
    }
  });
});
