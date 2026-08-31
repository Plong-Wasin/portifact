import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { ArtifactService } from "../src/artifacts/service";
import { DomainError } from "../src/artifacts/domain";
import { config } from "./helpers";

const owner = { id: "owner-1", name: "Person Example", email: "person@example.com", emailVerified: true };
const artifact = {
  id: "artifact-1",
  ownerId: owner.id,
  name: "Design document",
  format: "html" as const,
  latestVersionId: "version-2",
  generalAccess: "anyone_with_the_link" as const,
  sharedVersionId: "version-1",
  deletedAt: null,
  purgeAfter: null,
  createdAt: new Date("2026-08-29T00:00:00.000Z"),
  updatedAt: new Date("2026-08-29T00:00:00.000Z"),
};
const versions = [
  { id: "version-1", artifactId: artifact.id, parentVersionId: null, ordinal: 1, source: "dashboard", creatorId: owner.id, createdAt: artifact.createdAt },
  { id: "version-2", artifactId: artifact.id, parentVersionId: "version-1", ordinal: 2, source: "dashboard", creatorId: owner.id, createdAt: artifact.updatedAt },
];
const latest = { ...versions[1], content: "<h1>Latest</h1>", byteSize: 19, digest: "b".repeat(64) };
const shared = { ...versions[0], content: "<h1>Shared v1</h1>", byteSize: 21, digest: "a".repeat(64) };

function appWithSession(user: typeof owner | null = owner) {
  return createApp({} as never, config(), {
    api: { getSession: async () => user ? { user } : null },
  } as never);
}

function requestHeaders() {
  return { cookie: "portifact_csrf=csrf-token" };
}

