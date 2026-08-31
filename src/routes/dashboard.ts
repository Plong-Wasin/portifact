import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Auth } from "../auth";
import type { Config } from "../config";
import type { Database } from "../db/client";
import { ArtifactService, type ArtifactListItem, type ArtifactViewer, type PeopleWithAccess } from "../artifacts/service";
import { artifactHeaders, ARTIFACT_CSP, DomainError, escapeHtml, robotsMeta } from "../artifacts/domain";
import { contentMimeType, decodeContent, formatExtension, formatFromFilename, type ArtifactFormat } from "../artifacts/content";
import { renderPreview } from "../artifacts/renderer";

const csrfCookie = "portifact_csrf";
const csrfHeader = "x-csrf-token";
const DOCUMENT_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src https: data:",
  "font-src https: data:",
  "media-src https: data:",
  "connect-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function cookies(request: Request): Record<string, string> {
  return Object.fromEntries((request.headers.get("cookie") ?? "").split(/;\s*/).filter(Boolean).map((item) => {
    const index = item.indexOf("=");
    try {
      return [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
    } catch {
      return [item.slice(0, index), item.slice(index + 1)];
    }
  }));
}

function cspNonce(): string {
  return randomBytes(16).toString("base64");
}

const APP_CSS = `
:root {
  color-scheme: light;
  --canvas: #f4f7fb;
  --surface: rgba(255, 255, 255, .94);
  --surface-muted: #f8fafc;
  --ink: #142033;
  --muted: #64748b;
  --line: #e2e8f0;
  --primary: #5b4ce2;
  --primary-dark: #4338ca;
  --primary-soft: #eeecff;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
html { min-height: 100%; background: var(--canvas); }
body { min-height: 100vh; margin: 0; color: var(--ink); font-size: 16px; line-height: 1.6; background: radial-gradient(circle at 10% -5%, rgba(124,109,246,.2), transparent 34rem), radial-gradient(circle at 100% 0%, rgba(45,212,191,.12), transparent 30rem), var(--canvas); }
body::before { position: fixed; inset: 0; z-index: -1; content: ""; pointer-events: none; background: linear-gradient(135deg, rgba(255,255,255,.3), transparent 45%); }
.app-shell { min-height: 100vh; }
.site-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; max-width: 1120px; margin: 0 auto; padding: 1rem 1.5rem; }
.brand { display: inline-flex; align-items: center; gap: .7rem; color: var(--ink); font-size: 1.05rem; font-weight: 800; letter-spacing: -.02em; }
.brand:hover { color: var(--primary-dark); }
.brand-mark { display: grid; width: 2.25rem; height: 2.25rem; place-items: center; color: white; font-size: 1.1rem; font-weight: 900; background: linear-gradient(135deg, #7c6df6, #4f46e5); border-radius: .75rem; box-shadow: 0 8px 18px rgba(79,70,229,.25); }
.brand-note { color: var(--muted); font-size: .85rem; font-weight: 600; }
.page-content { max-width: 1120px; margin: 0 auto; padding: 1.25rem 1.5rem 4rem; }
main { display: grid; gap: 1.5rem; min-width: 0; width: min(100%, 920px); margin: 1.5rem auto; padding: clamp(1.25rem, 3vw, 2.25rem); background: var(--surface); border: 1px solid rgba(255,255,255,.8); border-radius: 1.75rem; box-shadow: 0 20px 60px rgba(30,41,59,.09), 0 2px 8px rgba(30,41,59,.04); backdrop-filter: blur(14px); }
main:has(form[action="/login/microsoft"]), main:has(form[action^="/api/auth/sign-in"]), main:has(form[action^="/api/auth/sign-up"]) { width: min(100%, 540px); }
h1, h2, h3, p { margin: 0; }
h1 { color: var(--ink); font-size: clamp(1.8rem, 4vw, 2.45rem); line-height: 1.15; letter-spacing: -.045em; }
h2 { font-size: 1.15rem; line-height: 1.25; letter-spacing: -.02em; }
p { color: var(--muted); }
.eyebrow { color: var(--primary-dark); font-size: .78rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
a { color: var(--primary-dark); font-weight: 700; text-decoration: none; transition: color .18s ease; }
a:hover { color: var(--primary); }
nav { display: flex; flex-wrap: wrap; gap: .55rem; padding-bottom: .25rem; }
nav a { padding: .48rem .78rem; color: var(--muted); font-size: .9rem; border: 1px solid transparent; border-radius: .75rem; }
nav a:hover, nav a.active { color: var(--primary-dark); background: var(--primary-soft); border-color: #ddd9ff; }
form { display: grid; gap: 1rem; padding: 1.1rem; background: var(--surface-muted); border: 1px solid var(--line); border-radius: 1.15rem; }
form.inline { display: inline-flex; align-items: center; padding: 0; background: transparent; border: 0; border-radius: 0; }
label { display: grid; gap: .4rem; color: var(--ink); font-size: .9rem; font-weight: 750; }
input, select { width: 100%; padding: .72rem .85rem; color: var(--ink); font: inherit; background: white; border: 1px solid #cbd5e1; border-radius: .75rem; outline: none; }
input:hover, select:hover { border-color: #94a3b8; }
input:focus, select:focus { border-color: #8175ee; box-shadow: 0 0 0 4px rgba(91,76,226,.13); }
input[type="file"] { padding: .55rem; background: white; border-style: dashed; }
button { display: inline-flex; align-items: center; justify-content: center; gap: .45rem; min-height: 2.55rem; padding: .58rem .9rem; color: white; font: inherit; font-weight: 750; background: linear-gradient(135deg, var(--primary), #7568ef); border: 0; border-radius: .78rem; box-shadow: 0 8px 16px rgba(91,76,226,.2); cursor: pointer; }
button:hover { filter: brightness(1.04); box-shadow: 0 11px 22px rgba(91,76,226,.27); }
button.secondary { color: var(--ink); background: white; border: 1px solid var(--line); box-shadow: none; }
button.danger { color: #991b1b; background: #fff1f2; border: 1px solid #fecdd3; box-shadow: none; }
button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 3px solid rgba(45,212,191,.45); outline-offset: 2px; }
button:disabled { opacity: .55; cursor: not-allowed; }
.section-heading, .dashboard-toolbar, .artifact-header-actions, .artifact-meta, .person-row, .version-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.dashboard-toolbar { align-items: flex-end; flex-wrap: wrap; }
.search-form { display: flex; flex: 1 1 20rem; gap: .6rem; padding: 0; background: transparent; border: 0; }
.search-form input { min-width: 0; }
.filter-tabs { display: flex; flex-wrap: wrap; gap: .45rem; }
.filter-tabs a { padding: .55rem .8rem; color: var(--muted); border: 1px solid var(--line); border-radius: .75rem; }
.filter-tabs a.active { color: var(--primary-dark); background: var(--primary-soft); border-color: #c8c2ff; }
.artifact-list, .people-list, .version-list { display: grid; gap: .7rem; padding: 0; margin: 0; list-style: none; }
.artifact-list-item { display: grid; gap: .45rem; padding: 1rem 1.1rem; background: white; border: 1px solid var(--line); border-radius: 1rem; }
.artifact-list-item:hover { border-color: #c8c2ff; box-shadow: 0 8px 24px rgba(79,70,229,.08); }
.artifact-list-item a.title { color: var(--ink); font-size: 1.05rem; }
.artifact-list-item a.title:hover { color: var(--primary-dark); }
.artifact-list-meta, .muted { color: var(--muted); font-size: .85rem; }
.badge { display: inline-flex; width: fit-content; align-items: center; padding: .18rem .55rem; color: var(--primary-dark); font-size: .72rem; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; background: var(--primary-soft); border-radius: 999px; }
.empty-state, .notice { padding: 1.15rem; color: var(--muted); background: var(--surface-muted); border: 1px dashed #cbd5e1; border-radius: 1rem; }
.error-state { padding: 1.15rem; color: #991b1b; background: #fff1f2; border: 1px solid #fecdd3; border-radius: 1rem; }
.artifact-site-header { max-width: none; padding: .55rem clamp(1rem, 3vw, 2rem); background: rgba(255,255,255,.78); border-bottom: 1px solid rgba(226,232,240,.9); box-shadow: 0 4px 18px rgba(30,41,59,.05); backdrop-filter: blur(14px); }
.artifact-site-header .brand-note { display: none; }
.artifact-header-actions { min-width: 0; flex: 1; justify-content: flex-end; }
.menu { position: relative; }
.menu summary { display: flex; align-items: center; gap: .45rem; max-width: min(42vw, 24rem); padding: .45rem .7rem; overflow: hidden; color: var(--ink); font-weight: 800; white-space: nowrap; text-overflow: ellipsis; background: transparent; border-radius: .7rem; cursor: pointer; list-style: none; }
.menu summary::-webkit-details-marker { display: none; }
.menu summary::after { content: "⌄"; color: var(--muted); font-size: .85rem; }
.menu[open] summary { background: var(--primary-soft); }
.share-trigger { color: white !important; background: linear-gradient(135deg, var(--primary), #7568ef) !important; }
.share-trigger::after { color: rgba(255,255,255,.8) !important; }
.menu-popover { position: absolute; z-index: 20; top: calc(100% + .5rem); right: 0; display: grid; gap: .7rem; width: min(90vw, 26rem); max-height: min(75vh, 42rem); padding: 1rem; overflow: auto; background: white; border: 1px solid var(--line); border-radius: 1rem; box-shadow: 0 18px 50px rgba(15,23,42,.16); }
.title-menu .menu-popover { left: 0; right: auto; width: min(90vw, 22rem); }
.menu-section { display: grid; gap: .55rem; }
.menu-section + .menu-section { padding-top: .7rem; border-top: 1px solid var(--line); }
.menu-section h3 { color: var(--muted); font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; }
.menu-item { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: .75rem; padding: .55rem .65rem; color: var(--ink); font-weight: 700; background: transparent; border: 0; border-radius: .6rem; box-shadow: none; }
.menu-item:hover { color: var(--primary-dark); background: var(--primary-soft); }
.menu-popover form { padding: .7rem; gap: .65rem; border-radius: .8rem; }
.menu-popover form.inline { padding: 0; }
.menu-popover label { font-size: .82rem; }
.person-row, .version-row { align-items: flex-start; padding: .65rem 0; border-bottom: 1px solid var(--line); }
.person-row:last-child, .version-row:last-child { border-bottom: 0; }
.person-details, .version-details { min-width: 0; display: grid; gap: .05rem; }
.person-details strong, .version-details strong { overflow-wrap: anywhere; }
.person-details span, .version-details span { color: var(--muted); font-size: .8rem; overflow-wrap: anywhere; }
.person-controls { display: flex; flex: 0 0 auto; align-items: center; gap: .35rem; }
.person-controls select { width: auto; min-width: 6.5rem; padding: .38rem .5rem; font-size: .8rem; }
.person-controls button { min-height: 2.1rem; padding: .35rem .55rem; font-size: .78rem; }
.artifact-workspace { display: grid; width: 100%; height: calc(100vh - 3.5rem); min-height: calc(100vh - 3.5rem); margin: 0; padding: .75rem clamp(.75rem, 2vw, 1.5rem) 1rem; overflow: hidden; background: transparent; border: 0; border-radius: 0; box-shadow: none; }
body:has(main.artifact-workspace) .page-content { max-width: none; padding: 0; }
.artifact-frame { width: 100%; height: 100%; min-height: 0; background: white; border: 1px solid var(--line); border-radius: 1rem; }
.copy-buffer { position: fixed; inset: -1000px; width: 1px; height: 1px; opacity: 0; }
code, pre { color: #312e81; background: var(--primary-soft); border-radius: .5rem; }
code { padding: .15rem .4rem; }
pre { padding: 1rem; overflow-x: auto; white-space: pre-wrap; }
.source-page { width: min(100%, 960px); }
.source-page pre { color: var(--ink); background: white; border: 1px solid var(--line); }
@media (max-width: 40rem) {
  .site-header { align-items: flex-start; padding-inline: 1rem; }
  .page-content { padding: .75rem 1rem 2rem; }
  main { margin: .75rem auto; border-radius: 1.25rem; }
  .artifact-site-header { align-items: center; padding: .5rem .75rem; }
  .artifact-site-header .brand { flex: 0 0 auto; }
  .artifact-header-actions { gap: .35rem; }
  .menu summary { max-width: 44vw; padding-inline: .45rem; }
  .menu-popover { position: fixed; top: auto; right: .65rem; bottom: .65rem; left: .65rem; width: auto; max-height: 80vh; padding: 1rem; border-radius: 1.25rem; }
  .title-menu .menu-popover { left: .65rem; width: auto; }
  .artifact-workspace { height: calc(100vh - 3.25rem); min-height: calc(100vh - 3.25rem); padding: .5rem; }
  .dashboard-toolbar { align-items: stretch; }
  .search-form { flex-basis: 100%; }
  .person-row { align-items: stretch; flex-direction: column; gap: .45rem; }
  .person-controls { justify-content: flex-end; }
}
`;

