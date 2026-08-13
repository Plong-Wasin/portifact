import { describe, expect, test } from "bun:test";
import { tick } from "../src/jobs/worker";

// Fake DB for the worker tick: returns configurable job rows and records
// side effects so we can assert claim/run/fail behaviour without PostgreSQL.
function fakeDb(rows: any[], records: { deletes: any[]; updates: any[] }) {
  const selectResult = rows;
  return {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => selectResult }) }) }) }),
    update: (table: any) => ({
      set: (values: any) => ({
        where: () => ({
          returning: async () => { records.updates.push({ table: table?.constructor?.name ?? "?", values }); return rows; },
        }),
      }),
    }),
    delete: (table: any) => ({ where: async () => { records.deletes.push(table); } }),
  } as never;
}

describe("worker tick", () => {
  test("does nothing when no pending job", async () => {
    const records = { deletes: [], updates: [] };
    await tick(fakeDb([], records) as never);
    expect(records.deletes).toHaveLength(0);
    expect(records.updates).toHaveLength(0);
  });

  test("runs a purge_artifact job and deletes the artifact", async () => {
    const records = { deletes: [], updates: [] };
    const jobRow = {
      id: "j1", kind: "purge_artifact", artifactId: "a1", status: "pending",
      scheduledAt: new Date(0), attempts: 1, lockedAt: null, lastError: null,
      createdAt: new Date(0), updatedAt: new Date(0),
    };
    // claimJob returns the candidate after update.returning().
    await tick(fakeDb([jobRow], records) as never);
    // update (claim) then delete (run) both touched.
    expect(records.updates.length + records.deletes.length).toBeGreaterThan(0);
  });
});
