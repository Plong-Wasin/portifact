import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Auth } from "../auth";
import type { Config } from "../config";
import type { Database } from "../db/client";
import { ArtifactService, type ShareLinkInfo } from "../artifacts/service";
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
  --surface: rgba(255, 255, 255, .92);
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
body {
  min-height: 100vh;
  margin: 0;
  color: var(--ink);
  font-size: 16px;
  line-height: 1.6;
  background:
    radial-gradient(circle at 10% -5%, rgba(124, 109, 246, .2), transparent 34rem),
    radial-gradient(circle at 100% 0%, rgba(45, 212, 191, .12), transparent 30rem),
    var(--canvas);
}
body::before {
  position: fixed;
  inset: 0;
  z-index: -1;
  content: "";
  pointer-events: none;
  background: linear-gradient(135deg, rgba(255, 255, 255, .3), transparent 45%);
}
.app-shell { min-height: 100vh; }
.site-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  max-width: 1120px;
  margin: 0 auto;
  padding: 1.5rem 1.5rem .5rem;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: .75rem;
  color: var(--ink);
  font-size: 1.05rem;
  font-weight: 800;
  letter-spacing: -.02em;
}
.brand:hover { color: var(--primary-dark); }
.brand-mark {
  display: grid;
  width: 2.25rem;
  height: 2.25rem;
  place-items: center;
  color: white;
  font-size: 1.1rem;
  font-weight: 900;
  background: linear-gradient(135deg, #7c6df6, #4f46e5);
  border-radius: .75rem;
  box-shadow: 0 8px 18px rgba(79, 70, 229, .25);
}
.brand-note { color: var(--muted); font-size: .85rem; font-weight: 600; }
.page-content { max-width: 1120px; margin: 0 auto; padding: 1.25rem 1.5rem 4rem; }
main {
  display: grid;
  gap: 1.5rem;
  min-width: 0;
  width: min(100%, 880px);
  margin: 1.5rem auto;
  padding: clamp(1.25rem, 3vw, 2.25rem);
  background: var(--surface);
  border: 1px solid rgba(255, 255, 255, .8);
  border-radius: 1.75rem;
  box-shadow: 0 20px 60px rgba(30, 41, 59, .09), 0 2px 8px rgba(30, 41, 59, .04);
  backdrop-filter: blur(14px);
}
main:has(form[action="/login/microsoft"]),
main:has(form[action^="/api/auth/sign-in"]),
main:has(form[action^="/api/auth/sign-up"]) { width: min(100%, 540px); }
.preview-page {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  width: 100%;
  height: calc(100vh - 3.5rem);
  min-height: calc(100vh - 3.5rem);
  margin: 0;
  padding: 1rem clamp(1rem, 3vw, 2rem) 1.25rem;
  overflow: hidden;
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  backdrop-filter: none;
}
body:has(main.preview-page) .page-content { max-width: none; padding: 0; }
body:has(main.preview-page) .site-header {
  max-width: none;
  padding: .6rem clamp(1rem, 3vw, 2rem);
  background: rgba(255, 255, 255, .72);
  border-bottom: 1px solid rgba(226, 232, 240, .9);
  box-shadow: 0 4px 18px rgba(30, 41, 59, .05);
  backdrop-filter: blur(14px);
}
h1, h2, p { margin: 0; }
h1 { color: var(--ink); font-size: clamp(1.8rem, 4vw, 2.45rem); line-height: 1.15; letter-spacing: -.045em; }
h2 { font-size: 1.15rem; line-height: 1.25; letter-spacing: -.02em; }
p { color: var(--muted); }
.eyebrow { color: var(--primary-dark); font-size: .78rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
a { color: var(--primary-dark); font-weight: 700; text-decoration: none; transition: color .18s ease, transform .18s ease; }
a:hover { color: var(--primary); }
nav { display: flex; flex-wrap: wrap; gap: .55rem; padding-bottom: .25rem; }
nav a { padding: .48rem .78rem; color: var(--muted); font-size: .9rem; border: 1px solid transparent; border-radius: .75rem; }
nav a:hover { color: var(--primary-dark); background: var(--primary-soft); border-color: #ddd9ff; }
.section-heading, .preview-heading, .share-link-meta { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.section-heading { margin-top: .25rem; }
.share-links, .preview-warning, .result-link { display: grid; gap: .8rem; }
.preview-warning { padding: .85rem 1rem; color: #854d0e; background: #fffbeb; border: 1px solid #fde68a; border-radius: .9rem; }
.preview-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding-bottom: .75rem; border-bottom: 1px solid var(--line); }
.preview-toolbar h1 { font-size: clamp(1.15rem, 2.5vw, 1.6rem); letter-spacing: -.03em; }
.preview-actions { display: flex; flex-wrap: wrap; gap: .75rem; }
.preview-actions a { color: var(--muted); }
form { display: grid; gap: 1rem; padding: 1.1rem; background: var(--surface-muted); border: 1px solid var(--line); border-radius: 1.15rem; }
form.inline { display: inline; padding: 0; background: transparent; border: 0; border-radius: 0; }
label { display: grid; gap: .4rem; color: var(--ink); font-size: .9rem; font-weight: 750; }
input {
  width: 100%;
  padding: .72rem .85rem;
  color: var(--ink);
  font: inherit;
  background: white;
  border: 1px solid #cbd5e1;
  border-radius: .75rem;
  outline: none;
  transition: border-color .18s ease, box-shadow .18s ease;
}
input:hover { border-color: #94a3b8; }
input:focus { border-color: #8175ee; box-shadow: 0 0 0 4px rgba(91, 76, 226, .13); }
input[type="file"] { padding: .55rem; background: white; border-style: dashed; }
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: .45rem;
  min-height: 2.7rem;
  padding: .62rem 1rem;
  color: white;
  font: inherit;
  font-weight: 750;
  background: linear-gradient(135deg, var(--primary), #7568ef);
  border: 0;
  border-radius: .78rem;
  box-shadow: 0 8px 16px rgba(91, 76, 226, .2);
  cursor: pointer;
  transition: transform .18s ease, box-shadow .18s ease, filter .18s ease;
}
button:hover { filter: brightness(1.04); box-shadow: 0 11px 22px rgba(91, 76, 226, .27); transform: translateY(-1px); }
button:focus-visible, a:focus-visible, input:focus-visible { outline: 3px solid rgba(45, 212, 191, .45); outline-offset: 2px; }
button:disabled { opacity: .55; cursor: not-allowed; transform: none; }
.table-wrap { width: 100%; min-width: 0; overflow-x: auto; border-radius: 1rem; }
table { width: 100%; min-width: 720px; table-layout: fixed; overflow: hidden; background: white; border: 1px solid var(--line); border-radius: 1rem; border-spacing: 0; border-collapse: separate; }
th, td { padding: .85rem 1rem; text-align: left; vertical-align: top; overflow-wrap: anywhere; border-bottom: 1px solid var(--line); }
th:nth-child(1), td:nth-child(1) { width: 8%; }
th:nth-child(2), td:nth-child(2) { width: 9%; }
th:nth-child(3), td:nth-child(3) { width: 29%; }
th:nth-child(4), td:nth-child(4) { width: 14%; }
th:nth-child(5), td:nth-child(5) { width: 40%; }
th { color: var(--muted); font-size: .78rem; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; background: var(--surface-muted); }
tr:last-child td { border-bottom: 0; }
.digest, .share-url { display: block; max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
.digest { color: #312e81; font-size: .8rem; }
.version-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.version-actions a { white-space: nowrap; }
.version-actions form.inline { display: inline-flex; }
.version-actions button, .share-link-item button { min-height: 2.25rem; padding: .42rem .7rem; font-size: .85rem; }
ul { display: grid; gap: .65rem; padding: 0; margin: 0; list-style: none; }
li { padding: .9rem 1rem; background: white; border: 1px solid var(--line); border-radius: .9rem; }
.share-link-list { gap: .7rem; }
.share-link-item { display: grid; gap: .65rem; }
.share-link-item.revoked { background: var(--surface-muted); }
.share-link-item.revoked .share-url { color: var(--muted); }
.share-status { display: inline-flex; width: fit-content; padding: .2rem .55rem; color: #166534; font-size: .72rem; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; background: #dcfce7; border-radius: 999px; }
.share-status.revoked { color: #991b1b; background: #fee2e2; }
.share-status.unpublished { color: #854d0e; background: #fef3c7; }
.share-link-date { color: var(--muted); font-size: .82rem; }
.share-link-controls { display: flex; flex-wrap: wrap; align-items: center; gap: .65rem; }
.share-link-controls button { flex: 0 0 auto; }
.result-link { padding: 1rem; background: var(--primary-soft); border: 1px solid #ddd9ff; border-radius: 1rem; }
.result-link .share-url { margin: 0; }
.artifact-frame { width: 100%; height: 100%; min-height: 0; border: 1px solid var(--line); border-radius: 1rem; background: white; }
.copy-buffer { position: fixed; inset: -1000px; width: 1px; height: 1px; opacity: 0; }
code, pre { color: #312e81; background: var(--primary-soft); border-radius: .5rem; }
code { padding: .15rem .4rem; }
pre { padding: 1rem; overflow-x: auto; white-space: pre-wrap; }
.inline { display: inline; }
@media (max-width: 40rem) {
  .site-header { align-items: flex-start; padding-inline: 1rem; }
  .brand-note { display: none; }
  .page-content { padding: .75rem 1rem 2rem; }
  main { margin: .75rem auto; border-radius: 1.25rem; }
  main.preview-page { height: calc(100vh - 3.25rem); min-height: calc(100vh - 3.25rem); margin: 0; padding: .75rem; border-radius: 0; }
  .preview-toolbar { align-items: flex-start; flex-direction: column; gap: .65rem; }
  nav { gap: .35rem; }
  nav a { padding: .4rem .6rem; }
  table { min-width: 720px; }
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

function html(body: string, status = 200, headers = new Headers(), formActionOrigin?: string): Response {
  const nonce = cspNonce();
  const formActionSources = ["'self'", ...(formActionOrigin ? [formActionOrigin] : []), "https://login.microsoftonline.com"].join(" ");
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  // The local POST starts OAuth and redirects the browser to Microsoft's
  // authorization host. Keep form submissions same-origin otherwise, and
  // authorize only this response's inline style block.
  headers.set("Content-Security-Policy", [
    "default-src 'self'",
    `script-src 'self' https://static.cloudflareinsights.com 'nonce-${nonce}'`,
    "connect-src 'self' https://cloudflareinsights.com",
    `style-src 'nonce-${nonce}'`,
    "style-src-attr 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    `form-action ${formActionSources}`,
  ].join("; "));
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${robotsMeta()}<title>Portifact · Artifact workspace</title><style nonce="${nonce}">${APP_CSS}</style></head><body><div class="app-shell"><header class="site-header"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">P</span><span>Portifact</span></a><span class="brand-note">Artifact workspace</span></header><div class="page-content">${body}</div></div><script nonce="${nonce}">${COPY_SCRIPT}</script></body></html>`, { status, headers });
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
    body: JSON.stringify({
      provider: "microsoft",
      callbackURL,
      errorCallbackURL: "/login/error",
    }),
  }));
  const location = response.headers.get("location");
  if (!response.ok || !location) return new Response("Unable to start sign-in", { status: 502 });
  const redirectHeaders = new Headers({ Location: location });
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const setCookies = getSetCookie ? getSetCookie.call(response.headers) : [];
  if (setCookies.length) {
    for (const cookie of setCookies) redirectHeaders.append("Set-Cookie", cookie);
  } else {
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
  const headers = artifactHeaders(new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": format === "html" ? ARTIFACT_CSP : DOCUMENT_CSP,
  }));
  return headers;
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

function absoluteShareUrl(config: Config, path: string): string {
  return new URL(path, config.appUrl.origin).toString();
}

function renderShareLinkHistory(links: ShareLinkInfo[], config: Config, published: boolean): string {
  const visibleLinks = links.filter((link) => !link.revokedAt);
  if (!visibleLinks.length) return "";
  return `<section class="share-links"><div class="section-heading"><div><p class="eyebrow">Sharing</p><h2>Share link</h2></div><p>${visibleLinks.length} active link</p></div><p>Copy this link to share the published artifact.</p><ul class="share-link-list">${visibleLinks.map((link) => {
    const url = absoluteShareUrl(config, link.url);
    const status = published ? "Active" : "Unpublished";
    const statusClass = published ? "active" : "unpublished";
    return `<li class="share-link-item ${statusClass}"><div class="share-link-meta"><span class="share-status ${statusClass}">${status}</span><time class="share-link-date" datetime="${link.createdAt.toISOString()}">${link.createdAt.toISOString()}</time></div><code class="share-url">${escapeHtml(url)}</code><div class="share-link-controls"><button type="button" data-copy-url="${escapeHtml(url)}">Copy link</button></div></li>`;
  }).join("")}</ul></section>`;
}

function renderVersionTable(artifactId: string, versions: Array<{ id: string; ordinal: number; byteSize: number; digest: string; source: string }>, csrf: string): string {
  const encodedArtifactId = encodeURIComponent(artifactId);
  return `<div class="table-wrap"><table><thead><tr><th>Ordinal</th><th>Bytes</th><th>Digest</th><th>Source</th><th>Actions</th></tr></thead><tbody>${versions.map((version) => {
    const encodedVersionId = encodeURIComponent(version.id);
    return `<tr><td>${version.ordinal}</td><td>${version.byteSize}</td><td><code class="digest">${escapeHtml(version.digest)}</code></td><td>${escapeHtml(version.source)}</td><td><div class="version-actions"><a href="/artifacts/${encodedArtifactId}/versions/${encodedVersionId}/preview">Preview</a><a href="/artifacts/${encodedArtifactId}/versions/${encodedVersionId}/source">Source</a><a href="/artifacts/${encodedArtifactId}/versions/${encodedVersionId}/download">Download</a><form method="post" action="/artifacts/${encodedArtifactId}/publish/${encodedVersionId}" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button>Publish</button></form></div></td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function previewPageBody(title: string, sourceHref: string, backHref: string, frameSrc: string, sandbox: string): string {
  return `<main class="preview-page"><div class="preview-toolbar"><div class="preview-heading"><div><p class="eyebrow">Artifact preview</p><h1>${escapeHtml(title)}</h1></div><span class="share-status active">Read-only</span></div><div class="preview-actions"><a href="${escapeHtml(sourceHref)}">View source</a><a href="${escapeHtml(backHref)}">Back to artifact</a></div></div><div class="preview-warning" role="status"><strong>Untrusted content:</strong> This artifact was created by a user. Never enter passwords or sensitive information.</div><iframe class="artifact-frame" ${sandbox} src="${escapeHtml(frameSrc)}" title="Artifact preview"></iframe></main>`;
}

function shareLinkResultPage(title: string, message: string, url: string, backHref: string): string {
  return `<main class="result-page"><p class="eyebrow">Sharing</p><h1>${title}</h1><p>${message}</p><div class="result-link"><code class="share-url">${escapeHtml(url)}</code><button type="button" data-copy-url="${escapeHtml(url)}">Copy link</button></div><p><a href="${backHref}">Back to artifact</a></p></main>`;
}

export function registerDashboardRoutes(app: any, db: Database, config: Config, auth?: Auth) {
  const service = new ArtifactService(db, config);
  const page = (body: string, status = 200, headers = new Headers()) => html(body, status, headers, config.appUrl.origin);
  const artifactPage = (body: string, status = 200) => {
    const response = page(body, status);
    artifactHeaders(response.headers);
    return response;
  };
  app.get("/", async ({ request }: { request: Request }) => sessionRedirect(config, (await sessionUser(auth, request)) ? "/artifacts" : "/login"));
  app.get("/login", ({ request }: { request: Request }) => {
    const token = cookies(request)[csrfCookie] ?? crypto.randomUUID();
    const loginURL = new URL(request.url);
    const callbackURL = loginURL.searchParams.has("client_id") && loginURL.searchParams.has("redirect_uri")
      ? `/api/auth/mcp/authorize${loginURL.search}`
      : "/artifacts";
    const body = config.microsoft
      ? `<main><h1>Sign in</h1><p>Only a Microsoft identity from your configured Organization is accepted. Personal identities and identities outside the Organization are not supported.</p><form method="post" action="/login/microsoft"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><input type="hidden" name="callbackURL" value="${escapeHtml(callbackURL)}"><button type="submit">Sign in with Microsoft</button></form></main>`
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
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(config, "/login");
    const identityStatus = config.microsoft ? "Microsoft identity authenticated" : user.emailVerified ? "email verified" : "email unverified";
    return page(`<main><h1>Account</h1><p>${escapeHtml(user.name)} — ${escapeHtml(user.email)} (${identityStatus})</p><form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(cookies(request)[csrfCookie] ?? "")}"><button>Log out</button></form></main>`);
  });
  app.post("/logout", async ({ request }: { request: Request }) => {
    await verifyMutation(request, config);
    if (auth) await auth.api.signOut({ headers: request.headers });
    return sessionRedirect(config, "/login");
  });
  app.get("/artifacts", async ({ request }: { request: Request }) => {
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(config, "/login");
    const rows = await service.list(user.id);
    const token = cookies(request)[csrfCookie] ?? "";
    return withCsrf(page(`<main><nav><a href="/account">Account</a><a href="/artifacts/new">New artifact</a><a href="/trash">Trash</a><a href="/connections">Connections</a></nav><h1>Your artifacts</h1><ul>${rows.map((row) => `<li><a href="/artifacts/${row.id}">${escapeHtml(row.name)}</a> — ${row.publishedVersionId ? "published" : "private"}</li>`).join("") || "<li>No artifacts yet.</li>"}</ul><p data-csrf="${escapeHtml(token)}"></p></main>`), request);
  });
  app.get("/artifacts/new", async ({ request }: { request: Request }) => (await sessionUser(auth, request)) ? withCsrf(page(`<main><h1>Upload artifact</h1><p>Supported files: .html, .md, and .txt. Files are private until you publish them.</p><form method="post" action="/artifacts" enctype="multipart/form-data"><label>Name<input name="name" required maxlength="200"></label><label>Artifact file<input name="file" type="file" accept=".html,.md,.txt,text/html,text/markdown,text/plain" required></label><input type="hidden" name="csrf" value="${escapeHtml(cookies(request)[csrfCookie] ?? "")}"><button>Create private artifact</button></form></main>`), request) : sessionRedirect(config, "/login"));
  app.post("/artifacts", async ({ request }: { request: Request }) => {
    await verifyMutation(request, config);
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(config, "/login");
    const form = await request.formData();
    const name = form.get("name");
    const file = form.get("file");
    if (!(file instanceof File)) return new Response("Artifact file required", { status: 400 });
    try {
      const format = formatFromFilename(file.name);
      const content = decodeContent(new Uint8Array(await file.arrayBuffer()), config.maxContentBytes);
      const created = await service.create(user.id, name, content, format);
      return sessionRedirect(config, `/artifacts/${created.artifact.id}`);
    } catch (error) {
      if (error instanceof DomainError) return new Response(error.message, { status: error.status });
      return new Response("Invalid artifact file", { status: 400 });
    }
  });
  app.get("/artifacts/:id", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(config, "/login");
    try {
      const row = await service.get(user.id, params.id);
      const versions = await service.versionsMeta(user.id, row.id);
      const shareLinks = await service.shareLinks(user.id, row.id);
      const token = cookies(request)[csrfCookie] ?? "";
      const artifactId = encodeURIComponent(row.id);
      return withCsrf(page(`<main><a href="/artifacts">Back</a><h1>${escapeHtml(row.name)}</h1><p>Format: ${escapeHtml(row.format)} · Created ${row.createdAt.toISOString()}</p><form method="post" action="/artifacts/${artifactId}/rename"><label>Rename<input name="name" value="${escapeHtml(row.name)}" required></label><input type="hidden" name="csrf" value="${escapeHtml(token)}"><button>Rename</button></form>${row.publishedVersionId ? `<div class="preview-actions"><form method="post" action="/artifacts/${artifactId}/unpublish" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><button>Unpublish</button></form><form method="post" action="/artifacts/${artifactId}/rotate" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><button>Rotate share link</button></form></div>` : ""}${renderShareLinkHistory(shareLinks, config, Boolean(row.publishedVersionId))}<div class="section-heading"><h2>Versions</h2><p>${versions.length} version${versions.length === 1 ? "" : "s"}</p></div>${renderVersionTable(row.id, versions, token)}<form method="post" action="/artifacts/${artifactId}/delete"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><button>Delete</button></form></main>`), request);
    } catch (error) {
      if (error instanceof DomainError && error.code === "ARTIFACT_NOT_FOUND") return new Response("Not Found", { status: 404 });
      return new Response("Internal Server Error", { status: 500 });
    }
  });
  app.post("/artifacts/:id/rename", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(config, "/login");
    const form = await request.formData();
    await service.rename(user.id, params.id, form.get("name"));
    return sessionRedirect(config, `/artifacts/${params.id}`);
  });
  app.get("/artifacts/:id/versions/:versionId/download", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(config, "/login");
    const artifact = await service.get(user.id, params.id);
    const version = await service.version(user.id, params.id, params.versionId);
    const filename = downloadName(artifact.name, artifact.format);
    const headers = artifactHeaders(new Headers({
      "Content-Type": contentMimeType(artifact.format),
      "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    }));
    return new Response(version.content, { headers });
  });
  app.get("/artifacts/:id/versions/:versionId/content", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    const user = await sessionUser(auth, request);
    if (!user) return new Response("Not Found", { status: 404, headers: artifactHeaders() });
    const artifact = await service.get(user.id, params.id);
    const version = await service.version(user.id, params.id, params.versionId);
    return previewContent(artifact.format, version.content);
  });
  app.get("/artifacts/:id/versions/:versionId/source", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(config, "/login");
    const artifact = await service.get(user.id, params.id);
    const version = await service.version(user.id, params.id, params.versionId);
    return sourcePage(`<main><p><a href="/artifacts/${artifact.id}/versions/${version.id}/preview">Back to preview</a></p><h1>${escapeHtml(artifact.name)} source</h1><p>Format: ${escapeHtml(artifact.format)} · Version ${version.ordinal}</p><pre>${escapeHtml(version.content)}</pre></main>`);
  });
  app.get("/artifacts/:id/versions/:versionId/preview", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(config, "/login");
    const artifact = await service.get(user.id, params.id);
    await service.version(user.id, params.id, params.versionId);
    const artifactId = encodeURIComponent(artifact.id);
    const versionId = encodeURIComponent(params.versionId);
    return artifactPage(previewPageBody(artifact.name, `/artifacts/${artifactId}/versions/${versionId}/source`, `/artifacts/${artifactId}`, `/artifacts/${artifactId}/versions/${versionId}/content`, previewSandbox(artifact.format)));
  });
  app.post("/artifacts/:id/publish/:versionId", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(config, "/login");
    const published = await service.publish(user.id, params.id, params.versionId);
    return page(shareLinkResultPage("Artifact published", "Your artifact is now available at this share link.", absoluteShareUrl(config, published.url), `/artifacts/${encodeURIComponent(params.id)}`));
  });
  app.post("/artifacts/:id/delete", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(config, "/login");
    await service.remove(user.id, params.id);
    return sessionRedirect(config, "/artifacts");
  });
  app.get("/trash", async ({ request }: { request: Request }) => {
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(config, "/login");
    const rows = await service.trash(user.id);
    const token = cookies(request)[csrfCookie] ?? "";
    return withCsrf(page(`<main><nav><a href="/artifacts">Artifacts</a><a href="/account">Account</a></nav><h1>Trash</h1><ul>${rows.map((row) => `<li>${escapeHtml(row.name)}<form method="post" action="/artifacts/${row.id}/restore" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><button>Restore</button></form></li>`).join("") || "<li>Trash is empty.</li>"}</ul></main>`), request);
  });
  app.post("/artifacts/:id/restore", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(config, "/login");
    await service.restore(user.id, params.id);
    return sessionRedirect(config, `/artifacts/${params.id}`);
  });
  app.post("/artifacts/:id/unpublish", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(config, "/login");
    await service.unpublish(user.id, params.id);
    return sessionRedirect(config, `/artifacts/${params.id}`);
  });
  app.post("/artifacts/:id/rotate", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(config, "/login");
    const rotated = await service.rotate(user.id, params.id);
    return page(shareLinkResultPage("New share link", "The previous link has been revoked. Copy this new link to share the artifact.", absoluteShareUrl(config, rotated.url), `/artifacts/${encodeURIComponent(params.id)}`));
  });
  app.get("/connections", async ({ request }: { request: Request }) => {
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(config, "/login");
    const rows = await service.connections(user.id);
    const token = cookies(request)[csrfCookie] ?? "";
    return withCsrf(page(`<main><nav><a href="/artifacts">Artifacts</a><a href="/account">Account</a></nav><h1>Connected applications</h1><ul>${rows.map((row) => `<li>${escapeHtml(row.name ?? row.clientId)} — ${row.disabled ? "revoked" : "active"}<form method="post" action="/connections/${encodeURIComponent(row.clientId)}/revoke" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><button ${row.disabled ? "disabled" : ""}>Revoke</button></form></li>`).join("") || "<li>No connected applications.</li>"}</ul></main>`), request);
  });
  app.post("/connections/:clientId/revoke", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(config, "/login");
    try {
      await service.revokeClient(user.id, decodeURIComponent(params.clientId));
    } catch {
      return new Response("Not Found", { status: 404 });
    }
    return sessionRedirect(config, "/connections");
  });
  app.get("/s/:token", async ({ params }: { params: Record<string, string> }) => {
    try {
      const shared = await service.shared(params.token);
      const token = encodeURIComponent(params.token);
      return artifactPage(previewPageBody(shared.artifact.name, `/s/${token}/source`, "/", `/s/${token}/content`, previewSandbox(shared.artifact.format)));
    } catch (error) {
      const status = error instanceof DomainError ? error.status : 404;
      return new Response(status === 410 ? "Gone" : "Not Found", { status, headers: artifactHeaders() });
    }
  });
  app.get("/s/:token/content", async ({ params }: { params: Record<string, string> }) => {
    try {
      const shared = await service.shared(params.token);
      return previewContent(shared.artifact.format, shared.version.content);
    } catch (error) {
      const status = error instanceof DomainError ? error.status : 404;
      return new Response(status === 410 ? "Gone" : "Not Found", { status, headers: artifactHeaders() });
    }
  });
  app.get("/s/:token/source", async ({ params }: { params: Record<string, string> }) => {
    try {
      const shared = await service.shared(params.token);
      return new Response(`<!doctype html><html><head>${robotsMeta()}<meta charset="utf-8"><title>Shared artifact source</title></head><body><main><p><a href="/s/${params.token}">Back to preview</a></p><h1>${escapeHtml(shared.artifact.name)} source</h1><p>Format: ${escapeHtml(shared.artifact.format)} · Version ${shared.version.ordinal}</p><pre>${escapeHtml(shared.version.content)}</pre></main></body></html>`, { headers: artifactHeaders(new Headers({ "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'" })) });
    } catch (error) {
      const status = error instanceof DomainError ? error.status : 404;
      return new Response(status === 410 ? "Gone" : "Not Found", { status, headers: artifactHeaders() });
    }
  });
  return app;
}