const COPY_SCRIPT = `
document.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest("[data-copy-url]");
  if (!(button instanceof HTMLButtonElement)) return;
  const value = button.dataset.copyUrl;
  if (!value) return;
  const original = button.textContent || "Copy link";
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      copied = true;
    }
  } catch {}
  if (!copied) {
    const input = document.createElement("textarea");
    input.value = value;
    input.setAttribute("readonly", "");
    input.className = "copy-buffer";
    document.body.append(input);
    input.select();
    try { copied = document.execCommand("copy"); } catch {}
    input.remove();
  }
  button.textContent = copied ? "Copied" : "Copy failed";
  if (copied) window.setTimeout(() => { button.textContent = original; }, 1800);
});
`;

function html(body: string, status = 200, headers = new Headers(), headerContent = "", formActionOrigin?: string): Response {
  const nonce = cspNonce();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", [
    "default-src 'self'",
    `script-src 'self' https://static.cloudflareinsights.com 'nonce-${nonce}'`,
    "connect-src 'self' https://cloudflareinsights.com",
    `style-src 'nonce-${nonce}'`,
    "style-src-attr 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    `form-action ${["'self'", ...(formActionOrigin ? [formActionOrigin] : []), "https://login.microsoftonline.com"].join(" ")}`,
  ].join("; "));
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  const headerClass = headerContent ? "site-header artifact-site-header" : "site-header";
  const header = `<header class="${headerClass}"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">P</span><span>Portifact</span></a>${headerContent || '<span class="brand-note">Artifact workspace</span>'}</header>`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${robotsMeta()}<title>Portifact · Artifact workspace</title><style nonce="${nonce}">${APP_CSS}</style></head><body><div class="app-shell">${header}<div class="page-content">${body}</div></div><script nonce="${nonce}">${COPY_SCRIPT}</script></body></html>`, { status, headers });
}

function csrfToken(request: Request): string {
  const token = cookies(request)[csrfCookie];
  if (!token) throw new Response("CSRF token required", { status: 403 });
  return token;
}

async function verifyMutation(request: Request, config: Config): Promise<void> {
  const origin = request.headers.get("origin");
  if (origin && origin !== config.appUrl.origin) throw new Response("Forbidden", { status: 403 });
  const expected = csrfToken(request);
  let supplied = request.headers.get(csrfHeader);
  const contentType = request.headers.get("content-type") ?? "";
  if (!supplied && (contentType.startsWith("application/x-www-form-urlencoded") || contentType.startsWith("multipart/form-data"))) {
    supplied = (await request.clone().formData()).get("csrf")?.toString() ?? null;
  }
  if (!supplied || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new Response("CSRF token required", { status: 403 });
}

async function sessionUser(auth: Auth | undefined, request: Request) {
  if (!auth) return null;
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user ?? null;
}

function sessionRedirect(config: Config, location: string) {
  return new Response(null, { status: 302, headers: { Location: `${new URL(location, config.appUrl.origin)}` } });
}

function withCsrf(response: Response, request: Request, token = cookies(request)[csrfCookie] ?? crypto.randomUUID()) {
  if (cookies(request)[csrfCookie]) return response;
  response.headers.append("Set-Cookie", `${csrfCookie}=${encodeURIComponent(token)}; Path=/; SameSite=Lax; HttpOnly`);
  return response;
}

async function startMicrosoftLogin(request: Request, auth: Auth, config: Config): Promise<Response> {
  await verifyMutation(request, config);
  const form = await request.clone().formData();
  const callbackValue = form.get("callbackURL");
  const callbackURL = typeof callbackValue === "string" && callbackValue ? callbackValue : "/artifacts";
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  const response = await auth.handler(new Request(new URL("/api/auth/sign-in/social", request.url), {
    method: "POST",
    headers,
    body: JSON.stringify({ provider: "microsoft", callbackURL, errorCallbackURL: "/login/error" }),
  }));
  const location = response.headers.get("location");
  if (!response.ok || !location) return new Response("Unable to start sign-in", { status: 502 });
  const redirectHeaders = new Headers({ Location: location });
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const setCookies = getSetCookie ? getSetCookie.call(response.headers) : [];
  if (setCookies.length) for (const cookie of setCookies) redirectHeaders.append("Set-Cookie", cookie);
  else {
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) redirectHeaders.set("Set-Cookie", setCookie);
  }
  return new Response(null, { status: 303, headers: redirectHeaders });
}

function loginErrorPage(): Response {
  return html('<main><h1>Sign-in failed</h1><p>We could not complete sign-in. Please try again.</p><a href="/login">Try again</a></main>');
}

export function sourcePage(body: string): Response {
  const response = html(body);
  artifactHeaders(response.headers);
  return response;
}

function contentHeaders(format: ArtifactFormat): Headers {
  return artifactHeaders(new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": format === "html" ? ARTIFACT_CSP : DOCUMENT_CSP,
  }));
}

async function previewContent(format: ArtifactFormat, source: string): Promise<Response> {
  const preview = await renderPreview(format, source);
  const warning = preview.warnings.length
    ? `<aside role="status"><strong>Warning:</strong> ${preview.warnings.map(escapeHtml).join(" ")}</aside>`
    : "";
  return new Response(`${warning}${preview.html}`, { headers: contentHeaders(format) });
}

function downloadName(name: string, format: ArtifactFormat): string {
  const safeName = name.replace(/[\\/\r\n"\u0000-\u001f\u007f]+/g, "_").trim() || "artifact";
  return `${safeName}${formatExtension(format)}`;
}

export function previewSandbox(format: ArtifactFormat): string {
  return format === "html" ? `sandbox="allow-scripts"` : "sandbox";
}

function canonicalLink(config: Config, artifactId: string): string {
  return new URL(`/artifacts/${encodeURIComponent(artifactId)}`, config.appUrl.origin).toString();
}

function displayAccess(kind: string): string {
  return ({ owner: "Owner", editor: "Editor", viewer: "Viewer", general: "Preview access" } as Record<string, string>)[kind] ?? "Preview access";
}

function displayGeneralAccess(mode: string): string {
  return ({ only_people_with_access: "Only people with access", everyone_with_login: "Everyone with login", anyone_with_the_link: "Anyone with the link" } as Record<string, string>)[mode] ?? mode;
}

function renderTitleMenu(viewer: ArtifactViewer, versions: Array<{ id: string; ordinal: number }>, csrf: string, pinned: boolean, canPin: boolean, selectedVersionId: string): string {
  const artifactId = encodeURIComponent(viewer.artifact.id);
  const canBrowse = viewer.access.canBrowseVersions;
  const versionLinks = canBrowse && versions.length
    ? `<div class="menu-section"><h3>Version history</h3>${versions.map((version) => `<a class="menu-item" href="/artifacts/${artifactId}?version=${encodeURIComponent(version.id)}"><span>Version ${version.ordinal}</span>${version.id === viewer.artifact.latestVersionId ? '<span class="badge">Latest</span>' : ""}</a>`).join("")}</div>`
    : "";
  const versionActions = viewer.access.canViewSource || viewer.access.canDownload
    ? `<div class="menu-section"><h3>Current version</h3>${viewer.access.canViewSource ? `<a class="menu-item" href="/artifacts/${artifactId}/source?version=${encodeURIComponent(selectedVersionId)}">View source</a>` : ""}${viewer.access.canDownload ? `<a class="menu-item" href="/artifacts/${artifactId}/download?version=${encodeURIComponent(selectedVersionId)}">Download</a>` : ""}</div>`
    : "";
  const upload = viewer.access.canContribute
    ? `<div class="menu-section"><h3>New version</h3><form method="post" action="/artifacts/${artifactId}/versions" enctype="multipart/form-data"><label>Upload ${escapeHtml(viewer.artifact.format)} file<input name="file" type="file" required></label><input type="hidden" name="parent_version_id" value="${escapeHtml(viewer.artifact.latestVersionId ?? "")}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button>Upload new version</button></form></div>`
    : "";
  const rename = viewer.access.canManage
    ? `<div class="menu-section"><h3>Rename</h3><form method="post" action="/artifacts/${artifactId}/rename"><label>Artifact name<input name="name" value="${escapeHtml(viewer.artifact.name)}" required maxlength="200"></label><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button>Save name</button></form></div>`
    : "";
  const pin = canPin ? `<form method="post" action="/artifacts/${artifactId}/${pinned ? "unpin" : "pin"}" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="menu-item" type="submit">${pinned ? "Unpin" : "Pin"}</button></form>` : "";
  const leave = viewer.access.kind !== "owner" && viewer.access.kind !== "general"
    ? `<form method="post" action="/artifacts/${artifactId}/leave" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="menu-item" type="submit">Leave artifact</button></form>`
    : "";
  const remove = viewer.access.canManage
    ? `<form method="post" action="/artifacts/${artifactId}/delete" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="menu-item danger" type="submit">Delete</button></form>`
    : "";
  return `<details class="menu title-menu"><summary class="artifact-title" data-artifact-link="/artifacts/${artifactId}">${escapeHtml(viewer.artifact.name)}</summary><div class="menu-popover"><div class="menu-section"><h3>Access</h3><span class="muted">${displayAccess(viewer.access.kind)}</span></div>${rename}${upload}${versionLinks}${versionActions}<div class="menu-section">${pin}${leave}${remove}</div></div></details>`;
}

