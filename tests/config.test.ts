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
    expect(config.maxHtmlBytes).toBe(1048576);
    expect(config.requiredMigrationVersion).toBe(4);
  });

  test("rejects ambiguous booleans", () => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: "yes" })).toThrow("TRUST_PROXY must be true or false");
  });

  test("requires HTTPS for non-local URLs", () => {
    expect(() => loadConfig({ ...base, APP_URL: "http://example.com" })).toThrow("APP_URL must use HTTPS");
  });

  test("rejects storage below one version", () => {
    expect(() => loadConfig({ ...base, MAX_ARTIFACT_HTML_BYTES: "100", MAX_STORAGE_BYTES_PER_USER: "99" })).toThrow();
  });

  test("requires BETTER_AUTH_SECRET", () => {
    expect(() => loadConfig({ ...base, BETTER_AUTH_SECRET: "" })).toThrow("BETTER_AUTH_SECRET");
  });

  test("rejects short secret outside localhost", () => {
    expect(() => loadConfig({ ...base, APP_URL: "http://example.com", BETTER_AUTH_SECRET: "short" })).toThrow();
  });
});
