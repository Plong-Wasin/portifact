import { describe, expect, mock, test } from "bun:test";
import { createApp } from "../src/app";
import {
  createErrorTelemetry,
  createSentryTelemetry,
  flushErrorTelemetry,
  sanitizeEvent,
  type ErrorTelemetry,
  type TelemetryContext,
} from "../src/telemetry";
import { config } from "./helpers";

function recordingTelemetry() {
  const events: Array<{ kind: "exception" | "message"; value: unknown; context?: TelemetryContext }> = [];
  const telemetry: ErrorTelemetry = {
    isEnabled: () => false,
    captureException(value, context) { events.push({ kind: "exception", value, context }); },
    captureMessage(value, context) { events.push({ kind: "message", value, context }); },
    flush: mock(async () => true),
  };
  return { telemetry, events };
}

describe("telemetry configuration and privacy", () => {
  test("does nothing when telemetry is disabled", async () => {
    const sdk = {
      init: mock(() => undefined),
      captureException: mock(() => "event"),
      captureMessage: mock(() => "event"),
      flush: mock(async () => true),
      onUncaughtExceptionIntegration: mock(() => ({ name: "uncaught" })),
      onUnhandledRejectionIntegration: mock(() => ({ name: "rejection" })),
      dedupeIntegration: mock(() => ({ name: "dedupe" })),
      makeFetchTransport: undefined,
    };
    const telemetry = createErrorTelemetry(config(), sdk);

    expect(telemetry.isEnabled()).toBe(false);
    telemetry.captureException(new Error("must not be sent"));
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sdk.captureException).not.toHaveBeenCalled();
    expect(await telemetry.flush()).toBe(true);
  });

  test("initializes the SDK with safe defaults and captures one event per exception", () => {
    let initializedOptions: Record<string, any> | undefined;
    const sdk = {
      init: mock((options: unknown) => { initializedOptions = options as Record<string, any>; }),
      captureException: mock(() => "event"),
      captureMessage: mock(() => "event"),
      flush: mock(async () => true),
      onUncaughtExceptionIntegration: mock(() => ({ name: "uncaught" })),
      onUnhandledRejectionIntegration: mock(() => ({ name: "rejection" })),
      dedupeIntegration: mock(() => ({ name: "dedupe" })),
      makeFetchTransport: undefined,
    };
    const telemetry = createSentryTelemetry(config({
      SENTRY_DSN: "https://public@example.com/42",
      SENTRY_RELEASE: "release-abc",
    }), sdk);
    const error = new Error("database connection failed");

    expect(telemetry.isEnabled()).toBe(true);

    telemetry.captureException(error, {
      service: "app",
      route: "/api/auth/callback/microsoft",
      method: "GET",
      status: 500,
      errorCode: "INTERNAL_ERROR",
      correlationId: "correlation-1",
    });
    telemetry.captureException(error, { service: "app", status: 500 });

    expect(sdk.init).toHaveBeenCalledTimes(1);
    const options = initializedOptions!;
    expect(options).toBeDefined();
    expect(options.dsn).toBe("https://public@example.com/42");
    expect(options.environment).toBe("test");
    expect(options.release).toBe("release-abc");
    expect(options.sendDefaultPii).toBe(false);
    expect(options.defaultIntegrations).toBe(false);
    expect(sdk.onUncaughtExceptionIntegration).toHaveBeenCalledTimes(1);
    expect(sdk.onUncaughtExceptionIntegration).toHaveBeenCalledWith({ onFatalError: expect.any(Function) });
    expect(sdk.onUnhandledRejectionIntegration).toHaveBeenCalledWith({ mode: "none" });
    expect(sdk.dedupeIntegration).toHaveBeenCalledTimes(1);
    expect(options.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    });
    expect(sdk.captureException).toHaveBeenCalledTimes(1);
  });

  test("suppresses SDK release auto-detection when no release is configured", () => {
    let initializedOptions: Record<string, any> | undefined;
    const sdk = {
      init: mock((options: unknown) => { initializedOptions = options as Record<string, any>; }),
      captureException: mock(() => "event"),
      captureMessage: mock(() => "event"),
      flush: mock(async () => true),
      onUncaughtExceptionIntegration: mock(() => ({ name: "uncaught" })),
      onUnhandledRejectionIntegration: mock(() => ({ name: "rejection" })),
      dedupeIntegration: mock(() => ({ name: "dedupe" })),
      makeFetchTransport: undefined,
    };

    createSentryTelemetry(config({ SENTRY_DSN: "https://public@example.com/42" }), sdk);

    expect(initializedOptions?.release).toBe("");
  });

  test("malformed DSNs fail open without initializing the SDK", () => {
    const sdk = {
      init: mock(() => { throw new Error("bad DSN"); }),
      captureException: mock(() => "event"),
      captureMessage: mock(() => "event"),
      flush: mock(async () => true),
      onUncaughtExceptionIntegration: mock(() => ({ name: "uncaught" })),
      onUnhandledRejectionIntegration: mock(() => ({ name: "rejection" })),
      dedupeIntegration: mock(() => ({ name: "dedupe" })),
      makeFetchTransport: undefined,
    };

    expect(() => createErrorTelemetry(config({ SENTRY_DSN: "not-a-dsn" }), sdk)).not.toThrow();
    expect(sdk.init).not.toHaveBeenCalled();
  });

  test("sanitizes request-like fields and sensitive strings", () => {
    const out = sanitizeEvent({
      message: "OAuth failed for person@example.com password=secret code=oauth-code database_url=postgresql://user:pass@example/db",
      request: {
        url: "https://portifact.example/api/auth/callback?code=secret&state=secret",
        headers: { authorization: "Bearer secret", cookie: "session=secret" },
        data: "artifact content",
      },
      user: { email: "person@example.com", id: "user-1" },
      contexts: { identity: { email: "person@example.com", tid: "tenant" } },
      tags: {
        service: "app",
        route: "/api/auth/callback/microsoft",
        method: "GET",
        status: 500,
        error_code: "INTERNAL_ERROR",
        correlation_id: "must-not-be-a-tag",
        unsafe: "must-not-survive",
      },
      extra: { correlation_id: "correlation-1", token: "secret", email: "person@example.com" },
      exception: {
        values: [{
          type: "Error",
          value: "password=secret person@example.com",
          stacktrace: { frames: [{ filename: "src/auth.ts", vars: { password: "secret" } }] },
        }],
      },
    });

    expect(out).not.toBeNull();
    expect(out?.request).toBeUndefined();
    expect(out?.user).toBeUndefined();
    expect(out?.contexts).toBeUndefined();
    expect(out?.tags).toEqual({
      service: "app",
      route: "/api/auth/callback/microsoft",
      method: "GET",
      status: 500,
      error_code: "INTERNAL_ERROR",
    });
    expect(out?.extra).toEqual({ correlation_id: "correlation-1" });
    expect(JSON.stringify(out)).not.toContain("secret");
    expect(JSON.stringify(out)).not.toContain("person@example.com");
    expect(out?.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars).toBeUndefined();
  });

  test("sanitizes sensitive fields in serialized JSON error messages", () => {
    const out = sanitizeEvent({
      message: String.raw`{"code":"oauth-secret","state":"state-secret","accessToken":"access-secret"}`,
    });

    expect(out).not.toBeNull();
    expect(JSON.stringify(out)).not.toContain("oauth-secret");
    expect(JSON.stringify(out)).not.toContain("state-secret");
    expect(JSON.stringify(out)).not.toContain("access-secret");
  });

  test("drops an event when a serialized object remains ambiguous", () => {
    const out = sanitizeEvent({ message: String.raw`{"metadata":{"unknown":"value"}}` });

    expect(out).toBeNull();
  });

  test("bounds messages and stack traces", () => {
    const out = sanitizeEvent({
      message: "m".repeat(500),
      exception: {
        values: [{
          type: "Error",
          value: "v".repeat(500),
          stacktrace: { frames: Array.from({ length: 100 }, (_, index) => ({ filename: `src/file-${index}.ts`, function: "handler" })) },
        }],
      },
    });

    expect(out?.message).toHaveLength(200);
    expect(out?.exception?.values?.[0]?.value).toHaveLength(200);
    expect(JSON.stringify(out?.exception?.values?.[0]?.stacktrace).length).toBeLessThanOrEqual(8_000);
  });

  test("keeps flush bounded when the transport hangs", async () => {
    const sdk = {
      init: mock(() => undefined),
      captureException: mock(() => "event"),
      captureMessage: mock(() => "event"),
      flush: mock(() => new Promise<boolean>(() => {})),
      onUncaughtExceptionIntegration: mock(() => ({ name: "uncaught" })),
      onUnhandledRejectionIntegration: mock(() => ({ name: "rejection" })),
      dedupeIntegration: mock(() => ({ name: "dedupe" })),
      makeFetchTransport: undefined,
    };
    const telemetry = createSentryTelemetry(config({
      SENTRY_DSN: "https://public@example.com/42",
      SENTRY_FLUSH_TIMEOUT_MS: "5",
    }), sdk);
    const started = Date.now();

    expect(await telemetry.flush()).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });

  test("keeps application shutdown flush bounded", async () => {
    const telemetry: ErrorTelemetry = {
      isEnabled: () => true,
      captureException() {},
      captureMessage() {},
      flush: () => new Promise<boolean>(() => {}),
    };
    const started = Date.now();

    expect(await flushErrorTelemetry(telemetry, 5)).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });

  test("degrades transport failures without affecting the caller", async () => {
    let initializedOptions: Record<string, any> | undefined;
    const sdk = {
      init: mock((options: unknown) => { initializedOptions = options as Record<string, any>; }),
      captureException: mock(() => "event"),
      captureMessage: mock(() => "event"),
      flush: mock(async () => true),
      onUncaughtExceptionIntegration: mock(() => ({ name: "uncaught" })),
      onUnhandledRejectionIntegration: mock(() => ({ name: "rejection" })),
      dedupeIntegration: mock(() => ({ name: "dedupe" })),
      makeFetchTransport: mock(() => ({
        send: async () => { throw new Error("GlitchTip is unavailable"); },
        flush: async () => true,
      })),
    };
    const telemetry = createSentryTelemetry(config({ SENTRY_DSN: "https://public@example.com/42" }), sdk);
    const transport = (initializedOptions!.transport as (options: unknown) => { send(value: unknown): Promise<unknown> })({});

    expect(await transport.send({})).toEqual({});
    expect(await telemetry.flush(5)).toBe(false);
    expect(sdk.captureException).not.toHaveBeenCalled();
  });
});

