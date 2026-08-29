import * as Sentry from "@sentry/bun";
import type { ErrorEvent, Event, Exception, StackFrame } from "@sentry/bun";
import type { Config } from "./config";
import { log } from "./logger";

const MAX_MESSAGE_LENGTH = 200;
const MAX_STACK_LENGTH = 8_000;
const MAX_CONTEXT_LENGTH = 200;
const MAX_CORRELATION_LENGTH = 128;

const ALLOWED_TAGS = new Set(["service", "route", "method", "status", "error_code"]);

// These patterns are intentionally applied to strings, not just object keys.
// Error messages and stack frames can contain credentials or provider payloads
// without preserving the original field names.
const SENSITIVE_ASSIGNMENT = /["']?\b(?:authorization(?:[_-]?(?:header|token|code))?|cookie(?:s|[_-]?header)?|set[_-]?cookie|password(?:[_-]?(?:hash|confirmation|confirm))?|passwd|secret(?:[_-]?key)?|token(?:[_-]?(?:value|type))?|access[_-]?token|refresh[_-]?token|client[_-]?(?:id|secret)|database[_-]?url|code|state|id[_-]?token|email(?:[_-]?address)?|username|user[_-]?(?:id|name)|preferred[_-]?username|display[_-]?name|given[_-]?name|family[_-]?name|account[_-]?(?:id|name)|object[_-]?id|tenant[_-]?id|tid|oid|sid|acct|azp|sub|iss|aud|ver|name|session(?:[_-]?token)?|csrf(?:[_-]?token)?|nonce|verifier|redirect[_-]?uri|authorization[_-]?code|oauth[_-]?(?:code|state)|request(?:[_-]?(?:body|headers?|cookies?|query(?:[_-]?string)?|id))?|response|headers?|body|content|data|query(?:[_-]?string)?|url|path|claims)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;)}\]]+)/gi;
const URL_WITH_QUERY = /\bhttps?:\/\/[^\s]+\?[^\s]+/gi;
const DATABASE_URL = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)\:\/\/[^\s]+/gi;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g;
const BEARER = /\bBearer\s+[^\s,;)}]+/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const AMBIGUOUS_SERIALIZED_FIELD = /(?:\{|\[)[\s\S]*(?:(?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*')|(?:\\["'][^\\"']+\\["'])|(?:[A-Za-z_$][\w$-]*))\s*:/;

let warningLogged = false;
let unhandledRejectionExitInstalled = false;

export type TelemetryContext = {
  service: string;
  route?: string;
  method?: string;
  status?: number;
  errorCode?: string;
  correlationId?: string;
};

export interface ErrorTelemetry {
  isEnabled(): boolean;
  captureException(error: unknown, context?: TelemetryContext): void;
  captureMessage(message: string, context?: TelemetryContext): void;
  flush(timeoutMs?: number): Promise<boolean>;
}

export type SentryApi = {
  init(options: unknown): unknown;
  captureException(error: unknown, context?: unknown): string;
  captureMessage(message: string, context?: unknown): string;
  flush(timeoutMs?: number): Promise<boolean>;
  onUncaughtExceptionIntegration(options?: unknown): unknown;
  onUnhandledRejectionIntegration(options?: unknown): unknown;
  dedupeIntegration(): unknown;
  makeFetchTransport?: (options: unknown) => SentryTransport;
};

export type SentryTransport = {
  send(envelope: unknown): PromiseLike<{ statusCode?: number }>;
  flush(timeoutMs?: number): PromiseLike<boolean>;
};

const sentryApi = Sentry as unknown as SentryApi;

function warnOnce(reason: string) {
  if (warningLogged) return;
  warningLogged = true;
  log("telemetry_unavailable", { reason }, "warn");
}

export function createNoopErrorTelemetry(): ErrorTelemetry {
  return {
    isEnabled: () => false,
    captureException() {},
    captureMessage() {},
    flush: async () => true,
  };
}

export function isValidSentryDsn(value: string): boolean {
  try {
    const url = new URL(value);
    if (!(["http:", "https:"].includes(url.protocol) && url.username && !url.password)) return false;
    if (url.search || url.hash) return false;
    const pathParts = url.pathname.split("/").filter(Boolean);
    return /^\d+$/.test(pathParts.at(-1) ?? "");
  } catch {
    return false;
  }
}

function sanitizedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = value
    .replace(URL_WITH_QUERY, "[redacted-url]")
    .replace(DATABASE_URL, "[redacted-url]")
    .replace(JWT, "[redacted-token]")
    .replace(BEARER, "[redacted-token]")
    .replace(SENSITIVE_ASSIGNMENT, "[redacted]")
    .replace(EMAIL, "[redacted-email]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (AMBIGUOUS_SERIALIZED_FIELD.test(safe)) return undefined;
  return safe.slice(0, maxLength);
}

function sanitizeFrame(value: unknown): StackFrame | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const frame = value as Record<string, unknown>;
  const out: StackFrame = {};
  for (const key of ["filename", "function", "module", "platform", "abs_path"] as const) {
    const stringValue = sanitizedString(frame[key], MAX_CONTEXT_LENGTH);
    if (stringValue !== undefined) out[key] = stringValue;
  }
  for (const key of ["lineno", "colno"] as const) {
    if (typeof frame[key] === "number" && Number.isFinite(frame[key])) out[key] = frame[key];
  }
  if (typeof frame.in_app === "boolean") out.in_app = frame.in_app;
  const contextLine = sanitizedString(frame.context_line, MAX_CONTEXT_LENGTH);
  if (contextLine !== undefined) out.context_line = contextLine;
  return Object.keys(out).length ? out : undefined;
}

function sanitizeException(value: Event["exception"]): Event["exception"] | undefined {
  if (!value || !Array.isArray(value.values)) return undefined;
  const values: Exception[] = [];
  for (const item of value.values) {
    if (!item || typeof item !== "object") continue;
    const exception = item as Exception;
    const out: Exception = {};
    const type = sanitizedString(exception.type, MAX_CONTEXT_LENGTH);
    const message = sanitizedString(exception.value, MAX_MESSAGE_LENGTH);
    if (type !== undefined) out.type = type;
    if (message !== undefined) out.value = message;
    let frames = exception.stacktrace?.frames
      ?.map(sanitizeFrame)
      .filter((frame): frame is StackFrame => frame !== undefined);
    while (frames && frames.length > 1 && JSON.stringify(frames).length > MAX_STACK_LENGTH) frames = frames.slice(1);
    if (frames?.length && JSON.stringify(frames).length <= MAX_STACK_LENGTH) out.stacktrace = { frames };
    if (Object.keys(out).length) values.push(out);
  }
  return values.length ? { values } : undefined;
}

function sanitizeTags(value: Event["tags"]): Event["tags"] | undefined {
  if (!value) return undefined;
  const tags: Record<string, string | number | boolean> = {};
  for (const [key, tagValue] of Object.entries(value)) {
    if (!ALLOWED_TAGS.has(key)) continue;
    if (typeof tagValue === "string") {
      const safe = sanitizedString(tagValue, MAX_CONTEXT_LENGTH);
      if (safe !== undefined) tags[key] = safe;
    } else if ((typeof tagValue === "number" && Number.isFinite(tagValue)) || typeof tagValue === "boolean") {
      tags[key] = tagValue;
    }
  }
  return Object.keys(tags).length ? tags : undefined;
}

export function sanitizeEvent(event: Event): Event | null {
  const out: Event = {};
  if (event.event_id) out.event_id = event.event_id;
  if (event.timestamp) out.timestamp = event.timestamp;
  if (event.level) out.level = event.level;
  if (event.environment) out.environment = sanitizedString(event.environment, MAX_CONTEXT_LENGTH);
  if (event.release) out.release = sanitizedString(event.release, MAX_CONTEXT_LENGTH);
  if (event.message) out.message = sanitizedString(event.message, MAX_MESSAGE_LENGTH);

  const exception = sanitizeException(event.exception);
  if (exception) out.exception = exception;
  const tags = sanitizeTags(event.tags);
  if (tags) out.tags = tags;

  const correlationId = sanitizedString(event.extra?.correlation_id, MAX_CORRELATION_LENGTH);
  if (correlationId) out.extra = { correlation_id: correlationId };

  if (!out.message && !out.exception) return null;
  return out;
}

function captureContext(context: TelemetryContext | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const tags: Record<string, string | number> = { service: context.service };
  if (context.route) tags.route = context.route;
  if (context.method) tags.method = context.method;
  if (context.status !== undefined) tags.status = context.status;
  if (context.errorCode) tags.error_code = context.errorCode;
  return {
    tags,
    ...(context.correlationId ? { extra: { correlation_id: context.correlationId } } : {}),
  };
}

function boundedFlush(flush: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const boundedTimeoutMs = Math.max(1, timeoutMs);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, boundedTimeoutMs);
    Promise.resolve()
      .then(flush)
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      });
  });
}

