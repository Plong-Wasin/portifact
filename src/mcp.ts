import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createMcpHandler,
  McpServer,
  requireBearerAuth,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { Config } from "./config";
import type { Auth } from "./auth";
import type { Database } from "./db/client";
import { ArtifactService } from "./artifacts/service";
import { DomainError } from "./artifacts/domain";
import { ARTIFACT_FORMATS } from "./artifacts/content";
import { idempotencyKey } from "./db/schema";
import { publicJwks } from "./oauth/jwt";
import { newRequestContext, requestLog, log } from "./logger";

const protocolVersion = "2026-07-28";
const scopes = ["artifacts:read", "artifacts:write", "artifacts:publish"] as const;

type TokenVerifier = {
  verifyAccessToken: (token: string) => Promise<AuthInfo>;
};

type ToolContext = { authInfo?: AuthInfo; correlationId?: string };

// Spec (2026-07-28) JSON-RPC error codes for transport-level failures.
const ERR_HEADER_MISMATCH = -32020;
const ERR_INVALID_REQUEST = -32600;
const ERR_UNSUPPORTED_VERSION = -32022;

function rpcError(code: number, message: string, status = 400, data?: Record<string, unknown>) {
  return Response.json(
    { jsonrpc: "2.0", error: { code, message, ...(data ? { data } : {}) } },
    { status },
  );
}

// Methods that MUST carry Mcp-Name per 2026-07-28 (params.name / params.uri).
const METHODS_REQUIRING_NAME = new Set(["tools/call", "resources/read", "prompts/get"]);

async function validateHeaders(request: Request): Promise<Response | undefined> {
  const headerVersion = request.headers.get("mcp-protocol-version");
  if (headerVersion !== protocolVersion) {
    return rpcError(ERR_UNSUPPORTED_VERSION, `Unsupported protocol version: ${headerVersion ?? "(missing)"}`, 400, { supported: [protocolVersion], requested: headerVersion ?? null });
  }
  const method = request.headers.get("mcp-method");
  if (!method) return rpcError(ERR_HEADER_MISMATCH, "mcp-method header is required");
  // Mcp-Name is required only for name-bearing methods; tools/list, server/discover, etc. omit it.
  const name = request.headers.get("mcp-name");
  if (METHODS_REQUIRING_NAME.has(method) && !name) {
    return rpcError(ERR_HEADER_MISMATCH, `mcp-name header is required for ${method}`);
  }
  // 2026-07-28 removed Mcp-Session-Id; legacy clients sending it must be ignored, but
  // rejecting here surfaces the incompatibility clearly for modern-only deployments.
  if (request.method === "POST") {
    let body: { method?: string; params?: { name?: string }; _meta?: Record<string, unknown> };
    try {
      body = await request.clone().json() as typeof body;
    } catch {
      return rpcError(ERR_INVALID_REQUEST, "invalid JSON-RPC body");
    }
    // Header is the mirror; body._meta is the source of truth — they must agree.
    const metaVersion = body._meta?.["io.modelcontextprotocol/protocolVersion"];
    if (typeof metaVersion === "string" && metaVersion !== headerVersion) {
      return rpcError(ERR_HEADER_MISMATCH, "MCP-Protocol-Version header does not match body _meta");
    }
    if (body.method && body.method !== method) {
      return rpcError(ERR_HEADER_MISMATCH, "mcp-method header does not match JSON-RPC method");
    }
    if (method === "tools/call" && body.params?.name && name && body.params.name !== name) {
      return rpcError(ERR_HEADER_MISMATCH, "mcp-name header does not match requested tool");
    }
  }
}

