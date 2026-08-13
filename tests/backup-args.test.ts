import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const BACKUP = "scripts/backup.sh";
const RESTORE = "scripts/restore.sh";
const skip = !existsSync(BACKUP) || !existsSync(RESTORE);

describe.skipIf(skip)("backup/restore argument validation", () => {
  test("backup requires exactly one destination", () => {
    const r = spawnSync("sh", [BACKUP], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "postgresql://u:p@h/d" } });
    expect(r.status).toBe(2);
  });

  test("backup refuses to overwrite an existing file", () => {
    const r = spawnSync("sh", ["-c", `touch /tmp/portifact-exists-$$; DATABASE_URL=postgresql://u:p@h/d sh ${BACKUP} /tmp/portifact-exists-$$`], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
  });

  test("backup requires DATABASE_URL", () => {
    const r = spawnSync("sh", ["-c", `${BACKUP} /tmp/portifact-new-$$`], { encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(r.status).not.toBe(0);
  });

  test("restore requires exactly one file", () => {
    const r = spawnSync("sh", [RESTORE], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "postgresql://u:p@h/d" } });
    expect(r.status).toBe(2);
  });

  test("restore rejects a missing file", () => {
    const r = spawnSync("sh", ["-c", `DATABASE_URL=postgresql://u:p@h/d sh ${RESTORE} /tmp/portifact-nope-$$`], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });

  test("restore requires DATABASE_URL", () => {
    const r = spawnSync("sh", ["-c", `${RESTORE} /tmp/whatever`], { encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(r.status).not.toBe(0);
  });
});
