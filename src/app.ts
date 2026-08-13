import { eq } from "drizzle-orm";
import { loadConfig, type Config } from "./config";
import { createDb, type Database } from "./db/client";
import { oauthAccessToken } from "./db/schema";
import { registerHealthRoutes } from "./routes/health";
import { registerDashboardRoutes } from "./routes/dashboard";
import { registerMcp, registerAccessJwks } from "./mcp";
import { beginDrain } from "./runtime";
import { signAccessJwt } from "./oauth/jwt";
import { newRequestContext, requestLog } from "./logger";
import type { Auth } from "./auth";

// Elysia .mount handlers bypass the lifecycle hooks, so requests to /mcp and
// /api/auth are logged by wrapping the handler itself. Dashboard/health routes
// use the onRequest/onAfterHandle hooks below.
function withLogging(route: string, handler: (request: Request) => Promise<Response> | Response) {
  return async (request: Request): Promise<Response> => {
    const ctx = newRequestContext(request.headers, route);
    const started = Date.now();
    let status = 500;
    let errorCode: string | undefined;
    try {
      const response = await handler(request);
      status = response.status;
      const out = new Response(response.body, response);
      if (!request.headers.has("x-correlation-id")) out.headers.set("x-correlation-id", ctx.correlationId);
      return out;
    } catch (error) {
      errorCode = error instanceof Error ? error.name : "INTERNAL_ERROR";
      requestLog(ctx, status, Date.now() - started, errorCode);
      throw error;
    } finally {
      if (!errorCode) requestLog(ctx, status, Date.now() - started);
    }
  };
}

export function createApp(db: Database, config: Config, auth?: Auth) {
  const app = registerHealthRoutes(db, config);
  registerDashboardRoutes(app, db, config, auth);
  registerMcp(app, db, config, auth);
  registerAccessJwks(app, config);
  app.onRequest(({ request, store }) => {
    const ctx = newRequestContext(request.headers, new URL(request.url).pathname);
    (store as Record<string, unknown>).__req = { ctx, started: Date.now() };
  });
  app.onAfterHandle(({ request, store, set }) => {
    const state = (store as Record<string, { ctx: ReturnType<typeof newRequestContext>; started: number }> | undefined)?.__req;
    if (!state) return;
    const status = typeof set.status === "number" ? set.status : 200;
    requestLog(state.ctx, status, Date.now() - state.started);
    if (!request.headers.has("x-correlation-id")) {
      set.headers["x-correlation-id"] = state.ctx.correlationId;
    }
  });
  if (auth) app.mount("/api/auth", withLogging("api_auth", (request) => authHandlerRef(auth, request, db, config)));
  return app.onError((context) => {
    const state = (context.store as Record<string, { ctx: ReturnType<typeof newRequestContext>; started: number }> | undefined)?.__req;
    if (context.error instanceof Response) {
      if (state) requestLog(state.ctx, context.error.status, Date.now() - state.started);
      return context.error;
    }
    if (state) requestLog(state.ctx, 500, Date.now() - state.started, "INTERNAL_ERROR");
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  });
}

// Elysia .mount strips the "/api/auth" prefix before invoking the handler;
// Better Auth routes against its full base path, so re-add the prefix here.
function rebaseAuthRequest(request: Request): Request {
  const incoming = new URL(request.url);
  const full = new URL(`/api/auth${incoming.pathname}${incoming.search}`, incoming.origin);
  const init: RequestInit = { method: request.method, headers: request.headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // duplex:"half" is required when streaming a body via RequestInit.
    (init as Record<string, unknown>).duplex = "half";
  }
  return new Request(full, init);
}

async function authHandlerRef(auth: Auth, request: Request, db: Database, config: Config) {
  const rebased = rebaseAuthRequest(request);
  const pathname = new URL(rebased.url).pathname;
  const isTokenEndpoint = rebased.method === "POST" && pathname === "/api/auth/mcp/token";
  const isSignInUp =
    rebased.method === "POST" &&
    ["/api/auth/sign-in/email", "/api/auth/sign-up/email"].includes(pathname);

  // Pass-through for everything that is not a rewritten sign-in/up or the MCP
  // token endpoint. For the token endpoint we still call Better Auth verbatim,
  // then rewrite the opaque access_token into a locally-verifiable JWT below.
  if (!isSignInUp && !isTokenEndpoint) return auth.handler(rebased);

  const response = isSignInUp ? await rewrittenAuth(auth, rebased) : await auth.handler(rebased);
  if (!isTokenEndpoint || !response.ok) return response;
  return rewriteAccessToken(response, db, config);
}

async function rewrittenAuth(auth: Auth, rebased: Request) {
  const contentType = rebased.headers.get("content-type") ?? "";
  const headers = new Headers(rebased.headers);
  headers.delete("content-length");
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    const form = await rebased.clone().formData();
    const email = form.get("email");
    if (typeof email === "string") form.set("email", email.toLowerCase());
    const body = new URLSearchParams();
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") body.append(key, value);
    }
    headers.set("content-type", "application/x-www-form-urlencoded");
    return auth.handler(new Request(rebased.url, { method: rebased.method, headers, body }));
  }
  const body = await rebased.clone().json();
  if (typeof body?.email === "string") body.email = body.email.toLowerCase();
  headers.set("content-type", "application/json");
  return auth.handler(new Request(rebased.url, {
    method: rebased.method,
    headers,
    body: JSON.stringify(body),
  }));
}

// Better Auth mints an opaque access_token; the resource server must accept JWTs
// only. Replace it with a signed JWT whose claims mirror the stored grant so the
// opaque value is never presented to /mcp and never needs per-request DB lookup.
async function rewriteAccessToken(response: Response, db: Database, config: Config) {
  let body: Record<string, unknown>;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  const opaque = typeof body.access_token === "string" ? body.access_token : undefined;
  if (!opaque) return response;
  const [grant] = await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.accessToken, opaque));
  if (!grant) return response;
  const jwt = await signAccessJwt(config, {
    sub: grant.userId ?? "unknown",
    scope: grant.scopes,
    clientId: grant.clientId,
    jti: grant.id,
  });
  body.access_token = jwt;
  return new Response(JSON.stringify(body), {
    status: response.status,
    headers: response.headers,
  });
}

if (import.meta.main) {
  const config = loadConfig();
  const resources = createDb(config);
  const { createAuth } = await import("./auth");
  const auth = createAuth(resources.db, config);
  let shuttingDown = false;
  const app = createApp(resources.db, config, auth);
  const server = app.listen({ hostname: "0.0.0.0", port: config.port });
  console.log(JSON.stringify({ event: "app_started", port: config.port }));

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: "app_stopping", signal }));
    beginDrain();
    // Stop accepting new connections, let in-flight work finish, but bound it.
    const force = new Promise<void>((resolve) => setTimeout(() => {
      console.log(JSON.stringify({ event: "app_stop_forced" }));
      resolve();
    }, config.shutdownTimeoutSeconds * 1000));
    await Promise.race([server.stop(), force]);
    await resources.sql.close();
    console.log(JSON.stringify({ event: "app_stopped" }));
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
