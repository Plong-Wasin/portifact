import { describe, expect, mock, test } from "bun:test";
import { redact } from "../src/logger";

describe("redact", () => {
  test("redacts secret keys at any depth", () => {
    const out = redact({
      password: "hunter2",
      nested: { access_token: "abc", safe: "keep" },
      authorization: "Bearer x",
      list: [{ client_secret: "s" }, { name: "show" }],
      database_url: "postgres://u:p@h/db",
    }) as Record<string, any>;
    expect(out.password).toBe("[redacted]");
    expect(out.nested.access_token).toBe("[redacted]");
    expect(out.nested.safe).toBe("keep");
    expect(out.authorization).toBe("[redacted]");
    expect(out.list[0].client_secret).toBe("[redacted]");
    expect(out.list[1].name).toBe("show");
    expect(out.database_url).toBe("[redacted]");
  });

  test("does NOT redact benign keys that merely contain a secret substring", () => {
    const out = redact({
      error_code: "ARTIFACT_NOT_FOUND",
      status_code: 403,
      session_id: "abc",
      html_bytes: 1024,
    }) as Record<string, any>;
    expect(out.error_code).toBe("ARTIFACT_NOT_FOUND");
    expect(out.status_code).toBe(403);
    expect(out.session_id).toBe("abc");
    expect(out.html_bytes).toBe(1024);
  });

  test("leaves non-secret values untouched", () => {
    const out = redact({ name: "artifact", bytes: 42, ok: true }) as Record<string, any>;
    expect(out).toEqual({ name: "artifact", bytes: 42, ok: true });
  });

  test("handles primitives and null", () => {
    expect(redact("plain")).toBe("plain");
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });
});
