import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const compose = readFileSync("docker-compose.yml", "utf8");

describe("Docker migration service contract", () => {
  test("runs migrations once and gates app and worker startup", () => {
    expect(compose).toContain("  migrate:");
    expect(compose).toContain("command: bun run db:migrate");
    expect(compose).toContain("condition: service_healthy");
    expect(compose.match(/migrate:\n\s+condition: service_completed_successfully/g)?.length).toBe(2);
  });
});
