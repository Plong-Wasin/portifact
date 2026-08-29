import { loadConfig } from "./config";
import { createDb } from "./db/client";
import { runWorkerLoop } from "./jobs/worker";
import { log } from "./logger";
import { createErrorTelemetry, flushErrorTelemetry } from "./telemetry";
import { errorCodeOf } from "./error-utils";

const config = loadConfig();
const telemetry = createErrorTelemetry(config);
let resources: ReturnType<typeof createDb> | undefined;
let stopping = false;

try {
  resources = createDb(config);
  log("worker_started");
} catch (error) {
  try {
    telemetry.captureException(error, { service: "worker", status: 500, errorCode: errorCodeOf(error, "STARTUP_FAILED") });
    await flushErrorTelemetry(telemetry, config.sentryFlushTimeoutMs);
  } catch {
    // Telemetry must never hide a worker startup failure.
  }
  try {
    await resources?.sql.close();
  } catch {
    // Cleanup must never hide the original startup failure.
  }
  throw error;
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log("worker_stopping", { signal });
  await Promise.all([
    resources!.sql.close({ timeout: config.shutdownTimeoutSeconds }),
    flushErrorTelemetry(telemetry, config.sentryFlushTimeoutMs),
  ]);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await runWorkerLoop(resources!.db, () => stopping, telemetry);
log("worker_stopped");
