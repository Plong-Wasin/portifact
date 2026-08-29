import { timingSafeEqual } from "node:crypto";
import type { Auth } from "../auth";
import type { Config } from "../config";
import type { Database } from "../db/client";
import { ArtifactService } from "../artifacts/service";
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

function html(body: string, status = 200, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  // The local POST starts OAuth and redirects the browser to Microsoft's
  // authorization host. Keep form submissions same-origin otherwise.
  headers.set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://login.microsoftonline.com");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${robotsMeta()}<title>Portifact</title><style>body{font:16px system-ui;max-width:70rem;margin:2rem auto;padding:0 1rem;color:#202124}a,button{font:inherit}main{display:grid;gap:1rem}nav{display:flex;gap:1rem;flex-wrap:wrap}label{display:grid;gap:.25rem}input{padding:.5rem}button{padding:.5rem .75rem}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.5rem;border-bottom:1px solid #ddd}@media(max-width:40rem){body{margin:.75rem}}</style></head><body>${body}</body></html>`, { status, headers });
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

function sessionRedirect(request: Request, location: string) {
  return new Response(null, { status: 302, headers: { Location: `${new URL(location, request.url)}` } });
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

export function registerDashboardRoutes(app: any, db: Database, config: Config, auth?: Auth) {
  const service = new ArtifactService(db, config);
  app.get("/", async ({ request }: { request: Request }) => sessionRedirect(request, (await sessionUser(auth, request)) ? "/artifacts" : "/login"));
  app.get("/login", ({ request }: { request: Request }) => {
    const token = cookies(request)[csrfCookie] ?? crypto.randomUUID();
    const loginURL = new URL(request.url);
    const callbackURL = loginURL.searchParams.has("client_id") && loginURL.searchParams.has("redirect_uri")
      ? `/api/auth/mcp/authorize${loginURL.search}`
      : "/artifacts";
    const body = config.microsoft
      ? `<main><h1>Sign in</h1><p>Only a Microsoft identity from your configured Organization is accepted. Personal identities and identities outside the Organization are not supported.</p><form method="post" action="/login/microsoft"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><input type="hidden" name="callbackURL" value="${escapeHtml(callbackURL)}"><button type="submit">Sign in with Microsoft</button></form></main>`
      : `<main><h1>Sign in</h1><form method="post" action="/api/auth/sign-in/email"><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form>${config.registrationEnabled ? '<a href="/register">Create an account</a>' : ""}</main>`;
    return withCsrf(html(body), request, token);
  });
  app.get("/error", loginErrorPage);
  app.post("/login/microsoft", async ({ request }: { request: Request }) => {
    if (!auth || !config.microsoft) return new Response("Not Found", { status: 404 });
    return startMicrosoftLogin(request, auth, config);
  });
  app.get("/login/error", loginErrorPage);
  app.get("/register", ({ request }: { request: Request }) => config.registrationEnabled && !config.microsoft ? withCsrf(html(`<main><h1>Create account</h1><form method="post" action="/api/auth/sign-up/email"><label>Name<input name="name" required></label><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="new-password" minlength="8" required></label><button>Create account</button></form><a href="/login">Sign in</a></main>`), request) : new Response("Not Found", { status: 404 }));
  app.get("/account", async ({ request }: { request: Request }) => {
    const user = await sessionUser(auth, request);
    return user ? html(`<main><h1>Account</h1><p>${escapeHtml(user.name)} — ${escapeHtml(user.email)} (email unverified)</p><form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(cookies(request)[csrfCookie] ?? "")}"><button>Log out</button></form></main>`) : sessionRedirect(request, "/login");
  });
  app.post("/logout", async ({ request }: { request: Request }) => {
    await verifyMutation(request, config);
    if (auth) await auth.api.signOut({ headers: request.headers });
    return sessionRedirect(request, "/login");
  });
  app.get("/artifacts", async ({ request }: { request: Request }) => {
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(request, "/login");
    const rows = await service.list(user.id);
    const token = cookies(request)[csrfCookie] ?? "";
    return withCsrf(html(`<main><nav><a href="/account">Account</a><a href="/artifacts/new">New artifact</a><a href="/trash">Trash</a><a href="/connections">Connections</a></nav><h1>Your artifacts</h1><ul>${rows.map((row) => `<li><a href="/artifacts/${row.id}">${escapeHtml(row.name)}</a> — ${row.publishedVersionId ? "published" : "private"}</li>`).join("") || "<li>No artifacts yet.</li>"}</ul><p data-csrf="${escapeHtml(token)}"></p></main>`), request);
  });
  app.get("/artifacts/new", async ({ request }: { request: Request }) => (await sessionUser(auth, request)) ? withCsrf(html(`<main><h1>Upload artifact</h1><p>Supported files: .html, .md, and .txt. Files are private until you publish them.</p><form method="post" action="/artifacts" enctype="multipart/form-data"><label>Name<input name="name" required maxlength="200"></label><label>Artifact file<input name="file" type="file" accept=".html,.md,.txt,text/html,text/markdown,text/plain" required></label><input type="hidden" name="csrf" value="${escapeHtml(cookies(request)[csrfCookie] ?? "")}"><button>Create private artifact</button></form></main>`), request) : sessionRedirect(request, "/login"));
  app.post("/artifacts", async ({ request }: { request: Request }) => {
    await verifyMutation(request, config);
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(request, "/login");
    const form = await request.formData();
    const name = form.get("name");
    const file = form.get("file");
    if (!(file instanceof File)) return new Response("Artifact file required", { status: 400 });
    try {
      const format = formatFromFilename(file.name);
      const content = decodeContent(new Uint8Array(await file.arrayBuffer()), config.maxContentBytes);
      const created = await service.create(user.id, name, content, format);
      return sessionRedirect(request, `/artifacts/${created.artifact.id}`);
    } catch (error) {
      if (error instanceof DomainError) return new Response(error.message, { status: error.status });
      return new Response("Invalid artifact file", { status: 400 });
    }
  });
  app.get("/artifacts/:id", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(request, "/login");
    try {
      const row = await service.get(user.id, params.id);
      const versions = await service.versions(user.id, row.id);
      const token = cookies(request)[csrfCookie] ?? "";
      return withCsrf(html(`<main><a href="/artifacts">Back</a><h1>${escapeHtml(row.name)}</h1><p>Format: ${escapeHtml(row.format)} · Created ${row.createdAt.toISOString()}</p><form method="post" action="/artifacts/${row.id}/rename"><label>Rename<input name="name" value="${escapeHtml(row.name)}" required></label><input type="hidden" name="csrf" value="${escapeHtml(token)}"><button>Rename</button></form>${row.publishedVersionId ? `<form method="post" action="/artifacts/${row.id}/unpublish" style="display:inline"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><button>Unpublish</button></form><form method="post" action="/artifacts/${row.id}/rotate" style="display:inline"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><button>Rotate share link</button></form>` : ""}<h2>Versions</h2><table><thead><tr><th>Ordinal</th><th>Bytes</th><th>Digest</th><th>Source</th><th>Actions</th></tr></thead><tbody>${versions.map((version) => `<tr><td>${version.ordinal}</td><td>${version.byteSize}</td><td>${version.digest}</td><td>${escapeHtml(version.source)}</td><td><a href="/artifacts/${row.id}/versions/${version.id}/preview">Preview</a> <a href="/artifacts/${row.id}/versions/${version.id}/source">Source</a> <a href="/artifacts/${row.id}/versions/${version.id}/download">Download</a><form method="post" action="/artifacts/${row.id}/publish/${version.id}" style="display:inline"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><button>Publish</button></form></td></tr>`).join("")}</tbody></table><form method="post" action="/artifacts/${row.id}/delete"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><button>Delete</button></form></main>`), request);
    } catch (error) {
      if (error instanceof DomainError && error.code === "ARTIFACT_NOT_FOUND") return new Response("Not Found", { status: 404 });
      return new Response("Internal Server Error", { status: 500 });
    }
  });
  app.post("/artifacts/:id/rename", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(request, "/login");
    const form = await request.formData();
    await service.rename(user.id, params.id, form.get("name"));
    return sessionRedirect(request, `/artifacts/${params.id}`);
  });
  app.get("/artifacts/:id/versions/:versionId/download", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(request, "/login");
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
    if (!user) return sessionRedirect(request, "/login");
    const artifact = await service.get(user.id, params.id);
    const version = await service.version(user.id, params.id, params.versionId);
    return sourcePage(`<main><p><a href="/artifacts/${artifact.id}/versions/${version.id}/preview">Back to preview</a></p><h1>${escapeHtml(artifact.name)} source</h1><p>Format: ${escapeHtml(artifact.format)} · Version ${version.ordinal}</p><pre>${escapeHtml(version.content)}</pre></main>`);
  });
  app.get("/artifacts/:id/versions/:versionId/preview", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(request, "/login");
    const artifact = await service.get(user.id, params.id);
    await service.version(user.id, params.id, params.versionId);
    return new Response(`<!doctype html><html><head>${robotsMeta()}<title>Preview</title></head><body><aside><strong>Warning:</strong> This content was user-created and is untrusted. Never enter passwords or sensitive information.</aside><p><a href="/artifacts/${artifact.id}/versions/${params.versionId}/source">View source</a> · <a href="/artifacts/${artifact.id}">Back to artifact</a></p><iframe ${previewSandbox(artifact.format)} src="/artifacts/${params.id}/versions/${params.versionId}/content" title="Artifact preview" style="width:100%;height:80vh"></iframe></body></html>`, { headers: artifactHeaders(new Headers({ "Content-Type": "text/html; charset=utf-8" })) });
  });
  app.post("/artifacts/:id/publish/:versionId", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(request, "/login");
    await service.publish(user.id, params.id, params.versionId);
    return sessionRedirect(request, `/artifacts/${params.id}`);
  });
  app.post("/artifacts/:id/delete", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(request, "/login");
    await service.remove(user.id, params.id);
    return sessionRedirect(request, "/artifacts");
  });
  app.get("/trash", async ({ request }: { request: Request }) => {
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(request, "/login");
    const rows = await service.trash(user.id);
    const token = cookies(request)[csrfCookie] ?? "";
    return withCsrf(html(`<main><nav><a href="/artifacts">Artifacts</a><a href="/account">Account</a></nav><h1>Trash</h1><ul>${rows.map((row) => `<li>${escapeHtml(row.name)}<form method="post" action="/artifacts/${row.id}/restore" style="display:inline"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><button>Restore</button></form></li>`).join("") || "<li>Trash is empty.</li>"}</ul></main>`), request);
  });
  app.post("/artifacts/:id/restore", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(request, "/login");
    await service.restore(user.id, params.id);
    return sessionRedirect(request, `/artifacts/${params.id}`);
  });
  app.post("/artifacts/:id/unpublish", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(request, "/login");
    await service.unpublish(user.id, params.id);
    return sessionRedirect(request, `/artifacts/${params.id}`);
  });
  app.post("/artifacts/:id/rotate", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(request, "/login");
    const token = await service.rotate(user.id, params.id);
    return html(`<main><h1>New share link</h1><p>This link is shown once. Copy it now:</p><code>${escapeHtml(`${config.appUrl.origin}/s/${token}`)}</code><p><a href="/artifacts/${params.id}">Back</a></p></main>`);
  });
  app.get("/connections", async ({ request }: { request: Request }) => {
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(request, "/login");
    const rows = await service.connections(user.id);
    const token = cookies(request)[csrfCookie] ?? "";
    return withCsrf(html(`<main><nav><a href="/artifacts">Artifacts</a><a href="/account">Account</a></nav><h1>Connected applications</h1><ul>${rows.map((row) => `<li>${escapeHtml(row.name ?? row.clientId)} — ${row.disabled ? "revoked" : "active"}<form method="post" action="/connections/${encodeURIComponent(row.clientId)}/revoke" style="display:inline"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><button ${row.disabled ? "disabled" : ""}>Revoke</button></form></li>`).join("") || "<li>No connected applications.</li>"}</ul></main>`), request);
  });
  app.post("/connections/:clientId/revoke", async ({ request, params }: { request: Request; params: Record<string, string> }) => {
    await verifyMutation(request, config);
    const user = await sessionUser(auth, request);
    if (!user) return sessionRedirect(request, "/login");
    try {
      await service.revokeClient(user.id, decodeURIComponent(params.clientId));
    } catch {
      return new Response("Not Found", { status: 404 });
    }
    return sessionRedirect(request, "/connections");
  });
  app.get("/s/:token", async ({ params }: { params: Record<string, string> }) => {
    try {
      const shared = await service.shared(params.token);
      return new Response(`<!doctype html><html><head>${robotsMeta()}<title>Shared artifact</title></head><body><aside><strong>Warning:</strong> This content was user-created and is untrusted. Never enter passwords or sensitive information.</aside><p><a href="/s/${params.token}/source">View source</a></p><iframe ${previewSandbox(shared.artifact.format)} src="/s/${params.token}/content" title="Shared artifact" style="width:100%;height:80vh"></iframe></body></html>`, { headers: artifactHeaders(new Headers({ "Content-Type": "text/html; charset=utf-8" })) });
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