export function createSentryTelemetry(config: Config, sdk: SentryApi = sentryApi): ErrorTelemetry {
  const dsn = config.sentryDsn;
  if (!dsn) return createNoopErrorTelemetry();
  if (!isValidSentryDsn(dsn)) {
    warnOnce("invalid_dsn");
    return createNoopErrorTelemetry();
  }

  let deliveryFailed = false;
  try {
    const transport = sdk.makeFetchTransport
      ? (options: unknown): SentryTransport => {
        const inner = sdk.makeFetchTransport!(options);
        return {
          async send(envelope) {
            try {
              const result = await inner.send(envelope);
              if ((result.statusCode ?? 200) >= 400) {
                deliveryFailed = true;
                warnOnce("delivery_failed");
              }
              return result;
            } catch {
              deliveryFailed = true;
              warnOnce("delivery_failed");
              return {};
            }
          },
          async flush(timeoutMs) {
            try {
              const flushed = await inner.flush(timeoutMs);
              return flushed && !deliveryFailed;
            } catch {
              deliveryFailed = true;
              warnOnce("flush_failed");
              return false;
            }
          },
        };
      }
      : undefined;
    sdk.init({
      dsn,
      environment: config.appEnv,
      // An explicit empty release suppresses @sentry/node's CI/git release
      // auto-detection while keeping the field absent from emitted events.
      release: config.sentryRelease ?? "",
      sendDefaultPii: false,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: { request: false, response: false },
        httpBodies: [],
        urlQueryParams: false,
        databaseQueryData: false,
        stackFrameVariables: false,
        frameContextLines: 0,
      },
      defaultIntegrations: false,
      integrations: [
        sdk.onUncaughtExceptionIntegration({
          onFatalError: () => {
            void boundedFlush(() => sdk.flush(config.sentryFlushTimeoutMs), config.sentryFlushTimeoutMs)
              .then(() => process.exit(1));
          },
        }),
        // Capture rejected promises without allowing the SDK to print the raw
        // rejection reason. The process-level exit hook below flushes first.
        sdk.onUnhandledRejectionIntegration({ mode: "none" }),
        sdk.dedupeIntegration(),
      ],
      beforeSend: (event: ErrorEvent) => sanitizeEvent(event) as ErrorEvent | null,
      attachStacktrace: false,
      maxBreadcrumbs: 0,
      enableLogs: false,
      enableMetrics: false,
      sendClientReports: false,
      shutdownTimeout: config.sentryFlushTimeoutMs,
      ...(transport ? { transport } : {}),
    });
  } catch {
    warnOnce("initialization_failed");
    return createNoopErrorTelemetry();
  }

  if (sdk === sentryApi && !unhandledRejectionExitInstalled) {
    unhandledRejectionExitInstalled = true;
    process.once("unhandledRejection", () => {
      void boundedFlush(() => sdk.flush(config.sentryFlushTimeoutMs), config.sentryFlushTimeoutMs)
        .then(() => process.exit(1));
    });
  }

  const seenObjects = new WeakSet<object>();
  const seenPrimitives = new Set<string>();
  const alreadyCaptured = (error: unknown): boolean => {
    if ((typeof error === "object" && error !== null) || typeof error === "function") {
      const object = error as object;
      if (seenObjects.has(object)) return true;
      seenObjects.add(object);
      return false;
    }
    const key = `${typeof error}:${String(error)}`;
    if (seenPrimitives.has(key)) return true;
    seenPrimitives.add(key);
    return false;
  };

  return {
    isEnabled: () => true,
    captureException(error, context) {
      if (alreadyCaptured(error)) return;
      try {
        sdk.captureException(error, captureContext(context));
      } catch {
        warnOnce("capture_failed");
      }
    },
    captureMessage(message, context) {
      try {
        sdk.captureMessage(message, { level: "error", ...captureContext(context) });
      } catch {
        warnOnce("capture_failed");
      }
    },
    flush(timeoutMs = config.sentryFlushTimeoutMs) {
      const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs, config.sentryFlushTimeoutMs));
      return boundedFlush(() => sdk.flush(effectiveTimeoutMs), effectiveTimeoutMs)
        .then((flushed) => {
          if (!flushed || deliveryFailed) warnOnce("flush_failed");
          return flushed && !deliveryFailed;
        });
    },
  };
}

export function flushErrorTelemetry(telemetry: ErrorTelemetry, timeoutMs: number): Promise<boolean> {
  return boundedFlush(() => telemetry.flush(timeoutMs), timeoutMs);
}

export function createErrorTelemetry(config: Config, sdk: SentryApi = sentryApi): ErrorTelemetry {
  return config.sentryDsn ? createSentryTelemetry(config, sdk) : createNoopErrorTelemetry();
}
