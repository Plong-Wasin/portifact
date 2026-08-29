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
import { createErrorTelemetry, flushErrorTelemetry, type ErrorTelemetry, type TelemetryContext } from "./telemetry";

function requestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "/unknown";
  }
}

function telemetryRoute(route: string, request: Request): string {
  const path = requestPath(request);
  return route === "api_auth" && !path.startsWith("/api/auth") ? `/api/auth${path}` : path;
}

function httpTelemetryContext(request: Request, status: number, state?: { ctx: ReturnType<typeof newRequestContext> }, errorCode?: string, route?: string): TelemetryContext {
  return {
    service: "app",
    route: route ?? requestPath(request),
    method: request.method,
    status,
    errorCode,
    correlationId: state?.ctx.correlationId ?? newRequestContext(request.headers).correlationId,
  };
}

function isProviderStartFailure(request: Request, status: number): boolean {
  return status === 502 && requestPath(request) === "/login/microsoft";
}

function captureResponseFailure(telemetry: ErrorTelemetry, request: Request, status: number, state?: { ctx: ReturnType<typeof newRequestContext> }, route?: string) {
  if (status < 500 || isProviderStartFailure(request, status)) return;
  try {
    telemetry.captureMessage(`HTTP ${status} response`, httpTelemetryContext(request, status, state, undefined, route));
  } catch {
    // Telemetry must never change the application response.
  }
}

function captureExceptionFailure(telemetry: ErrorTelemetry, error: unknown, request: Request, status: number, state?: { ctx: ReturnType<typeof newRequestContext> }, errorCode?: string, route?: string) {
  try {
    telemetry.captureException(error, httpTelemetryContext(request, status, state, errorCode, route));
  } catch {
    // Telemetry must never change the application response.
  }
}

function errorCodeOf(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  if (error instanceof Error && error.name !== "Error") return error.name;
  return "INTERNAL_ERROR";
}

// Elysia .mount handlers bypass the lifecycle hooks, so requests to /mcp and
// /api/auth are logged by wrapping the handler itself. Dashboard/health routes
// use the onRequest/onAfterHandle hooks below.
function withLogging(route: string, handler: (request: Request) => Promise<Response> | Response, telemetry: ErrorTelemetry) {
  return async (request: Request): Promise<Response> => {
    const ctx = newRequestContext(request.headers, route);
    const started = Date.now();
    let status = 500;
    let errorCode: string | undefined;
    try {
      const response = await handler(request);
      status = response.status;
      captureResponseFailure(telemetry, request, status, { ctx }, telemetryRoute(route, request));
      const out = new Response(response.body, response);
      if (!request.headers.has("x-correlation-id")) out.headers.set("x-correlation-id", ctx.correlationId);
      return out;
    } catch (error) {
      if (error instanceof Response) {
        status = error.status;
        captureResponseFailure(telemetry, request, status, { ctx }, telemetryRoute(route, request));
      } else {
        errorCode = errorCodeOf(error);
        captureExceptionFailure(telemetry, error, request, status, { ctx }, errorCode, telemetryRoute(route, request));
      }
      requestLog(ctx, status, Date.now() - started, errorCode);
      throw error;
    } finally {
      if (!errorCode) requestLog(ctx, status, Date.now() - started);
    }
  };
}