describe("HTTP telemetry boundaries", () => {
  test("captures an unexpected route exception without changing the response", async () => {
    const { telemetry, events } = recordingTelemetry();
    const app = createApp({} as never, config(), undefined, telemetry);
    app.get("/telemetry-test-error", () => { throw new Error("route failed"); });

    const response = await app.handle(new Request("http://localhost/telemetry-test-error", {
      headers: { "x-correlation-id": "correlation-2" },
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal Server Error" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "exception",
      context: {
        service: "app",
        route: "/telemetry-test-error",
        method: "GET",
        status: 500,
        errorCode: "INTERNAL_ERROR",
        correlationId: "correlation-2",
      },
    });
  });

  test("captures returned 5xx responses but ignores ordinary 4xx and provider-start 502", async () => {
    const { telemetry, events } = recordingTelemetry();
    const app = createApp({} as never, config(), undefined, telemetry);
    app.get("/telemetry-test-500", () => new Response("broken", { status: 500 }));
    app.get("/telemetry-test-400", () => new Response("bad request", { status: 400 }));

    const serverError = await app.handle(new Request("http://localhost/telemetry-test-500"));
    const clientError = await app.handle(new Request("http://localhost/telemetry-test-400"));

    expect(serverError.status).toBe(500);
    expect(clientError.status).toBe(400);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "message", value: "HTTP 500 response" });
  });

  test("captures an exception from the mounted Better Auth boundary", async () => {
    const { telemetry, events } = recordingTelemetry();
    const auth = {
      handler: async () => { throw new Error("Microsoft callback failed"); },
      api: {},
    } as never;
    const app = createApp({} as never, config({
      MICROSOFT_CLIENT_ID: "client-id",
      MICROSOFT_CLIENT_SECRET: "client-secret",
      MICROSOFT_TENANT_ID: "11111111-2222-3333-4444-555555555555",
    }), auth, telemetry);

    const response = await app.handle(new Request("http://localhost/api/auth/callback/microsoft?code=secret&state=secret", {
      headers: { "x-correlation-id": "correlation-3" },
    }));

    expect(response.status).toBe(500);
    expect(events).toHaveLength(1);
    expect(events[0]?.context).toMatchObject({
      service: "app",
      route: "/api/auth/callback/microsoft",
      method: "GET",
      status: 500,
      correlationId: "correlation-3",
    });
  });

  test("does not report an expected thrown Better Auth 4xx response", async () => {
    const { telemetry, events } = recordingTelemetry();
    const auth = {
      handler: async () => { throw new Response("invalid oauth request", { status: 400 }); },
      api: {},
    } as never;
    const app = createApp({} as never, config(), auth, telemetry);

    const response = await app.handle(new Request("http://localhost/api/auth/callback/microsoft"));

    expect(response.status).toBe(400);
    expect(events).toHaveLength(0);
  });

  test("does not report the intentionally handled provider-start failure", async () => {
    const { telemetry, events } = recordingTelemetry();
    const auth = {
      handler: async () => Response.json({ error: "provider unavailable" }, { status: 500 }),
      api: {},
    } as never;
    const app = createApp({} as never, config({
      MICROSOFT_CLIENT_ID: "client-id",
      MICROSOFT_CLIENT_SECRET: "client-secret",
      MICROSOFT_TENANT_ID: "11111111-2222-3333-4444-555555555555",
    }), auth, telemetry);

    const response = await app.handle(new Request("http://localhost/login/microsoft", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: "portifact_csrf=csrf-token",
        origin: "http://localhost",
      },
      body: new URLSearchParams({ csrf: "csrf-token" }),
    }));

    expect(response.status).toBe(502);
    expect(events).toHaveLength(0);
  });
});
