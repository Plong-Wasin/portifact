import { randomUUID } from "node:crypto";

// Structured JSON logger: every line is a parseable JSON object with an event
// name and optional correlation id, route/tool, status, and duration_ms.
// Secrets are redacted before any value reaches stdout (see redact).

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Normalized (lowercase, punctuation stripped) exact-match set. Exact match
// avoids false positives: "error_code" does not match "code", "statusCode"
// does not match "code". "access_token" and "accesstoken" both normalize to
// "accesstoken" and match.
const SECRET_KEYS = new Set([
  "password", "passwd", "secret", "token", "accesstoken", "refreshtoken",
  "authorization", "cookie", "setcookie", "session", "code",
  "clientsecret", "databaseurl", "sharetoken", "html", "body", "privatekey",
]);

function normalize(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(normalize(key));
}

// Recursively redact secret-looking string values. Returns a shallow-safe copy;
// nested objects/arrays are walked. Numbers/booleans are left alone.
export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? "[redacted]" : redact(v);
    }
    return out;
  }
  return value;
}

let minLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel) {
  minLevel = level;
}

export function log(event: string, fields: Record<string, unknown> = {}, level: LogLevel = "info") {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(fields) as Record<string, unknown>) });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export type RequestContext = { correlationId: string; route?: string; tool?: string };

export function newRequestContext(headers: Headers, route?: string): RequestContext {
  const correlationId = headers.get("x-correlation-id") ?? randomUUID();
  return { correlationId, route };
}

export function requestLog(ctx: RequestContext, status: number, durationMs: number, errorCode?: string) {
  log("request", {
    correlation_id: ctx.correlationId,
    route: ctx.route,
    status,
    duration_ms: durationMs,
    error_code: errorCode,
  });
}