function personRow(artifactId: string, person: PeopleWithAccess, canManage: boolean, csrf: string): string {
  const role = person.role === "owner" ? "Owner" : person.role === "editor" ? "Editor" : "Viewer";
  if (person.role === "owner" || !canManage) return `<li class="person-row"><span class="person-details"><strong>${escapeHtml(person.user.name)}</strong><span>${escapeHtml(person.user.email)}</span></span><span class="badge">${role}</span></li>`;
  const encodedUserId = encodeURIComponent(person.user.id);
  return `<li class="person-row"><span class="person-details"><strong>${escapeHtml(person.user.name)}</strong><span>${escapeHtml(person.user.email)}</span></span><span class="person-controls"><form method="post" action="/artifacts/${artifactId}/access/${encodedUserId}" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><select name="role" aria-label="Role for ${escapeHtml(person.user.name)}"><option value="viewer" ${person.role === "viewer" ? "selected" : ""}>View</option><option value="editor" ${person.role === "editor" ? "selected" : ""}>Edit</option></select><button>Save</button></form><form method="post" action="/artifacts/${artifactId}/access/${encodedUserId}/remove" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="danger" aria-label="Remove ${escapeHtml(person.user.name)}">Remove</button></form></span></li>`;
}

function renderShareMenu(config: Config, viewer: ArtifactViewer, people: PeopleWithAccess[], versions: Array<{ id: string; ordinal: number }>, csrf: string, peopleQuery: string, searchResults: Array<{ id: string; name: string; email: string }>): string {
  const artifactId = encodeURIComponent(viewer.artifact.id);
  const link = canonicalLink(config, viewer.artifact.id);
  const canManage = viewer.access.canManage;
  const search = canManage
    ? `<form method="get" action="/artifacts/${artifactId}"><label>Search for people to invite<input name="people" value="${escapeHtml(peopleQuery)}" placeholder="Name or email"></label><button class="secondary">Search</button></form>${searchResults.length ? `<ul class="people-list">${searchResults.map((person) => `<li class="person-row"><span class="person-details"><strong>${escapeHtml(person.name)}</strong><span>${escapeHtml(person.email)}</span></span><form method="post" action="/artifacts/${artifactId}/access/${encodeURIComponent(person.id)}" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><select name="role" aria-label="Role for ${escapeHtml(person.name)}"><option value="viewer">View</option><option value="editor">Edit</option></select><button>Add</button></form></li>`).join("")}</ul>` : ""}`
    : "";
  const peopleBlock = people.length ? `<ul class="people-list">${people.map((person) => personRow(artifactId, person, canManage, csrf)).join("")}</ul>` : `<p class="empty-state">No people have access yet.</p>`;
  const general = canManage
    ? `<form method="post" action="/artifacts/${artifactId}/general-access"><label>General access<select name="general_access"><option value="only_people_with_access" ${viewer.artifact.generalAccess === "only_people_with_access" ? "selected" : ""}>Only people with access</option><option value="everyone_with_login" ${viewer.artifact.generalAccess === "everyone_with_login" ? "selected" : ""}>Everyone with login</option><option value="anyone_with_the_link" ${viewer.artifact.generalAccess === "anyone_with_the_link" ? "selected" : ""}>Anyone with the link</option></select></label><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button>Save access</button></form>`
    : `<p class="muted">${displayGeneralAccess(viewer.artifact.generalAccess)}</p>`;
  const sharedVersion = canManage && viewer.artifact.generalAccess !== "only_people_with_access"
    ? `<form method="post" action="/artifacts/${artifactId}/shared-version"><label>Shared version<select name="version"><option value="latest" ${viewer.artifact.sharedVersionId ? "" : "selected"}>Latest</option>${versions.map((version) => `<option value="${escapeHtml(version.id)}" ${viewer.artifact.sharedVersionId === version.id ? "selected" : ""}>Version ${version.ordinal}</option>`).join("")}</select></label><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button>Save shared version</button></form>`
    : `<p class="muted">Shared version applies only to broader General access.</p>`;
  return `<details class="menu"><summary class="share-trigger">Share</summary><div class="menu-popover"><div class="menu-section"><h3>Artifact link</h3><code class="share-url">${escapeHtml(link)}</code><button type="button" data-copy-url="${escapeHtml(link)}">Copy link</button></div><div class="menu-section"><h3>People with access</h3>${search}${peopleBlock}</div><div class="menu-section"><h3>General access</h3>${general}${sharedVersion}</div></div></details>`;
}

