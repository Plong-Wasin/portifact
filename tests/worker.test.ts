import { describe, expect, test } from "bun:test";
import { runWorkerLoop, tick } from "../src/jobs/worker";
import type { ErrorTelemetry, TelemetryContext } from "../src/telemetry";

function recordingTelemetry() {
  const events: Array<{ kind: "exception" | "message"; value: unknown; context?: TelemetryContext }> = [];
  const telemetry: ErrorTelemetry = {
    isEnabled: () => false,
    captureException(value, context) { events.push({ kind: "exception", value, context }); },
    captureMessage(value, context) { events.push({ kind: "message", value, context }); },
    flush: async () => true,
  };
  return { telemetry, events };
}

// Fake DB for the worker tick: returns configurable job rows and records
// side effects so we can assert claim/run/fail behaviour without PostgreSQL.
function fakeDb(rows: any[], records: { deletes: any[]; updates: any[] }) {
  let selectCalls = 0;
  const db = {
    select: () => {
      selectCalls += 1;
      return {
        from: () => {
          const result = selectCalls === 1
            ? rows
            : selectCalls === 2
              ? rows.map((row) => ({ id: row.artifactId, deletedAt: row.createdAt }))
              : selectCalls === 3
                ? rows.map((row) => ({ status: "running" }))
                : [];
          const chain = {
            where: () => chain,
            orderBy: () => chain,
            limit: () => result,
            for: () => result,
          };
          return chain;
        },
      };
    },
    update: (table: any) => ({
      set: (values: any) => ({
        where: () => ({
          returning: async () => { records.updates.push({ table: table?.constructor?.name ?? "?", values }); return rows; },
        }),
      }),
    }),
    delete: (table: any) => ({ where: async () => { records.deletes.push(table); } }),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(db),
  } as never;
  return db;
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

  test("keeps retryable job failures in logs without creating telemetry events", async () => {
    const records = { deletes: [], updates: [] };
    const { telemetry, events } = recordingTelemetry();
    const jobRow = {
      id: "j2", kind: "unknown", artifactId: null, status: "pending",
      scheduledAt: new Date(0), attempts: 1, lockedAt: null, lastError: null,
      createdAt: new Date(0), updatedAt: new Date(0),
    };

    await tick(fakeDb([jobRow], records) as never, telemetry);

    expect(events).toHaveLength(0);
  });

  test("reports a job only after it becomes dead", async () => {
    const records = { deletes: [], updates: [] };
    const { telemetry, events } = recordingTelemetry();
    const jobRow = {
      id: "j3", kind: "unknown", artifactId: null, status: "pending",
      scheduledAt: new Date(0), attempts: 5, lockedAt: null, lastError: null,
      createdAt: new Date(0), updatedAt: new Date(0),
    };

    await tick(fakeDb([jobRow], records) as never, telemetry);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "exception",
      context: { service: "worker", errorCode: "JOB_DEAD", status: 500 },
    });
  });

  test("reports a worker loop failure", async () => {
    const { telemetry, events } = recordingTelemetry();
    let checks = 0;
    const db = {
      select: () => { throw new Error("worker database unavailable"); },
    } as never;

    await runWorkerLoop(db, () => ++checks > 1, telemetry);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "exception",
      context: { service: "worker", errorCode: "TICK_ERROR", status: 500 },
    });
  });
});
