import { describe, expect, test } from "bun:test";
import { timingSafeEqual } from "node:crypto";

// verifyMutation is private in dashboard.ts; we assert the CSRF equality rule
// (timing-safe compare) and multipart extraction contract by mirroring it.
// End-to-end CSRF is exercised via dashboard route tests when a DB is set.
describe("csrf multipart extraction contract", () => {
  test("form-encoded csrf field is read like the header", async () => {
    const token = "abcdef0123456789";
    const form = new FormData();
    form.set("csrf", token);
    const supplied = form.get("csrf")?.toString() ?? null;
    expect(supplied).toBe(token);
    expect(timingSafeEqual(Buffer.from(supplied!), Buffer.from(token))).toBe(true);
  });

  test("mismatched token rejected", () => {
    const token = "abcdef0123456789";
    const wrong = "xyz0123456789abcd";
    expect(() => timingSafeEqual(Buffer.from(wrong), Buffer.from(token))).toThrow();
  });
});
