import { and, eq, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import type { Config } from "../config";
import { artifact, job } from "../db/schema";
import { log } from "../logger";
import { createNoopErrorTelemetry, type ErrorTelemetry } from "../telemetry";

export const JOB_LEASE_SECONDS = 60;
export const MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 5_000;

// Claim one runnable job (due, under attempt cap, not held by an active lease)
// via compare-and-set on status so concurrent workers never run the same job.
async function claimJob(db: Database, now: Date): Promise<typeof job.$inferSelect | undefined> {
  const leaseDeadline = new Date(now.getTime() - JOB_LEASE_SECONDS * 1000);
  const candidate = await db.select().from(job)
    .where(and(
      eq(job.status, "pending"),
      lte(job.scheduledAt, now),
      sql`${job.attempts} < ${MAX_ATTEMPTS}`,
      sql`(${job.lockedAt} is null or ${job.lockedAt} < ${leaseDeadline})`,
    ))
    .orderBy(job.scheduledAt)
    .limit(1);
  const next = candidate[0];
  if (!next) return undefined;
  const [claimed] = await db.update(job)
    .set({ status: "running", lockedAt: now, attempts: next.attempts + 1, updatedAt: now })
    .where(and(eq(job.id, next.id), eq(job.status, "pending")))
    .returning();
  return claimed;
}

// Idempotent permanent purge: deleting the artifact cascades to versions, share
// links, and this job (FK ondelete cascade). Re-running after a partial failure
// is safe — the row is already gone.
async function runJob(db: Database, row: typeof job.$inferSelect): Promise<void> {
  if (row.kind === "purge_artifact") {
    if (row.artifactId) await db.delete(artifact).where(eq(artifact.id, row.artifactId));
    return;
  }
  throw new Error(`unknown job kind: ${row.kind}`);
}

async function failJob(db: Database, row: typeof job.$inferSelect, message: string): Promise<boolean> {
  const dead = row.attempts >= MAX_ATTEMPTS;
  await db.update(job).set({
    status: dead ? "dead" : "pending",
    lockedAt: null,
    lastError: message.slice(0, 500),
    scheduledAt: new Date(Date.now() + Math.min(row.attempts, 10) * 30_000),
    updatedAt: new Date(),
  }).where(eq(job.id, row.id));
  return dead;
}

export async function tick(db: Database, telemetry: ErrorTelemetry = createNoopErrorTelemetry()): Promise<void> {
  const claimed = await claimJob(db, new Date());
  if (!claimed) return;
  try {
    await runJob(db, claimed);
    log("job_completed", { job_id: claimed.id, kind: claimed.kind });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const dead = await failJob(db, claimed, message);
    if (dead) {
      try {
        telemetry.captureException(error, { service: "worker", status: 500, errorCode: "JOB_DEAD" });
      } catch {
        // Telemetry must never alter job state or worker availability.
      }
    }
    log("job_failed", { job_id: claimed.id, kind: claimed.kind, error: message.slice(0, 200) });
  }
}

// Runs until `shouldStop()` returns true. Each iteration claims at most one job,
// so a stop signal is honoured between jobs. A pending tick finishes before exit.
export async function runWorkerLoop(db: Database, shouldStop: () => boolean, telemetry: ErrorTelemetry = createNoopErrorTelemetry()): Promise<void> {
  while (!shouldStop()) {
    await tick(db, telemetry).catch((error) => {
      try {
        telemetry.captureException(error, { service: "worker", status: 500, errorCode: "TICK_ERROR" });
      } catch {
        // Telemetry must never alter worker control flow.
      }
      log("tick_error", { error: String(error).slice(0, 200) }, "error");
    });
    if (shouldStop()) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