function artifactPreviewBody(viewer: ArtifactViewer, versionId: string): string {
  const frameSrc = `/artifacts/${encodeURIComponent(viewer.artifact.id)}/content?version=${encodeURIComponent(versionId)}`;
  return `<main class="artifact-workspace" aria-label="Artifact preview" data-access-kind="${escapeHtml(viewer.access.kind)}"><iframe class="artifact-frame" ${previewSandbox(viewer.artifact.format)} src="${escapeHtml(frameSrc)}" title="${escapeHtml(viewer.artifact.name)} Preview"></iframe></main>`;
}

function errorResponse(error: unknown, artifactResponse = false): Response {
  if (error instanceof Response) return error;
  const status = error instanceof DomainError ? error.status : 500;
  const message = error instanceof DomainError && error.code === "LOGIN_REQUIRED" ? "Sign in to view this Artifact." : status === 404 ? "Not Found" : error instanceof DomainError ? error.message : "Internal Server Error";
  const headers = artifactResponse ? artifactHeaders(new Headers()) : new Headers();
  if (status === 500) return new Response("Internal Server Error", { status, headers });
  return new Response(message, { status, headers });
}

export function registerDashboardRoutes(app: any, db: Database, config: Config, auth?: Auth) {
  const service = new ArtifactService(db, config);
  const page = (body: string, status = 200, headers = new Headers(), headerContent = "") => html(body, status, headers, headerContent, config.appUrl.origin);
  const artifactPage = (body: string, headerContent: string, status = 200) => {
    const response = page(body, status, new Headers(), headerContent);
    artifactHeaders(response.headers);
    return response;
  };
  app.get("/", async ({ request }: { request: Request }) => sessionRedirect(config, (await sessionUser(auth, request)) ? "/artifacts" : "/login"));
  app.get("/login", ({ request }: { request: Request }) => {
    const token = cookies(request)[csrfCookie] ?? crypto.randomUUID();
    const loginURL = new URL(request.url);
    const requestedReturnTo = loginURL.searchParams.get("returnTo");
    const returnTo = requestedReturnTo?.startsWith("/") && !requestedReturnTo.startsWith("//") ? requestedReturnTo : "/artifacts";
    const callbackURL = loginURL.searchParams.has("client_id") && loginURL.searchParams.has("redirect_uri") ? `/api/auth/mcp/authorize${loginURL.search}` : returnTo;
    const body = config.microsoft
      ? `<main><h1>Sign in</h1><p>Only a Microsoft identity from your configured Organization is accepted.</p><form method="post" action="/login/microsoft"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><input type="hidden" name="callbackURL" value="${escapeHtml(callbackURL)}"><button type="submit">Sign in with Microsoft</button></form></main>`
      : `<main><h1>Sign in</h1><form method="post" action="/api/auth/sign-in/email"><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form>${config.registrationEnabled ? '<a href="/register">Create an account</a>' : ""}</main>`;
    return withCsrf(page(body), request, token);
  });
  app.get("/error", loginErrorPage);
  app.post("/login/microsoft", async ({ request }: { request: Request }) => {
    if (!auth || !config.microsoft) return new Response("Not Found", { status: 404 });
    return startMicrosoftLogin(request, auth, config);
  });
  app.get("/login/error", loginErrorPage);
  app.get("/register", ({ request }: { request: Request }) => config.registrationEnabled && !config.microsoft ? withCsrf(page(`<main><h1>Create account</h1><form method="post" action="/api/auth/sign-up/email"><label>Name<input name="name" required></label><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="new-password" minlength="8" required></label><button>Create account</button></form><a href="/login">Sign in</a></main>`), request) : new Response("Not Found", { status: 404 }));
  app.get("/account", async ({ request }: { request: Request }) => {
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    const identityStatus = config.microsoft ? "Microsoft identity authenticated" : current.emailVerified ? "email verified" : "email unverified";
    return page(`<main><h1>Account</h1><p>${escapeHtml(current.name)} — ${escapeHtml(current.email)} (${identityStatus})</p><form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(cookies(request)[csrfCookie] ?? "")}"><button>Log out</button></form></main>`);
  });
  app.post("/logout", async ({ request }: { request: Request }) => {
    await verifyMutation(request, config);
    if (auth) await auth.api.signOut({ headers: request.headers });
    return sessionRedirect(config, "/login");
  });
  app.get("/artifacts", async ({ request }: { request: Request }) => {
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    const query = new URL(request.url).searchParams;
    const rawFilter = query.get("filter");
    const filter = rawFilter === "yours" || rawFilter === "shared" ? rawFilter : "all";
    const search = query.get("q") ?? "";
    const rows = await service.listForUser(current.id, filter, search);
    const token = cookies(request)[csrfCookie] ?? crypto.randomUUID();
    const filterLink = (value: string, label: string) => `<a class="${filter === value ? "active" : ""}" href="/artifacts?filter=${value}${search ? `&q=${encodeURIComponent(search)}` : ""}">${label}</a>`;
    const list = rows.length ? `<ul class="artifact-list">${rows.map((row: ArtifactListItem) => `<li class="artifact-list-item"><div class="section-heading"><a class="title" data-artifact-link="/artifacts/${encodeURIComponent(row.id)}" href="/artifacts/${encodeURIComponent(row.id)}">${escapeHtml(row.name)}</a>${row.pinned ? '<span class="badge">Pinned</span>' : ""}</div><div class="artifact-list-meta">${escapeHtml(row.format)} · ${row.accessRole === "owner" ? "Yours" : `Shared by ${escapeHtml(row.ownerName)} (${escapeHtml(row.ownerEmail)}) · ${row.accessRole === "editor" ? "Editor" : "Viewer"}`} · Updated ${row.updatedAt.toISOString()}</div></li>`).join("")}</ul>` : `<div class="empty-state">${search ? "No Artifacts match your search." : filter === "shared" ? "No Artifacts have been shared with you." : filter === "yours" ? "You don’t have any Artifacts yet." : "No Artifacts yet."}</div>`;
    return withCsrf(page(`<main><div class="section-heading"><div><p class="eyebrow">Workspace</p><h1>Artifacts</h1></div><a href="/artifacts/new">New artifact</a></div><div class="dashboard-toolbar"><form class="search-form" method="get" action="/artifacts"><input name="q" value="${escapeHtml(search)}" placeholder="Search artifacts" aria-label="Search artifacts"><input type="hidden" name="filter" value="${escapeHtml(filter)}"><button>Search</button></form><div class="filter-tabs">${filterLink("all", "All")}${filterLink("yours", "Yours")}${filterLink("shared", "Shared with you")}</div></div>${list}<nav><a href="/trash">Trash</a><a href="/account">Account</a><a href="/connections">Connections</a></nav><span data-csrf="${escapeHtml(token)}"></span></main>`), request, token);
  });
  app.get("/artifacts/new", async ({ request }: { request: Request }) => {
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    const token = cookies(request)[csrfCookie] ?? crypto.randomUUID();
    return withCsrf(page(`<main><a href="/artifacts">Back to artifacts</a><h1>New artifact</h1><p>Supported files: .html, .md, and .txt. New Artifacts are private until General access changes.</p><form method="post" action="/artifacts" enctype="multipart/form-data"><label>Name<input name="name" required maxlength="200"></label><label>Artifact file<input name="file" type="file" accept=".html,.md,.txt,text/html,text/markdown,text/plain" required></label><input type="hidden" name="csrf" value="${escapeHtml(token)}"><button>Create artifact</button></form></main>`), request, token);
  });
  app.post("/artifacts", async ({ request }: { request: Request }) => {
    await verifyMutation(request, config);
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    const form = await request.formData();
    const name = form.get("name");
    const file = form.get("file");
    if (!(file instanceof File)) return new Response("Artifact file required", { status: 400 });
    try {
      const created = await service.create(current.id, name, decodeContent(new Uint8Array(await file.arrayBuffer()), config.maxContentBytes), formatFromFilename(file.name));
      return sessionRedirect(config, `/artifacts/${created.artifact.id}`);
    } catch (error) {
      return errorResponse(error);
    }
  });
  app.get("/artifacts/:id", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    const current = await sessionUser(auth, request);
    try {
      const viewer = await service.getForViewer(current?.id ?? null, params.id);
      const requestedVersion = new URL(request.url).searchParams.get("version") ?? undefined;
      const selected = await service.viewerVersion(current?.id ?? null, params.id, requestedVersion);
      const versions = viewer.access.canBrowseVersions && current ? await service.versionsMetaForViewer(current.id, params.id) : [];
      const settings = current ? await service.shareSettings(current.id, params.id) : undefined;
      const pinned = current ? await service.isPinned(current.id, params.id) : false;
      const token = cookies(request)[csrfCookie] ?? crypto.randomUUID();
      const peopleQuery = new URL(request.url).searchParams.get("people") ?? "";
      const searchResults = current && viewer.access.canManage ? await service.searchInternalUsers(current.id, peopleQuery) : [];
      const titleMenu = renderTitleMenu(viewer, versions, token, pinned, Boolean(current), selected.version.id);
      const shareMenu = current ? renderShareMenu(config, viewer, settings?.people ?? [], versions, token, peopleQuery, searchResults) : "";
      const header = `<div class="artifact-header-actions">${titleMenu}<span class="badge">${escapeHtml(displayAccess(viewer.access.kind))}</span>${shareMenu}</div>`;
      return withCsrf(artifactPage(artifactPreviewBody(viewer, selected.version.id), header), request, token);
    } catch (error) {
      if (error instanceof DomainError && error.code === "LOGIN_REQUIRED") return sessionRedirect(config, `/login?returnTo=${encodeURIComponent(`/artifacts/${params.id}`)}`);
      return errorResponse(error, true);
    }
  });
  app.get("/artifacts/:id/content", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    const current = await sessionUser(auth, request);
    try {
      const selected = await service.viewerVersion(current?.id ?? null, params.id, new URL(request.url).searchParams.get("version") ?? undefined);
      return previewContent(selected.artifact.format, selected.version.content);
    } catch (error) {
      return errorResponse(error, true);
    }
  });
  app.get("/artifacts/:id/source", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    try {
      const selected = await service.viewerVersion(current.id, params.id, new URL(request.url).searchParams.get("version") ?? undefined);
      if (!selected.access.canViewSource) throw new DomainError("SOURCE_FORBIDDEN", "source access forbidden", 403);
      return sourcePage(`<main class="source-page"><p><a href="/artifacts/${encodeURIComponent(params.id)}?version=${encodeURIComponent(selected.version.id)}">Back to preview</a></p><p class="eyebrow">Source view</p><h1>${escapeHtml(selected.artifact.name)} · Version ${selected.version.ordinal}</h1><pre>${escapeHtml(selected.version.content)}</pre></main>`);
    } catch (error) {
      return errorResponse(error, true);
    }
  });
  app.get("/artifacts/:id/download", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    try {
      const selected = await service.viewerVersion(current.id, params.id, new URL(request.url).searchParams.get("version") ?? undefined);
      if (!selected.access.canDownload) throw new DomainError("DOWNLOAD_FORBIDDEN", "download access forbidden", 403);
      const filename = downloadName(selected.artifact.name, selected.artifact.format);
      return new Response(selected.version.content, { headers: artifactHeaders(new Headers({ "Content-Type": contentMimeType(selected.artifact.format), "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}` })) });
    } catch (error) {
      return errorResponse(error, true);
    }
  });
  for (const retiredVersionPath of [
    "/artifacts/:id/versions/:versionId/preview",
    "/artifacts/:id/versions/:versionId/source",
    "/artifacts/:id/versions/:versionId/download",
  ]) {
    app.get(retiredVersionPath, () => new Response("Not Found", { status: 404 }));
  }
  app.post("/artifacts/:id/rename", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    try { await service.rename(current.id, params.id, (await request.formData()).get("name")); return sessionRedirect(config, `/artifacts/${params.id}`); } catch (error) { return errorResponse(error); }
  });
  app.post("/artifacts/:id/versions", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    try {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new DomainError("ARTIFACT_FILE_REQUIRED", "artifact file required");
      const parentId = String(form.get("parent_version_id") ?? "");
      const created = await service.createVersion(current.id, params.id, parentId, decodeContent(new Uint8Array(await file.arrayBuffer()), config.maxContentBytes), formatFromFilename(file.name), "dashboard");
      return sessionRedirect(config, `/artifacts/${params.id}?version=${encodeURIComponent(created.version.id)}`);
    } catch (error) { return errorResponse(error); }
  });
  app.post("/artifacts/:id/access/:userId", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    try { await service.grantAccess(current.id, params.id, params.userId, (await request.formData()).get("role")); return sessionRedirect(config, `/artifacts/${params.id}`); } catch (error) { return errorResponse(error); }
  });
  app.post("/artifacts/:id/access/:userId/remove", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    try { await service.removeAccess(current.id, params.id, params.userId); return sessionRedirect(config, `/artifacts/${params.id}`); } catch (error) { return errorResponse(error); }
  });
  app.post("/artifacts/:id/leave", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    try { await service.leaveAccess(current.id, params.id); return sessionRedirect(config, "/artifacts"); } catch (error) { return errorResponse(error); }
  });
  app.post("/artifacts/:id/general-access", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    try { await service.setGeneralAccess(current.id, params.id, (await request.formData()).get("general_access")); return sessionRedirect(config, `/artifacts/${params.id}`); } catch (error) { return errorResponse(error); }
  });
  app.post("/artifacts/:id/shared-version", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    try { await service.setSharedVersion(current.id, params.id, (await request.formData()).get("version")); return sessionRedirect(config, `/artifacts/${params.id}`); } catch (error) { return errorResponse(error); }
  });
  app.post("/artifacts/:id/pin", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    try { await service.pin(current.id, params.id); return sessionRedirect(config, `/artifacts/${params.id}`); } catch (error) { return errorResponse(error); }
  });
  app.post("/artifacts/:id/unpin", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    try { await service.unpin(current.id, params.id); return sessionRedirect(config, `/artifacts/${params.id}`); } catch (error) { return errorResponse(error); }
  });
  app.post("/artifacts/:id/delete", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    try { await service.remove(current.id, params.id); return sessionRedirect(config, "/artifacts"); } catch (error) { return errorResponse(error); }
  });
  app.get("/trash", async ({ request }: { request: Request }) => {
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    const rows = await service.trash(current.id);
    const token = cookies(request)[csrfCookie] ?? crypto.randomUUID();
    return withCsrf(page(`<main><nav><a href="/artifacts">Artifacts</a><a href="/account">Account</a></nav><h1>Trash</h1><ul class="artifact-list">${rows.map((row) => `<li class="artifact-list-item"><div class="section-heading"><strong>${escapeHtml(row.name)}</strong><form method="post" action="/artifacts/${encodeURIComponent(row.id)}/restore" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><button>Restore</button></form></div><span class="muted">Deleted ${row.deletedAt?.toISOString() ?? ""}</span></li>`).join("") || "<li class=\"empty-state\">Trash is empty.</li>"}</ul></main>`), request, token);
  });
  app.post("/artifacts/:id/restore", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    try { await service.restore(current.id, params.id); return sessionRedirect(config, `/artifacts/${params.id}`); } catch (error) { return errorResponse(error); }
  });
  app.get("/connections", async ({ request }: { request: Request }) => {
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    const rows = await service.connections(current.id);
    const token = cookies(request)[csrfCookie] ?? crypto.randomUUID();
    return withCsrf(page(`<main><nav><a href="/artifacts">Artifacts</a><a href="/account">Account</a></nav><h1>Connected applications</h1><ul class="artifact-list">${rows.map((row) => `<li class="artifact-list-item">${escapeHtml(row.name ?? row.clientId)} — ${row.disabled ? "revoked" : "active"}<form method="post" action="/connections/${encodeURIComponent(row.clientId)}/revoke" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><button ${row.disabled ? "disabled" : ""}>Revoke</button></form></li>`).join("") || "<li class=\"empty-state\">No connected applications.</li>"}</ul></main>`), request, token);
  });
  app.post("/connections/:clientId/revoke", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const current = await sessionUser(auth, request);
    if (!current) return sessionRedirect(config, "/login");
    try { await service.revokeClient(current.id, decodeURIComponent(params.clientId)); } catch { return new Response("Not Found", { status: 404 }); }
    return sessionRedirect(config, "/connections");
  });
  return app;
}
