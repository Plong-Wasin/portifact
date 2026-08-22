import { describe, expect, test } from "bun:test";
import { previewSandbox, sourcePage } from "../src/routes/dashboard";

describe("artifact document route policy", () => {
  test("source pages retain artifact privacy headers", () => {
    const response = sourcePage("<main><pre>source</pre></main>");

    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("only HTML previews receive script-capable sandbox permissions", () => {
    expect(previewSandbox("html")).toBe('sandbox="allow-scripts"');
    expect(previewSandbox("markdown")).toBe("sandbox");
    expect(previewSandbox("plain_text")).toBe("sandbox");
  });
});
