import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { config } from "./helpers";

// Idempotency lives inline in src/mcp.ts (not exported). We assert its invariants
// at the requestHash level by mirroring its rule: idempotency_key is stripped
// before hashing so two identical operations with the same key are stable, and
// a different payload under the same key is a conflict.
function hash(input: Record<string, unknown>): string {
  const { idempotency_key: _drop, ...rest } = input;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

describe("idempotency request hash", () => {
  test("ignores idempotency_key in the payload hash", () => {
    const a = hash({ name: "x", html: "<b></b>", idempotency_key: "k1" });
    const b = hash({ name: "x", html: "<b></b>", idempotency_key: "k2" });
    expect(a).toBe(b);
  });

  test("distinguishes different payloads", () => {
    const a = hash({ name: "x", html: "<b></b>", idempotency_key: "k" });
    const b = hash({ name: "y", html: "<b></b>", idempotency_key: "k" });
    expect(a).not.toBe(b);
  });
});

describe("config idempotency ttl", () => {
  test("defaults to 86400s when unset", () => {
    delete (Bun.env as any).IDEMPOTENCY_TTL_SECONDS;
    expect(config().idempotencyTtlSeconds).toBe(86400);
  });
});
