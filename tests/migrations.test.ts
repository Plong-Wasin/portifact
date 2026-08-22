import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

describe("migration foundation", () => {
  test("ships an initial migration and journal", () => {
    expect(existsSync("drizzle/0000_hard_mordo.sql")).toBe(true);
    expect(existsSync("drizzle/0004_format_neutral_content.sql")).toBe(true);
    expect(existsSync("drizzle/0005_migrate_html_content.sql")).toBe(true);
    expect(existsSync("drizzle/0006_drop_legacy_html_column.sql")).toBe(true);
    expect(existsSync("drizzle/meta/_journal.json")).toBe(true);
  });

  test.skipIf(!Bun.env.TEST_DATABASE_URL)("runs against TEST_DATABASE_URL", async () => {
    const { loadConfig } = await import("../src/config");
    const { runMigrations } = await import("../src/db/migrate");
    const config = loadConfig({
      APP_ENV: "test",
      APP_URL: "http://localhost",
      PORT: "3000",
      TRUST_PROXY: "false",
      DATABASE_URL: Bun.env.TEST_DATABASE_URL,
      REGISTRATION_ENABLED: "false",
    });
    await runMigrations(config);
  });
});
