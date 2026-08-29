import { loadConfig } from "./config";
import { createDb } from "./db/client";
import { runWorkerLoop } from "./jobs/worker";
import { log } from "./logger";
import { createErrorTelemetry, flushErrorTelemetry } from "./telemetry";

const config = loadConfig();
const telemetry = createErrorTelemetry(config);
const resources = createDb(config);
let stopping = false;

log("worker_started");

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log("worker_stopping", { signal });
  await Promise.all([
    resources.sql.close({ timeout: config.shutdownTimeoutSeconds }),
    flushErrorTelemetry(telemetry, config.sentryFlushTimeoutMs),
  ]);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await runWorkerLoop(resources.db, () => stopping, telemetry);
log("worker_stopped");
