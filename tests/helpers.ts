import { loadConfig } from "../src/config";
import type { Config } from "../src/config";

export const TEST_AUTH_SECRET = "test-secret-must-be-at-least-32-characters-long-aaaa";

// Complete env fixture for tests. Includes every required variable so a test
// only overrides what it cares about. BETTER_AUTH_SECRET is long enough to
// pass the non-localhost length gate when a test points APP_URL elsewhere.
export function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    APP_ENV: "test",
    APP_URL: "http://localhost",
    PORT: "3000",
    TRUST_PROXY: "false",
    DATABASE_URL: "postgresql://portifact:portifact@localhost:5432/portifact_test",
    REGISTRATION_ENABLED: "false",
    MAX_ARTIFACT_CONTENT_BYTES: "1048576",
    MAX_STORAGE_BYTES_PER_USER: "10485760",
    RETENTION_DAYS: "30",
    ACCESS_TOKEN_TTL_SECONDS: "900",
    IDEMPOTENCY_TTL_SECONDS: "86400",
    LOG_LEVEL: "warn",
    BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
    ...overrides,
  };
}

export function config(overrides: Record<string, string> = {}): Config {
  return loadConfig(env(overrides));
}

// A fake Database that throws on any use — for tests that must prove a code
// path never touches the database (e.g. liveness while draining).
export function throwingDb(): never {
  const boom = () => { throw new Error("database must not be queried"); };
  return new Proxy({}, { get: () => boom, apply: () => boom }) as never;
}