function authVerifier(_auth: Auth | undefined, config: Config): TokenVerifier {
  const jwks = createRemoteJWKSet(
    new URL(`${config.appUrl.origin}/api/auth/.well-known/jwks-access.json`),
  );
  return {
    async verifyAccessToken(token) {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: config.appUrl.origin,
          audience: `${config.appUrl.origin}/mcp`,
          algorithms: ["RS256"],
        });
        if (!payload.sub || typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) {
          throw new Error("invalid_token");
        }
        const tokenScopes = typeof payload.scope === "string"
          ? payload.scope.split(/\s+/).filter(Boolean)
          : [];
        if (!tokenScopes.includes("artifacts:read")) throw new Error("insufficient_scope");
        return {
          token,
          clientId: String(payload.client_id ?? payload.azp ?? "unknown"),
          scopes: tokenScopes,
          expiresAt: payload.exp,
          resource: new URL(`${config.appUrl.origin}/mcp`),
          extra: { userId: payload.sub },
        };
      } catch (error) {
        // Preserve the specific reason (insufficient_scope vs invalid_token);
        // only normalize truly unexpected failures to invalid_token.
        if (error instanceof Error && (error.message === "insufficient_scope" || error.message === "invalid_token")) throw error;
        throw new Error("invalid_token");
      }
    },
  };
}

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function toolError(code: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({ error: code }) }] as [{ type: "text"; text: string }],
  };
}

function authScope(ctx: ToolContext, scope: string): string | undefined {
  return ctx.authInfo?.scopes.includes(scope) ? undefined : "INSUFFICIENT_SCOPE";
}

function cursor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return typeof parsed.id === "string" ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

function nextCursor(id: string | undefined): string | undefined {
  return id
    ? Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url")
    : undefined;
}

function requestHash(input: Record<string, unknown>): string {
  const copy = { ...input };
  delete copy.idempotency_key;
  return createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}

type IdempotencyResult = { kind: "ok"; value: unknown } | ReturnType<typeof toolError>;

async function idempotent(
  db: Database,
  config: Config,
  ctx: ToolContext,
  tool: string,
  input: Record<string, unknown>,
  operation: () => Promise<unknown>,
): Promise<IdempotencyResult> {
  const key = typeof input.idempotency_key === "string" ? input.idempotency_key : "";
  if (!key) return { kind: "ok", value: await operation() };
  const ownerId = String(ctx.authInfo?.extra?.userId ?? "");
  const clientId = ctx.authInfo?.clientId ?? "unknown";
  const recordId = createHash("sha256")
    .update(`${ownerId}\0${clientId}\0${tool}\0${key}`)
    .digest("hex");
  const hash = requestHash(input);
  const [existing] = await db.select().from(idempotencyKey).where(eq(idempotencyKey.id, recordId));
  if (existing && existing.expiresAt > new Date()) {
    if (existing.requestHash !== hash) return toolError("IDEMPOTENCY_CONFLICT");
    // Exact replay: return the stored result, do not re-run the operation.
    return { kind: "ok", value: JSON.parse(existing.result) };
  }
  if (existing) await db.delete(idempotencyKey).where(eq(idempotencyKey.id, recordId));
  const value = await operation();
  try {
    await db.insert(idempotencyKey).values({
      id: recordId,
      ownerId,
      clientId,
      tool,
      requestHash: hash,
      result: JSON.stringify(value),
      expiresAt: new Date(Date.now() + config.idempotencyTtlSeconds * 1000),
      createdAt: new Date(),
    });
  } catch {
    // Concurrent identical request won the unique constraint: return its result
    // if the payload matches, else surface a conflict. ponytail: reserve-then-fill
    // (insert placeholder before running the operation) would prevent the rare
    // orphan artifact from a losing concurrent create; needs a status column.
    const [winner] = await db.select().from(idempotencyKey).where(eq(idempotencyKey.id, recordId));
    if (winner && winner.requestHash === hash) return { kind: "ok", value: JSON.parse(winner.result) };
    return toolError("IDEMPOTENCY_CONFLICT");
  }
  return { kind: "ok", value };
}

