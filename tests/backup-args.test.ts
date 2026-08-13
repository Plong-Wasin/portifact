import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const BACKUP = "scripts/backup.sh";
const RESTORE = "scripts/restore.sh";
const skip = !existsSync(BACKUP) || !existsSync(RESTORE);
const DSN = "postgresql://u:p@h/d";

describe.skipIf(skip)("backup/restore argument validation", () => {
  test("backup requires exactly one destination", () => {
    const r = spawnSync("bash", [BACKUP], { encoding: "utf8", env: { ...process.env, DATABASE_URL: DSN } });
    expect(r.status).toBe(2);
  });

  test("backup refuses to overwrite an existing file", () => {
    const r = spawnSync("bash", ["-c", `f=$(mktemp); DATABASE_URL=${DSN} bash ${BACKUP} "$f"`], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
  });

  test("backup requires DATABASE_URL", () => {
    const r = spawnSync("bash", ["-c", `bash ${BACKUP} /tmp/portifact-new-$$`], { encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(r.status).not.toBe(0);
  });

  test("restore requires exactly one file", () => {
    const r = spawnSync("bash", [RESTORE], { encoding: "utf8", env: { ...process.env, DATABASE_URL: DSN } });
    expect(r.status).toBe(2);
  });

  test("restore rejects a missing file", () => {
    const r = spawnSync("bash", ["-c", `DATABASE_URL=${DSN} bash ${RESTORE} /tmp/portifact-nope-$$`], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });

  test("restore requires DATABASE_URL", () => {
    const r = spawnSync("bash", ["-c", `bash ${RESTORE} /tmp/whatever`], { encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(r.status).not.toBe(0);
  });
});
