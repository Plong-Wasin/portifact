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

// Idempotent permanent purge: deleting the artifact cascades to versions,
// access grants, pins, and this job (FK ondelete cascade). The job and deletion timestamp
// are checked in the same transaction so a restored/re-deleted artifact cannot be removed
// by a stale worker lease.
async function runJob(db: Database, row: typeof job.$inferSelect): Promise<void> {
  if (row.kind === "purge_artifact") {
    if (!row.artifactId) return;
    await db.transaction(async (tx) => {
      const [currentArtifact] = await tx.select({ id: artifact.id, deletedAt: artifact.deletedAt }).from(artifact)
        .where(eq(artifact.id, row.artifactId!)).for("update");
      const [currentJob] = await tx.select({ status: job.status }).from(job).where(eq(job.id, row.id)).for("update");
      if (!currentJob || currentJob.status !== "running") return;
      if (!currentArtifact || currentArtifact.deletedAt?.getTime() !== row.createdAt.getTime()) {
        // A restore or a newer delete superseded this job. Do not leave a stale
        // running row behind, and never delete the newer artifact state.
        await tx.delete(job).where(eq(job.id, row.id));
        return;
      }
      await tx.delete(artifact).where(eq(artifact.id, currentArtifact.id));
    });
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