async function invoke(
  ctx: ToolContext,
  tool: string,
  requiredScope: string,
  operation: () => Promise<unknown> | Promise<IdempotencyResult>,
): Promise<ReturnType<typeof toolResult> | ReturnType<typeof toolError>> {
  const started = Date.now();
  const scopeError = authScope(ctx, requiredScope);
  if (scopeError) {
    log("tool", { correlation_id: ctx.correlationId, tool, status: "error", error_code: scopeError, duration_ms: Date.now() - started });
    return toolError(scopeError);
  }
  try {
    const result = await operation();
    if (result && typeof result === "object" && "kind" in result && result.kind === "ok") {
      log("tool", { correlation_id: ctx.correlationId, tool, status: "ok", duration_ms: Date.now() - started });
      return toolResult((result as unknown as { value: unknown }).value);
    }
    if (result && typeof result === "object" && "isError" in result) {
      log("tool", { correlation_id: ctx.correlationId, tool, status: "error", error_code: "DOMAIN_ERROR", duration_ms: Date.now() - started });
      return result as ReturnType<typeof toolError>;
    }
    log("tool", { correlation_id: ctx.correlationId, tool, status: "ok", duration_ms: Date.now() - started });
    return toolResult(result);
  } catch (error) {
    const errorCode = error instanceof DomainError ? error.code : "INTERNAL_ERROR";
    log("tool", { correlation_id: ctx.correlationId, tool, status: "error", error_code: errorCode, duration_ms: Date.now() - started });
    return toolError(errorCode);
  }
}