describe("dashboard artifact UI", () => {
  test("renders dashboard filters and the canonical artifact link", async () => {
    const originalList = (ArtifactService.prototype as any).listForUser;
    (ArtifactService.prototype as any).listForUser = async () => [{ ...artifact, accessRole: "owner", ownerName: owner.name, ownerEmail: owner.email, pinned: true }];

    try {
      const response = await appWithSession().handle(new Request("http://localhost/artifacts?filter=yours&q=design", { headers: requestHeaders() }));
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain("All");
      expect(body).toContain("Yours");
      expect(body).toContain("Shared with you");
      expect(body).toContain("Design document");
      expect(body).toContain('data-artifact-link="/artifacts/artifact-1"');
      expect(body).toContain("Pinned");
    } finally {
      (ArtifactService.prototype as any).listForUser = originalList;
    }
  });

  test("uses the dashboard shell for the preview and keeps source/download actions outside the preview", async () => {
    const originalViewer = (ArtifactService.prototype as any).getForViewer;
    const originalVersion = (ArtifactService.prototype as any).viewerVersion;
    const originalVersions = (ArtifactService.prototype as any).versionsMetaForViewer;
    const originalSettings = (ArtifactService.prototype as any).shareSettings;
    const originalPinned = (ArtifactService.prototype as any).isPinned;
    const access = { kind: "owner", canManage: true, canContribute: true, canBrowseVersions: true, canViewSource: true, canDownload: true };
    (ArtifactService.prototype as any).getForViewer = async () => ({ artifact, access });
    (ArtifactService.prototype as any).viewerVersion = async (_userId: string | null, _artifactId: string, versionId?: string) => ({ artifact, access, version: versionId === "version-1" ? shared : latest });
    (ArtifactService.prototype as any).versionsMetaForViewer = async () => versions;
    (ArtifactService.prototype as any).shareSettings = async () => ({ artifact, access, people: [{ user: owner, role: "owner" }], canManage: true });
    (ArtifactService.prototype as any).isPinned = async () => false;

    try {
      const app = appWithSession();
      const workspace = await app.handle(new Request("http://localhost/artifacts/artifact-1", { headers: requestHeaders() }));
      const body = await workspace.text();
      const content = await app.handle(new Request("http://localhost/artifacts/artifact-1/content?version=version-1", { headers: requestHeaders() }));
      const contentBody = await content.text();

      expect(workspace.status).toBe(200);
      expect(body).toContain('class="artifact-frame"');
      expect(body).toContain("Version history");
      expect(body).toContain("Copy link");
      expect(body).toContain("http://localhost/artifacts/artifact-1");
      expect(content.status).toBe(200);
      expect(contentBody).toContain("Shared v1");
    } finally {
      (ArtifactService.prototype as any).getForViewer = originalViewer;
      (ArtifactService.prototype as any).viewerVersion = originalVersion;
      (ArtifactService.prototype as any).versionsMetaForViewer = originalVersions;
      (ArtifactService.prototype as any).shareSettings = originalSettings;
      (ArtifactService.prototype as any).isPinned = originalPinned;
    }
  });

  test("keeps the selected preview and shows an inline upload error", async () => {
    const originalViewer = (ArtifactService.prototype as any).getForViewer;
    const originalVersion = (ArtifactService.prototype as any).viewerVersion;
    const originalVersions = (ArtifactService.prototype as any).versionsMetaForViewer;
    const originalSettings = (ArtifactService.prototype as any).shareSettings;
    const originalPinned = (ArtifactService.prototype as any).isPinned;
    const originalCreateVersion = (ArtifactService.prototype as any).createVersion;
    const access = { kind: "owner", canManage: true, canContribute: true, canBrowseVersions: true, canViewSource: true, canDownload: true };
    (ArtifactService.prototype as any).getForViewer = async () => ({ artifact, access });
    (ArtifactService.prototype as any).viewerVersion = async (_userId: string | null, _artifactId: string, versionId?: string) => ({ artifact, access, version: versionId === "version-1" ? shared : latest });
    (ArtifactService.prototype as any).versionsMetaForViewer = async () => versions;
    (ArtifactService.prototype as any).shareSettings = async () => ({ artifact, access, people: [{ user: owner, role: "owner" }], canManage: true });
    (ArtifactService.prototype as any).isPinned = async () => false;
    (ArtifactService.prototype as any).createVersion = async () => { throw new DomainError("VERSION_CONFLICT", "artifact has a newer version", 409); };

    try {
      const form = new FormData();
      form.set("file", new File(["<h1>stale</h1>"], "design.html", { type: "text/html" }));
      form.set("parent_version_id", "version-1");
      form.set("view_version_id", "version-1");
      form.set("csrf", "csrf-token");
      const app = appWithSession();
      const upload = await app.handle(new Request("http://localhost/artifacts/artifact-1/versions", { method: "POST", headers: { cookie: "portifact_csrf=csrf-token" }, body: form }));

      expect(upload.status).toBe(302);
      expect(upload.headers.get("location")).toBe("http://localhost/artifacts/artifact-1?version=version-1&upload_error=VERSION_CONFLICT");

      const response = await app.handle(new Request(upload.headers.get("location")!, { headers: requestHeaders() }));
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain("newer Version");
      expect(body).toContain('/artifacts/artifact-1/content?version=version-1');
    } finally {
      (ArtifactService.prototype as any).getForViewer = originalViewer;
      (ArtifactService.prototype as any).viewerVersion = originalVersion;
      (ArtifactService.prototype as any).versionsMetaForViewer = originalVersions;
      (ArtifactService.prototype as any).shareSettings = originalSettings;
      (ArtifactService.prototype as any).isPinned = originalPinned;
      (ArtifactService.prototype as any).createVersion = originalCreateVersion;
    }
  });

  test("renders a narrow anonymous preview with the canonical copy-link control", async () => {
    const originalViewer = (ArtifactService.prototype as any).getForViewer;
    const originalVersion = (ArtifactService.prototype as any).viewerVersion;
    const access = { kind: "general", canManage: false, canContribute: false, canBrowseVersions: false, canViewSource: false, canDownload: false };
    (ArtifactService.prototype as any).getForViewer = async () => ({ artifact, access });
    (ArtifactService.prototype as any).viewerVersion = async () => ({ artifact, access, version: shared });

    try {
      const response = await appWithSession(null).handle(new Request("http://localhost/artifacts/artifact-1"));
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain('data-access-kind="general"');
      expect(body).toContain("Artifact preview");
      expect(body).toContain('<summary class="share-trigger">Share</summary>');
      expect(body).toContain("Copy link");
    } finally {
      (ArtifactService.prototype as any).getForViewer = originalViewer;
      (ArtifactService.prototype as any).viewerVersion = originalVersion;
    }
  });

  test("shows only the actions allowed by the current access role", async () => {
    const originalViewer = (ArtifactService.prototype as any).getForViewer;
    const originalVersion = (ArtifactService.prototype as any).viewerVersion;
    const originalVersions = (ArtifactService.prototype as any).versionsMetaForViewer;
    const originalSettings = (ArtifactService.prototype as any).shareSettings;
    const originalPinned = (ArtifactService.prototype as any).isPinned;
    const access = (kind: "editor" | "viewer") => ({ kind, role: kind, canManage: false, canContribute: kind === "editor", canBrowseVersions: true, canViewSource: kind === "editor", canDownload: true });
    (ArtifactService.prototype as any).getForViewer = async (_userId: string | null) => ({ artifact, access: _userId === "viewer-1" ? access("viewer") : access("editor") });
    (ArtifactService.prototype as any).viewerVersion = async (_userId: string | null) => ({ artifact, access: _userId === "viewer-1" ? access("viewer") : access("editor"), version: latest });
    (ArtifactService.prototype as any).versionsMetaForViewer = async () => versions;
    (ArtifactService.prototype as any).shareSettings = async () => ({ artifact, people: [{ user: owner, role: "owner" }], canManage: false });
    (ArtifactService.prototype as any).isPinned = async () => false;

    try {
      const editorBody = await (await appWithSession().handle(new Request("http://localhost/artifacts/artifact-1", { headers: requestHeaders() }))).text();
      const viewerBody = await (await appWithSession({ ...owner, id: "viewer-1", name: "Viewer", email: "viewer@example.com" }).handle(new Request("http://localhost/artifacts/artifact-1", { headers: requestHeaders() }))).text();

      expect(editorBody).toContain("Upload new version");
      expect(editorBody).toContain("View source");
      expect(editorBody).toContain("Download");
      expect(editorBody).not.toContain("Save name");
      expect(editorBody).not.toContain("Save access");
      expect(editorBody).not.toContain(">Delete</button>");
      expect(viewerBody).toContain("Version history");
      expect(viewerBody).toContain("Download");
      expect(viewerBody).toContain("Leave artifact");
      expect(viewerBody).not.toContain("View source");
      expect(viewerBody).not.toContain("Upload new version");
      expect(viewerBody).not.toContain("Save access");
      expect(viewerBody).not.toContain(">Delete</button>");
    } finally {
      (ArtifactService.prototype as any).getForViewer = originalViewer;
      (ArtifactService.prototype as any).viewerVersion = originalVersion;
      (ArtifactService.prototype as any).versionsMetaForViewer = originalVersions;
      (ArtifactService.prototype as any).shareSettings = originalSettings;
      (ArtifactService.prototype as any).isPinned = originalPinned;
    }
  });
});
