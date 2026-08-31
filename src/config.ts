const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function required(name: string, value = Bun.env[name]): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function integer(name: string, value: string, min: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) throw new Error(`${name} must be at least ${min}`);
  return parsed;
}

function boolean(name: string, value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function appUrl(value: string, isLocal: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("APP_URL must be a valid URL");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("APP_URL must not contain credentials, query, or fragment");
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("APP_URL must use HTTP or HTTPS");
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("APP_URL must be an origin without a path");
  if (!isLocal && url.protocol !== "https:") throw new Error("APP_URL must use HTTPS for non-local hosts");
  if (url.port !== "" && !localHosts.has(url.hostname)) throw new Error("APP_URL must not specify a port for non-local hosts");
  return url;
}

function appHost(url: URL): string {
  return url.hostname.toLowerCase();
}

function microsoftConfig(env: Record<string, string | undefined>, isProduction: boolean) {
  const clientId = env.MICROSOFT_CLIENT_ID?.trim() || undefined;
  const clientSecret = env.MICROSOFT_CLIENT_SECRET?.trim() || undefined;
  const tenantId = env.MICROSOFT_TENANT_ID?.trim() || undefined;
  const normalizedTenantId = tenantId?.toLowerCase();
  const supplied = [clientId, clientSecret, tenantId].filter(Boolean).length;

  if (isProduction && !clientId) throw new Error("MICROSOFT_CLIENT_ID is required in production");
  if (supplied > 0 && !clientId) throw new Error("MICROSOFT_CLIENT_ID must be configured with Microsoft login");
  if (supplied > 0 && !clientSecret) throw new Error("MICROSOFT_CLIENT_SECRET must be configured with Microsoft login");
  if (supplied > 0 && !tenantId) throw new Error("MICROSOFT_TENANT_ID must be configured with Microsoft login");
  if (isProduction && !clientSecret) throw new Error("MICROSOFT_CLIENT_SECRET is required in production");
  if (isProduction && !tenantId) throw new Error("MICROSOFT_TENANT_ID is required in production");
  if (normalizedTenantId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalizedTenantId)) {
    throw new Error("MICROSOFT_TENANT_ID must be a tenant GUID");
  }

  return clientId && clientSecret && normalizedTenantId ? { clientId, clientSecret, tenantId: normalizedTenantId } : undefined;
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env) {
  const appEnv = env.APP_ENV?.trim() || "development";
  const rawAppUrl = required("APP_URL", env.APP_URL);
  const preliminary = new URL(rawAppUrl);
  const isLocal = localHosts.has(preliminary.hostname);
  const parsedAppUrl = appUrl(rawAppUrl, isLocal);
  const port = integer("PORT", env.PORT?.trim() || "3000", 1);
  const maxContentBytes = integer("MAX_ARTIFACT_CONTENT_BYTES", env.MAX_ARTIFACT_CONTENT_BYTES?.trim() || "1048576", 1);
  const maxStorageBytes = integer("MAX_STORAGE_BYTES_PER_USER", env.MAX_STORAGE_BYTES_PER_USER?.trim() || "1073741824", maxContentBytes);
  const retentionDays = integer("SOFT_DELETE_RETENTION_DAYS", env.SOFT_DELETE_RETENTION_DAYS?.trim() || "30", 1);
  const accessTokenTtlSeconds = integer("ACCESS_TOKEN_TTL_SECONDS", env.ACCESS_TOKEN_TTL_SECONDS?.trim() || "900", 60);
  const idempotencyTtlSeconds = integer("IDEMPOTENCY_TTL_SECONDS", env.IDEMPOTENCY_TTL_SECONDS?.trim() || "86400", 60);
  const shutdownTimeoutSeconds = integer("SHUTDOWN_TIMEOUT_SECONDS", env.SHUTDOWN_TIMEOUT_SECONDS?.trim() || "10", 1);
  const requestedSentryFlushTimeoutMs = integer("SENTRY_FLUSH_TIMEOUT_MS", env.SENTRY_FLUSH_TIMEOUT_MS?.trim() || "2000", 1);
  const logLevel = env.LOG_LEVEL?.trim() || "info";
  if (!["debug", "info", "warn", "error"].includes(logLevel)) throw new Error("LOG_LEVEL must be debug, info, warn, or error");
  const trustProxy = boolean("TRUST_PROXY", env.TRUST_PROXY?.trim() || "false");
  const databaseUrl = required("DATABASE_URL", env.DATABASE_URL);
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error("DATABASE_URL must be a PostgreSQL URL");
  if (trustProxy && parsedAppUrl.hostname === "localhost") throw new Error("TRUST_PROXY cannot be enabled for localhost");
  const betterAuthSecret = required("BETTER_AUTH_SECRET", env.BETTER_AUTH_SECRET);
  if (betterAuthSecret.length < 32) {
    if (appEnv === "production") throw new Error("BETTER_AUTH_SECRET must be at least 32 characters in production");
    if (parsedAppUrl.hostname !== "localhost") throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  }
  const microsoft = microsoftConfig(env, appEnv === "production");

  return {
    appEnv,
    appUrl: parsedAppUrl,
    appHost: appHost(parsedAppUrl),
    isProduction: appEnv === "production",
    isLocal,
    port,
    trustProxy,
    databaseUrl,
    registrationEnabled: boolean("REGISTRATION_ENABLED", env.REGISTRATION_ENABLED?.trim() || "false"),
    maxContentBytes,
    maxStorageBytes,
    retentionDays,
    accessTokenTtlSeconds,
    idempotencyTtlSeconds,
    logLevel: logLevel as "debug" | "info" | "warn" | "error",
    betterAuthSecret,
    microsoft,
    requiredMigrationVersion: 8,
    readyDbTimeoutMs: integer("READY_DB_TIMEOUT_MS", env.READY_DB_TIMEOUT_MS?.trim() || "2000", 100),
    shutdownTimeoutSeconds,
    sentryDsn: env.SENTRY_DSN?.trim() || undefined,
    sentryRelease: env.SENTRY_RELEASE?.trim() || undefined,
    sentryFlushTimeoutMs: Math.min(requestedSentryFlushTimeoutMs, shutdownTimeoutSeconds * 1000),
    accessTokenKeyId: env.ACCESS_TOKEN_KEY_ID?.trim() || "portifact-access-v1",
  } as const;
}

export type Config = ReturnType<typeof loadConfig>;