export function registerMcp(app: any, db: Database, config: Config, auth?: Auth) {
  const service = new ArtifactService(db, config);
  const verifier = authVerifier(auth, config);
  const gate = requireBearerAuth({
    verifier,
    requiredScopes: ["artifacts:read"],
    resourceMetadataUrl: `${config.appUrl.origin}/.well-known/oauth-protected-resource/mcp`,
  });
  const mcp = createMcpHandler((ctx) => {
    const server = new McpServer({ name: "portifact", version: "0.1.0" });
    const context = ctx as unknown as ToolContext;
    const ownerId = String(context.authInfo?.extra?.userId ?? "");
    if (!context.correlationId) context.correlationId = crypto.randomUUID();

    server.registerTool(
      "list_artifacts",
      { inputSchema: z.object({ include_deleted: z.boolean().optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }) },
      async ({ include_deleted, cursor: rawCursor, limit }) => invoke(context, "list_artifacts", "artifacts:read", async () => {
        const rows = await service.list(ownerId, include_deleted);
        const startId = cursor(rawCursor);
        const start = startId ? Math.max(rows.findIndex((row) => row.id === startId) + 1, 0) : 0;
        const page = rows.slice(start, start + (limit ?? 50)).map(({ id, name, format, latestVersionId, publishedVersionId, deletedAt, createdAt, updatedAt }) => ({ id, name, format, latestVersionId, publishedVersionId, deletedAt, createdAt, updatedAt }));
        return { items: page, next_cursor: start + page.length < rows.length ? nextCursor(page.at(-1)?.id) : undefined };
      }),
    );

    server.registerTool(
      "get_artifact",
      { inputSchema: z.object({ artifact_id: z.string() }) },
      async ({ artifact_id }) => invoke(context, "get_artifact", "artifacts:read", async () => service.get(ownerId, artifact_id)),
    );

    server.registerTool(
      "list_versions",
      { inputSchema: z.object({ artifact_id: z.string(), cursor: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }) },
      async ({ artifact_id, cursor: rawCursor, limit }) => invoke(context, "list_versions", "artifacts:read", async () => {
        const artifact = await service.get(ownerId, artifact_id);
        const rows = await service.versionsMeta(ownerId, artifact_id);
        const startId = cursor(rawCursor);
        const start = startId ? Math.max(rows.findIndex((row) => row.id === startId) + 1, 0) : 0;
        const page = rows.slice(start, start + (limit ?? 50)).map((version) => ({ ...version, format: artifact.format }));
        return { items: page, next_cursor: start + page.length < rows.length ? nextCursor(page.at(-1)?.id) : undefined };
      }),
    );

    server.registerTool(
      "get_version",
      { inputSchema: z.object({ artifact_id: z.string(), version_id: z.string() }) },
      async ({ artifact_id, version_id }) => invoke(context, "get_version", "artifacts:read", async () => {
        const artifact = await service.get(ownerId, artifact_id);
        const version = await service.version(ownerId, artifact_id, version_id);
        return { ...version, format: artifact.format };
      }),
    );

    server.registerTool(
      "create_artifact",
      { inputSchema: z.object({ name: z.string(), content: z.string(), format: z.enum(ARTIFACT_FORMATS), idempotency_key: z.string().min(1).optional() }) },
      async (input) => invoke(context, "create_artifact", "artifacts:write", async () => idempotent(db, config, context, "create_artifact", input, () => service.create(ownerId, input.name, input.content, input.format, "mcp"))),
    );

    server.registerTool(
      "create_version",
      { inputSchema: z.object({ artifact_id: z.string(), parent_version_id: z.string(), content: z.string(), format: z.enum(ARTIFACT_FORMATS), idempotency_key: z.string().min(1).optional() }) },
      async (input) => invoke(context, "create_version", "artifacts:write", async () => idempotent(db, config, context, "create_version", input, () => service.createVersion(ownerId, input.artifact_id, input.parent_version_id, input.content, input.format))),
    );

    server.registerTool(
      "publish_version",
      { inputSchema: z.object({ artifact_id: z.string(), version_id: z.string(), idempotency_key: z.string().min(1).optional() }) },
      async (input) => invoke(context, "publish_version", "artifacts:publish", async () => idempotent(db, config, context, "publish_version", input, () => service.publish(ownerId, input.artifact_id, input.version_id))),
    );

    return server;
  }, { legacy: "reject", responseMode: "sse" });

  app.mount("/mcp", async (request: Request) => {
    const ctx = newRequestContext(request.headers, "mcp");
    const started = Date.now();
    try {
      const headerError = await validateHeaders(request);
      if (headerError) { requestLog(ctx, headerError.status, Date.now() - started, "PROTOCOL_ERROR"); return headerError; }
      const result = await gate(request);
      if (result instanceof Response) { requestLog(ctx, result.status, Date.now() - started, "UNAUTHORIZED"); return result; }
      const response = await mcp.fetch(request, { authInfo: result });
      requestLog(ctx, response.status, Date.now() - started);
      return response;
    } catch (error) {
      requestLog(ctx, 500, Date.now() - started, error instanceof Error ? error.name : "INTERNAL_ERROR");
      throw error;
    }
  });
  app.get("/.well-known/oauth-protected-resource/mcp", () => Response.json({
    resource: `${config.appUrl.origin}/mcp`,
    authorization_servers: [config.appUrl.origin],
    jwks_uri: `${config.appUrl.origin}/api/auth/.well-known/jwks-access.json`,
    scopes_supported: [...scopes],
    bearer_methods_supported: ["header"],
    resource_signing_alg_values_supported: ["RS256"],
  }));
  app.get("/.well-known/oauth-authorization-server", () => Response.json({
    issuer: config.appUrl.origin,
    authorization_endpoint: `${config.appUrl.origin}/api/auth/mcp/authorize`,
    token_endpoint: `${config.appUrl.origin}/api/auth/mcp/token`,
    registration_endpoint: `${config.appUrl.origin}/api/auth/mcp/register`,
    jwks_uri: `${config.appUrl.origin}/api/auth/.well-known/jwks-access.json`,
    scopes_supported: ["openid", "profile", "email", "offline_access", ...scopes],
    code_challenge_methods_supported: ["S256"],
  }));
  return app;
}

export function registerAccessJwks(app: any, config: Config) {
  app.get("/api/auth/.well-known/jwks-access.json", async () => Response.json(await publicJwks(config)));
  return app;
}
