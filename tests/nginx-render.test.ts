import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const SCRIPT = "nginx/15-render-env.sh";
const skip = !existsSync(SCRIPT);

function run(appHost: string, maxBytes: string): number {
  const r = spawnSync("sh", ["-c", `APP_HOST=${JSON.stringify(appHost)} MAX_ARTIFACT_HTML_BYTES=${JSON.stringify(maxBytes)} sh ${SCRIPT}`], { encoding: "utf8" });
  return r.status ?? -1;
}

describe.skipIf(skip)("nginx env render validation", () => {
  test("rejects APP_HOST with shell metacharacters", () => {
    expect(run("evil;rm -rf /", "1048576")).not.toBe(0);
  });

  test("rejects APP_HOST with whitespace", () => {
    expect(run("evil com", "1048576")).not.toBe(0);
  });

  test("rejects unbracketed IPv6", () => {
    expect(run("::1", "1048576")).not.toBe(0);
  });

  test("rejects zero MAX_ARTIFACT_HTML_BYTES", () => {
    expect(run("example.com", "0")).not.toBe(0);
  });

  test("rejects non-integer MAX_ARTIFACT_HTML_BYTES", () => {
    expect(run("example.com", "1m")).not.toBe(0);
  });

  test("rejects empty MAX_ARTIFACT_HTML_BYTES", () => {
    expect(run("example.com", "")).not.toBe(0);
  });

  test("rejects missing APP_HOST", () => {
    const r = spawnSync("sh", ["-c", `MAX_ARTIFACT_HTML_BYTES=1048576 sh ${SCRIPT}`], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
  });
});
