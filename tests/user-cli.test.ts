import { describe, expect, test } from "bun:test";

describe.skipIf(!Bun.env.TEST_DATABASE_URL)("user cli (needs TEST_DATABASE_URL)", () => {
  test("createUser then reset-password invalidates the prior session", async () => {
    const { loadConfig } = await import("../src/config");
    const { createDb } = await import("../src/db/client");
    const { createAuth } = await import("../src/auth");
    const config = loadConfig({
      APP_ENV: "test",
      APP_URL: "http://localhost",
      PORT: "3000",
      TRUST_PROXY: "false",
      DATABASE_URL: Bun.env.TEST_DATABASE_URL!,
      REGISTRATION_ENABLED: "true",
      BETTER_AUTH_SECRET: "test-secret-must-be-at-least-32-characters-long",
    });
    const resources = createDb(config);
    const auth = createAuth(resources.db, config);
    const email = `cli-${crypto.randomUUID()}@example.com`;
    const created = await auth.api.createUser({ body: { email, name: "CLI", password: "password123", role: "user" } });
    const signIn = await auth.api.signInEmail({ body: { email, password: "password123" }, asResponse: true });
    const cookies = signIn.headers.getSetCookie().join("; ");
    const before = await auth.api.getSession({ headers: new Headers({ cookie: cookies }) });
    expect(before).toBeTruthy();
    const ctx = await auth.$context;
    await ctx.internalAdapter.updatePassword(created.user.id, await ctx.password.hash("newpassword123"));
    await ctx.internalAdapter.deleteUserSessions(created.user.id);
    const after = await auth.api.getSession({ headers: new Headers({ cookie: cookies }) });
    expect(after).toBeNull();
    await resources.sql.close();
  });
});