export function createApp(db: Database, config: Config, auth?: Auth, telemetry: ErrorTelemetry = createErrorTelemetry(config)) {
  const app = registerHealthRoutes(db, config);
  registerDashboardRoutes(app, db, config, auth);
  registerMcp(app, db, config, auth, telemetry);
  registerAccessJwks(app, config);
  app.onRequest(({ request, store }) => {
    const ctx = newRequestContext(request.headers, new URL(request.url).pathname);
    (store as Record<string, unknown>).__req = { ctx, started: Date.now() };
  });
  app.onAfterHandle((context) => {
    const { request, store, set } = context;
    const state = (store as Record<string, { ctx: ReturnType<typeof newRequestContext>; started: number }> | undefined)?.__req;
    if (!state) return;
    const status = typeof set.status === "number" ? set.status : 200;
    requestLog(state.ctx, status, Date.now() - state.started);
    const response = context.response instanceof Response ? context.response : undefined;
    captureResponseFailure(telemetry, request, response?.status ?? status, state);
    if (!request.headers.has("x-correlation-id")) {
      set.headers["x-correlation-id"] = state.ctx.correlationId;
    }
  });
  if (auth) app.mount("/api/auth", withLogging("api_auth", (request) => authHandlerRef(auth, request, db, config), telemetry));
  return app.onError((context) => {
    const state = (context.store as Record<string, { ctx: ReturnType<typeof newRequestContext>; started: number }> | undefined)?.__req;
    if (context.error instanceof Response) {
      if (state) requestLog(state.ctx, context.error.status, Date.now() - state.started);
      captureResponseFailure(telemetry, context.request, context.error.status, state);
      return context.error;
    }
    const errorCode = errorCodeOf(context.error);
    captureExceptionFailure(telemetry, context.error, context.request, 500, state, errorCode);
    if (state) requestLog(state.ctx, 500, Date.now() - state.started, errorCode);
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
  const isMicrosoftCallback = rebased.method === "GET" && pathname === "/api/auth/callback/microsoft";
  const isTokenEndpoint = rebased.method === "POST" && pathname === "/api/auth/mcp/token";
  const isSignInUp =
    rebased.method === "POST" &&
    ["/api/auth/sign-in/email", "/api/auth/sign-up/email"].includes(pathname);

  // Pass-through for everything that is not a rewritten sign-in/up, Microsoft
  // callback, or MCP token endpoint. For the token endpoint we still call
  // Better Auth verbatim, then rewrite the opaque access_token into a
  // locally-verifiable JWT below.
  if (!isSignInUp && !isTokenEndpoint && !isMicrosoftCallback) return auth.handler(rebased);

  const response = isSignInUp ? await rewrittenAuth(auth, rebased) : await auth.handler(rebased);
  if (isMicrosoftCallback) return rewriteMicrosoftCallbackError(response, config);
  if (!isTokenEndpoint || !response.ok) return response;
  return rewriteAccessToken(response, db, config);
}

function rewriteMicrosoftCallbackError(response: Response, config: Config): Response {
  if (response.status < 300 || response.status >= 400) return response;
  const location = response.headers.get("location");
  if (!location) return response;
  try {
    const target = new URL(location, config.appUrl.origin);
    if (target.origin === config.appUrl.origin && target.pathname === "/api/auth/error") {
      return new Response(null, { status: 302, headers: { Location: `${config.appUrl.origin}/login/error` } });
    }
  } catch {
    return response;
  }
  return response;
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
  const telemetry = createErrorTelemetry(config);
  const resources = createDb(config);
  const { createAuth } = await import("./auth");
  const auth = createAuth(resources.db, config);
  let shuttingDown = false;
  const app = createApp(resources.db, config, auth, telemetry);
  const server = app.listen({ hostname: "0.0.0.0", port: config.port });
  console.log(JSON.stringify({ event: "app_started", port: config.port }));

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: "app_stopping", signal }));
    beginDrain();
    const deadline = Date.now() + config.shutdownTimeoutSeconds * 1000;
    // Stop accepting new connections, let in-flight work finish, but bound it.
    const force = new Promise<void>((resolve) => setTimeout(() => {
      console.log(JSON.stringify({ event: "app_stop_forced" }));
      resolve();
    }, config.shutdownTimeoutSeconds * 1000));
    await Promise.race([server.stop(), force]);
    const remainingMs = Math.max(1, deadline - Date.now());
    await Promise.all([
      resources.sql.close(),
      flushErrorTelemetry(telemetry, Math.min(config.sentryFlushTimeoutMs, remainingMs)),
    ]);
    console.log(JSON.stringify({ event: "app_stopped" }));
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
