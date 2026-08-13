import { loadConfig } from "./config";
import { createDb } from "./db/client";
import { runWorkerLoop } from "./jobs/worker";
import { log } from "./logger";

const config = loadConfig();
const resources = createDb(config);
let stopping = false;

log("worker_started");

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log("worker_stopping", { signal });
  await resources.sql.close({ timeout: config.shutdownTimeoutSeconds });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await runWorkerLoop(resources.db, () => stopping);
log("worker_stopped");
