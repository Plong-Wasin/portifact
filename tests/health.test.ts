import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { createApp } from "../src/app";

test("health live does not require a database", async () => {
  const config = loadConfig({
    APP_ENV: "test",
    APP_URL: "http://localhost",
    PORT: "3000",
    TRUST_PROXY: "false",
    DATABASE_URL: "postgresql://unreachable/portifact",
    REGISTRATION_ENABLED: "false",
  });
  const db = {
    execute: async () => {
      throw new Error("database must not be queried by liveness");
    },
    select: () => {
      throw new Error("database must not be queried by liveness");
    },
  } as never;
  const response = await createApp(db, config).handle(new Request("http://localhost/health/live"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});
