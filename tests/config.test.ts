import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const base = {
  APP_ENV: "development",
  APP_URL: "http://localhost",
  PORT: "3000",
  TRUST_PROXY: "false",
  DATABASE_URL: "postgresql://user:pass@localhost/db",
  REGISTRATION_ENABLED: "false",
  BETTER_AUTH_SECRET: "local-test-secret-must-be-at-least-32-chars-long",
};

describe("loadConfig", () => {
  test("loads safe defaults", () => {
    const config = loadConfig(base);
    expect(config.registrationEnabled).toBe(false);
    expect(config.maxContentBytes).toBe(1048576);
    expect(config.requiredMigrationVersion).toBe(8);
    expect(config.microsoft).toBeUndefined();
    expect(config.sentryDsn).toBeUndefined();
    expect(config.sentryRelease).toBeUndefined();
    expect(config.sentryFlushTimeoutMs).toBe(2000);
  });

  test("loads optional telemetry settings and bounds its flush timeout", () => {
    const config = loadConfig({
      ...base,
      SHUTDOWN_TIMEOUT_SECONDS: "3",
      SENTRY_DSN: " https://public@example.com/42 ",
      SENTRY_RELEASE: " release-abc ",
      SENTRY_FLUSH_TIMEOUT_MS: "5000",
    });

    expect(config.sentryDsn).toBe("https://public@example.com/42");
    expect(config.sentryRelease).toBe("release-abc");
    expect(config.sentryFlushTimeoutMs).toBe(3000);
  });

  test("rejects a non-positive telemetry flush timeout", () => {
    expect(() => loadConfig({ ...base, SENTRY_FLUSH_TIMEOUT_MS: "0" })).toThrow("SENTRY_FLUSH_TIMEOUT_MS");
  });

  test("loads Microsoft configuration when all credentials are supplied", () => {
    const config = loadConfig({
      ...base,
      MICROSOFT_CLIENT_ID: "client-id",
      MICROSOFT_CLIENT_SECRET: "client-secret",
      MICROSOFT_TENANT_ID: "11111111-2222-3333-4444-555555555555",
    });
    expect(config.microsoft).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      tenantId: "11111111-2222-3333-4444-555555555555",
    });
  });

  test("requires complete Microsoft configuration in production", () => {
    const production = {
      ...base,
      APP_ENV: "production",
      APP_URL: "https://portifact.example.com",
      MICROSOFT_CLIENT_ID: "client-id",
      MICROSOFT_CLIENT_SECRET: "client-secret",
      MICROSOFT_TENANT_ID: "11111111-2222-3333-4444-555555555555",
    };
    expect(loadConfig(production).microsoft).toBeDefined();
    expect(() => loadConfig({ ...production, MICROSOFT_CLIENT_ID: "" })).toThrow("MICROSOFT_CLIENT_ID");
    expect(() => loadConfig({ ...production, MICROSOFT_CLIENT_SECRET: "" })).toThrow("MICROSOFT_CLIENT_SECRET");
    expect(() => loadConfig({ ...production, MICROSOFT_TENANT_ID: "" })).toThrow("MICROSOFT_TENANT_ID");
  });

  test("accepts only a concrete Microsoft tenant ID", () => {
    const env = {
      ...base,
      MICROSOFT_CLIENT_ID: "client-id",
      MICROSOFT_CLIENT_SECRET: "client-secret",
      MICROSOFT_TENANT_ID: "common",
    };
    expect(() => loadConfig(env)).toThrow("MICROSOFT_TENANT_ID");
  });

  test("rejects ambiguous booleans", () => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: "yes" })).toThrow("TRUST_PROXY must be true or false");
  });

  test("requires HTTPS for non-local URLs", () => {
    expect(() => loadConfig({ ...base, APP_URL: "http://example.com" })).toThrow("APP_URL must use HTTPS");
  });

  test("rejects storage below one version", () => {
    expect(() => loadConfig({ ...base, MAX_ARTIFACT_CONTENT_BYTES: "100", MAX_STORAGE_BYTES_PER_USER: "99" })).toThrow();
  });

  test("requires BETTER_AUTH_SECRET", () => {
    expect(() => loadConfig({ ...base, BETTER_AUTH_SECRET: "" })).toThrow("BETTER_AUTH_SECRET");
  });

  test("rejects short secret outside localhost", () => {
    expect(() => loadConfig({ ...base, APP_URL: "http://example.com", BETTER_AUTH_SECRET: "short" })).toThrow();
  });
});
