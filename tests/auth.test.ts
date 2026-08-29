import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { TEST_AUTH_SECRET } from "./helpers";

const baseEnv = {
  APP_ENV: "test",
  APP_URL: "http://localhost",
  PORT: "3000",
  TRUST_PROXY: "false",
  REGISTRATION_ENABLED: "false",
  BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
};

function config(overrides: Record<string, string> = {}) {
  return loadConfig({ ...baseEnv, DATABASE_URL: Bun.env.TEST_DATABASE_URL ?? "", ...overrides });
}

describe.skipIf(!Bun.env.TEST_DATABASE_URL)("auth (needs TEST_DATABASE_URL)", () => {
  test("sign-up is rejected while registration disabled", async () => {
    const { createDb } = await import("../src/db/client");
    const { createAuth } = await import("../src/auth");
    const cfg = config({ REGISTRATION_ENABLED: "false" });
    const resources = createDb(cfg);
    const auth = createAuth(resources.db, cfg);
    let threw = false;
    try {
      await auth.api.signUpEmail({ body: { email: "phase2@example.com", password: "password123", name: "P2" } });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    await resources.sql.close();
  });

  test("sign-up works when enabled; mixed-case sign-in resolves", async () => {
    const { createDb } = await import("../src/db/client");
    const { createAuth } = await import("../src/auth");
    const cfg = config({ REGISTRATION_ENABLED: "true" });
    const resources = createDb(cfg);
    const auth = createAuth(resources.db, cfg);
    const email = `Phase2-${crypto.randomUUID()}@Example.COM`;
    await auth.api.signUpEmail({ body: { email, password: "password123", name: "P2" } });
    const res = await auth.api.signInEmail({
      body: { email: email.toLowerCase(), password: "password123" },
      asResponse: true,
    });
    expect(res.status).toBe(200);
    await resources.sql.close();
  });

  test("wrong password returns a generic unauthorized error", async () => {
    const { createDb } = await import("../src/db/client");
    const { createAuth } = await import("../src/auth");
    const cfg = config({ REGISTRATION_ENABLED: "true" });
    const resources = createDb(cfg);
    const auth = createAuth(resources.db, cfg);
    const email = `wrongpw-${crypto.randomUUID()}@example.com`;
    await auth.api.signUpEmail({ body: { email, password: "password123", name: "P2" } });
    let message = "";
    try {
      await auth.api.signInEmail({ body: { email, password: "wrong-password" } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.toLowerCase()).toContain("password");
    expect(message.toLowerCase()).not.toContain("not found");
    await resources.sql.close();
  });
});
