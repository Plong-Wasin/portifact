import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { ArtifactService } from "../src/artifacts/service";
import { config } from "./helpers";

const chrome = Bun.env.CHROME_PATH ?? "/usr/bin/google-chrome";
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

function browserScript(menu: "title" | "share", nonce: string): string {
  const selectors = {
    title: { summary: ".title-menu > summary", popover: ".title-menu > .menu-popover" },
    share: { summary: ".artifact-header-actions > .menu > summary", popover: ".artifact-header-actions > .menu > .menu-popover" },
  }[menu];
  return `<script nonce="${nonce}">try { const brand = document.querySelector(".artifact-site-header .brand"); const title = document.querySelector(".artifact-title"); const actions = document.querySelector(".artifact-header-actions"); const summary = document.querySelector("${selectors.summary}"); summary.click(); const menu = document.querySelector("${selectors.popover}"); const nested = [...menu.querySelectorAll(".menu-submenu")]; const initiallyClosed = nested.length > 0 && nested.every((section) => !section.open); const nestedInteractions = nested.map((section) => { const content = section.querySelector(".menu-submenu-content"); const initiallyHidden = !section.open && (content?.getBoundingClientRect().height ?? 0) === 0; const ancestors = []; let ancestor = section.parentElement?.closest(".menu-submenu"); while (ancestor) { ancestors.unshift(ancestor); ancestor = ancestor.parentElement?.closest(".menu-submenu"); } ancestors.forEach((parent) => { if (!parent.open) parent.querySelector("summary")?.click(); }); const sectionSummary = section.querySelector("summary"); sectionSummary?.click(); const opened = section.open && (content?.getBoundingClientRect().height ?? 0) > 0; const confirmationVisible = !section.classList.contains("danger-submenu") || (content?.textContent?.includes("Move this Artifact to Trash?") && opened); sectionSummary?.click(); ancestors.reverse().forEach((parent) => { if (parent.open) parent.querySelector("summary")?.click(); }); return { initiallyHidden, opened, confirmationVisible, closed: !section.open }; }); const nestedVisible = initiallyClosed && nestedInteractions.length > 0 && nestedInteractions.every((result) => result.initiallyHidden && result.opened && result.confirmationVisible && result.closed); const copyButton = menu.querySelector("[data-copy-url]"); if (copyButton) { try { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.resolve() } }); } catch {} copyButton.click(); window.setTimeout(() => { document.body.dataset.copyResult = /^(Copied|Copy failed)$/.test(copyButton.textContent || "") ? "pass" : "fail"; }, 0); } else document.body.dataset.copyResult = "pass"; const rect = menu.getBoundingClientRect(); const x = Math.min(Math.max(rect.left + rect.width / 2, 8), document.documentElement.clientWidth - 8); const y = Math.min(Math.max(rect.top + rect.height / 2, 8), document.documentElement.clientHeight - 8); const target = document.elementFromPoint(x, y); const visible = rect.top >= 0 && rect.left >= 0 && rect.right <= document.documentElement.clientWidth && rect.bottom <= document.documentElement.clientHeight; const abovePreview = target?.closest(".menu-popover") === menu; const titleOnLeft = title.getBoundingClientRect().left < actions.getBoundingClientRect().left && title.getBoundingClientRect().left >= brand.getBoundingClientRect().left; document.body.dataset.menuResult = visible && abovePreview ? "pass" : "fail"; document.body.dataset.titlePosition = titleOnLeft ? "pass" : "fail"; document.body.dataset.nestedResult = nestedVisible ? "pass" : "fail"; } catch (error) { document.body.dataset.menuResult = "error:" + error; }</script>`;
}

async function menuResult(width: number, height: number, menu: "title" | "share"): Promise<{ menu: string; title: string; nested: string; copy: string }> {
  const originalViewer = (ArtifactService.prototype as any).getForViewer;
  const originalVersion = (ArtifactService.prototype as any).viewerVersion;
  const originalVersions = (ArtifactService.prototype as any).versionsMetaForViewer;
  const originalSettings = (ArtifactService.prototype as any).shareSettings;
  const originalPinned = (ArtifactService.prototype as any).isPinned;
  const access = { kind: "owner", canManage: true, canContribute: true, canBrowseVersions: true, canViewSource: true, canDownload: true };
  (ArtifactService.prototype as any).getForViewer = async () => ({ artifact, access });
  (ArtifactService.prototype as any).viewerVersion = async () => ({ artifact, access, version: latest });
  (ArtifactService.prototype as any).versionsMetaForViewer = async () => versions;
  (ArtifactService.prototype as any).shareSettings = async () => ({ artifact, access, people: [{ user: owner, role: "owner" }], canManage: true });
  (ArtifactService.prototype as any).isPinned = async () => false;

  const app = createApp({} as never, config(), { api: { getSession: async () => ({ user: owner }) } } as never);
  try {
    const response = await app.handle(new Request("http://127.0.0.1/artifacts/artifact-1"));
    const body = await response.text();
    const nonce = response.headers.get("content-security-policy")?.match(/nonce-([^'; ]+)/)?.[1];
    if (!nonce) throw new Error("Artifact response did not expose a script nonce");
    const instrumented = body.replace("</body>", `${browserScript(menu, nonce)}</body>`);
    const browserServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => new URL(request.url).pathname.endsWith("/content")
        ? new Response("<h1>Preview</h1>", { headers: { "content-type": "text/html" } })
        : new Response(instrumented, { headers: response.headers }),
    });
    try {
      const browser = Bun.spawn([chrome, "--headless", "--no-sandbox", "--disable-gpu", "--run-all-compositor-stages-before-draw", "--virtual-time-budget=1000", `--window-size=${width},${height}`, "--dump-dom", `http://127.0.0.1:${browserServer.port}/artifacts/artifact-1`], { stdout: "pipe", stderr: "ignore" });
      const stdout = await new Response(browser.stdout).text();
      await browser.exited;
      return {
        menu: stdout.match(/data-menu-result="([^"]+)"/)?.[1] ?? "missing",
        title: stdout.match(/data-title-position="([^"]+)"/)?.[1] ?? "missing",
        nested: stdout.match(/data-nested-result="([^"]+)"/)?.[1] ?? "missing",
        copy: stdout.match(/data-copy-result="([^"]+)"/)?.[1] ?? "missing",
      };
    } finally {
      browserServer.stop(true);
    }
  } finally {
    (ArtifactService.prototype as any).getForViewer = originalViewer;
    (ArtifactService.prototype as any).viewerVersion = originalVersion;
    (ArtifactService.prototype as any).versionsMetaForViewer = originalVersions;
    (ArtifactService.prototype as any).shareSettings = originalSettings;
    (ArtifactService.prototype as any).isPinned = originalPinned;
  }
}

