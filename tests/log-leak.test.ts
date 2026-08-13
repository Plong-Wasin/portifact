import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { redact } from "../src/logger";

// Scan all TS source under src/ for patterns that would leak secrets into logs.
// The redaction layer catches secret KEYS, but a direct interpolation of a
// secret value (e.g. `${token}`, `${config.databaseUrl}`) bypasses redaction
// because it is already concatenated into a string field. This test fails if
// any such direct leak is introduced.
const ROOT = "src";
const PATTERNS: RegExp[] = [
  /\$\{[^}]*password[^}]*\}/i,
  /\$\{[^}]*secret[^}]*\}/i,
  /\$\{[^}]*databaseUrl[^}]*\}/i,
  /\$\{[^}]*shareLinkEncryptionKey[^}]*\}/i,
  /\$\{[^}]*betterAuthSecret[^}]*\}/i,
  /\$\{[^}]*clientSecret[^}]*\}/i,
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

describe("logs do not leak secrets", () => {
  test("no source file interpolates a secret value into a string", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const text = readFileSync(file, "utf8");
      for (const re of PATTERNS) {
        const m = re.exec(text);
        if (m) offenders.push(`${relative(".", file)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("logger redact covers the canonical secret key set", () => {
    const sample = {
      password: "x", secret: "x", token: "x", access_token: "x", refresh_token: "x",
      authorization: "x", cookie: "x", session: "x", code: "x", client_secret: "x",
      database_url: "x", html: "x",
    };
    const out = redact(sample) as Record<string, string>;
    for (const key of Object.keys(out)) {
      expect(out[key]).toBe("[redacted]");
    }
  });
});
