import { loadConfig } from "./config";
import { createSentryTelemetry, isValidSentryDsn } from "./telemetry";

if (import.meta.main) {
  if (Bun.env.SENTRY_SMOKE_TEST !== "true") {
    console.error("SENTRY_SMOKE_TEST=true is required; no telemetry event was sent");
    process.exitCode = 2;
  } else {
    try {
      const config = loadConfig();
      if (!config.sentryDsn || !isValidSentryDsn(config.sentryDsn)) {
        throw new Error("SENTRY_DSN must be a valid Sentry-compatible DSN");
      }
      const telemetry = createSentryTelemetry(config);
      if (!telemetry.isEnabled()) throw new Error("telemetry initialization failed");
      telemetry.captureMessage("Portifact telemetry smoke test", { service: "smoke" });
      if (!await telemetry.flush(config.sentryFlushTimeoutMs)) throw new Error("telemetry flush timed out or failed");
      console.log(JSON.stringify({ event: "telemetry_smoke_sent", environment: config.appEnv }));
    } catch (error) {
      console.error(JSON.stringify({
        event: "telemetry_smoke_failed",
        error: error instanceof Error ? error.message : "unknown error",
      }));
      process.exitCode = 1;
    }
  }
}