async function renameRequestOrigin(): Promise<{ actual: string | null; expected: string }> {
  const originalViewer = (ArtifactService.prototype as any).getForViewer;
  const originalVersion = (ArtifactService.prototype as any).viewerVersion;
  const originalVersions = (ArtifactService.prototype as any).versionsMetaForViewer;
  const originalSettings = (ArtifactService.prototype as any).shareSettings;
  const originalPinned = (ArtifactService.prototype as any).isPinned;
  const access = { kind: "owner", canManage: true, canContribute: true, canBrowseVersions: true, canViewSource: true, canDownload: true };
  (ArtifactService.prototype as any).getForViewer = async () => ({ artifact, access });
  (ArtifactService.prototype as any).viewerVersion = async () => ({ artifact, access, version: latest });
  (ArtifactService.prototype as any).versionsMetaForViewer = async () => versions;
  (ArtifactService.prototype as any).shareSettings = async () => ({ artifact, access, people: [{ user: owner, role: "owner" }], canManage: true });
  (ArtifactService.prototype as any).isPinned = async () => false;

  const app = createApp({} as never, config(), { api: { getSession: async () => ({ user: owner }) } } as never);
  try {
    const response = await app.handle(new Request("http://127.0.0.1/artifacts/artifact-1"));
    const body = await response.text();
    const nonce = response.headers.get("content-security-policy")?.match(/nonce-([^'; ]+)/)?.[1];
    if (!nonce) throw new Error("Artifact response did not expose a script nonce");
    const submitRename = `<script nonce="${nonce}">document.querySelector('form[action="/artifacts/artifact-1/rename"]')?.requestSubmit();</script>`;
    const instrumented = body.replace("</body>", `${submitRename}</body>`);
    let actual: string | null = null;
    const browserServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/artifacts/artifact-1/rename") {
          actual = request.headers.get("origin");
          return new Response("<!doctype html><title>Done</title>", { headers: { "content-type": "text/html" } });
        }
        if (url.pathname.endsWith("/content")) return new Response("<h1>Preview</h1>", { headers: { "content-type": "text/html" } });
        return new Response(instrumented, { headers: response.headers });
      },
    });
    try {
      const expected = browserServer.url.origin;
      const browser = Bun.spawn([chrome, "--headless", "--no-sandbox", "--disable-gpu", "--run-all-compositor-stages-before-draw", "--virtual-time-budget=1000", "--dump-dom", `${expected}/artifacts/artifact-1`], { stdout: "ignore", stderr: "ignore" });
      await browser.exited;
      return { actual, expected };
    } finally {
      browserServer.stop(true);
    }
  } finally {
    (ArtifactService.prototype as any).getForViewer = originalViewer;
    (ArtifactService.prototype as any).viewerVersion = originalVersion;
    (ArtifactService.prototype as any).versionsMetaForViewer = originalVersions;
    (ArtifactService.prototype as any).shareSettings = originalSettings;
    (ArtifactService.prototype as any).isPinned = originalPinned;
  }
}

describe.skipIf(!existsSync(chrome))("Artifact workspace browser layout", () => {
  test.serial("submits Rename with the workspace origin", async () => {
    const origin = await renameRequestOrigin();
    expect(origin.actual).toBe(origin.expected);
  }, { timeout: 15000 });

  test.serial("keeps the title on the left and title menus above the Preview at desktop and mobile sizes", async () => {
    const desktop = await menuResult(1024, 768, "title");
    const mobile = await menuResult(390, 844, "title");
    expect(desktop).toEqual({ menu: "pass", title: "pass", nested: "pass", copy: "pass" });
    expect(mobile).toEqual({ menu: "pass", title: "pass", nested: "pass", copy: "pass" });
  }, { timeout: 30000 });

  test.serial("keeps Share menus above the Preview at desktop and mobile sizes", async () => {
    const desktop = await menuResult(1024, 768, "share");
    const mobile = await menuResult(390, 844, "share");
    expect(desktop).toEqual({ menu: "pass", title: "pass", nested: "pass", copy: "pass" });
    expect(mobile).toEqual({ menu: "pass", title: "pass", nested: "pass", copy: "pass" });
  }, { timeout: 30000 });
});
