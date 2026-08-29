import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { createAuth, microsoftJwkAlgorithm, microsoftUserFromClaims } from "../src/auth";
import { config } from "./helpers";

const noDatabase = {} as never;
const microsoftEnv = {
  MICROSOFT_CLIENT_ID: "client-id",
  MICROSOFT_CLIENT_SECRET: "client-secret",
  MICROSOFT_TENANT_ID: "11111111-2222-3333-4444-555555555555",
};

describe("Microsoft login page", () => {
  test("uses RS256 when Microsoft's JWKS omits alg", () => {
    expect(microsoftJwkAlgorithm({ kty: "RSA", n: "modulus", e: "AQAB" })).toBe("RS256");
  });

  test("accepts a managed user when the optional acct claim is omitted", () => {
    const userInfo = microsoftUserFromClaims({
      tid: microsoftEnv.MICROSOFT_TENANT_ID,
      sub: "subject-1",
      preferred_username: "person@example.com",
      name: "Person Example",
    }, microsoftEnv.MICROSOFT_TENANT_ID);

    expect(userInfo?.user.id).toBe("subject-1");
    expect(userInfo?.user.email).toBe("person@example.com");
  });

  test("rejects a guest when Microsoft marks acct as 1", () => {
    const userInfo = microsoftUserFromClaims({
      tid: microsoftEnv.MICROSOFT_TENANT_ID,
      acct: 1,
      sub: "guest-1",
      preferred_username: "guest@example.com",
    }, microsoftEnv.MICROSOFT_TENANT_ID);

    expect(userInfo).toBeNull();
  });

  test("reports a safe reason when Microsoft identity claims are incomplete", () => {
    const reasons: string[] = [];
    const userInfo = microsoftUserFromClaims({
      tid: microsoftEnv.MICROSOFT_TENANT_ID,
      preferred_username: "person@example.com",
    }, microsoftEnv.MICROSOFT_TENANT_ID, (reason) => reasons.push(reason));

    expect(userInfo).toBeNull();
    expect(reasons).toEqual(["missing_identity_claims"]);
  });

  test("offers Microsoft sign-in when Microsoft is configured", async () => {
    const appConfig = config(microsoftEnv);
    const response = await createApp(noDatabase, appConfig).handle(new Request("http://localhost/login"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Sign in with Microsoft");
    expect(body).toContain("/login/microsoft");
    expect(body).not.toContain("/api/auth/sign-in/email");
    expect(body).not.toContain('name="password"');
    expect(body).toContain('name="csrf"');
    expect(body).toContain("Only a Microsoft identity from your configured Organization is accepted");
    expect(response.headers.get("content-security-policy")).toContain(`form-action 'self' ${appConfig.appUrl.origin} https://login.microsoftonline.com`);
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self' https://static.cloudflareinsights.com");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self' https://cloudflareinsights.com");
    const nonce = body.match(/<style nonce="([^"]+)">/)?.[1];
    expect(nonce).toBeTruthy();
    expect(response.headers.get("content-security-policy")).toContain(`style-src 'nonce-${nonce}'`);
  });

  test("keeps the local login form when Microsoft is not configured", async () => {
    const response = await createApp(noDatabase, config()).handle(new Request("http://localhost/login"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("/api/auth/sign-in/email");
    expect(body).not.toContain("Sign in with Microsoft");
  });

  test("hides registration when Microsoft mode is enabled", async () => {
    const appConfig = config({
      ...microsoftEnv,
      REGISTRATION_ENABLED: "true",
    });
    const response = await createApp(noDatabase, appConfig).handle(new Request("http://localhost/register"));

    expect(response.status).toBe(404);
  });

  test("does not label a Microsoft identity as an unverified email", async () => {
    const auth = {
      api: {
        getSession: async () => ({ user: { name: "Person Example", email: "person@example.com", emailVerified: false } }),
      },
    } as never;
    const response = await createApp(noDatabase, config(microsoftEnv), auth).handle(new Request("http://localhost/account"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Microsoft identity authenticated");
    expect(body).not.toContain("email unverified");
    expect(response.headers.get("content-security-policy")).toContain(`form-action 'self' ${config(microsoftEnv).appUrl.origin} https://login.microsoftonline.com`);
  });

  test("starts the Microsoft flow from the browser form", async () => {
    const appConfig = config(microsoftEnv);
    const auth = createAuth(noDatabase, appConfig);
    const app = createApp(noDatabase, appConfig, auth);
    const login = await app.handle(new Request("http://localhost/login"));
    const body = await login.text();
    const csrf = body.match(/name="csrf" value="([^"]+)"/)?.[1];

    const response = await app.handle(new Request("http://localhost/login/microsoft", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: (login.headers.get("set-cookie") ?? "").split(";", 1)[0],
        origin: "http://localhost",
      },
      body: new URLSearchParams({ csrf: csrf ?? "" }),
    }));

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "http://invalid");
    expect(location.origin).toBe("https://login.microsoftonline.com");
    expect(location.pathname).toBe("/11111111-2222-3333-4444-555555555555/oauth2/v2.0/authorize");
    expect(location.searchParams.get("scope")).toBe("openid profile email");
    expect(location.searchParams.get("redirect_uri")).toBe("http://localhost/api/auth/callback/microsoft");
    expect(response.headers.get("set-cookie")).toContain("oauth_state");
  });

  test("preserves an MCP authorization request through login", async () => {
    const appConfig = config(microsoftEnv);
    const query = new URLSearchParams({
      client_id: "mcp-client",
      redirect_uri: "https://mcp.example/callback",
      response_type: "code",
      state: "mcp-state",
    });
    const response = await createApp(noDatabase, appConfig).handle(new Request(`http://localhost/login?${query}`));
    const body = await response.text();

    expect(body).toContain('name="callbackURL"');
    expect(body).toContain("/api/auth/mcp/authorize?client_id=mcp-client&amp;redirect_uri=https%3A%2F%2Fmcp.example%2Fcallback");
  });

  test("uses Microsoft login when MCP authorization needs a session", async () => {
    const appConfig = config(microsoftEnv);
    const auth = createAuth(noDatabase, appConfig);
    const app = createApp(noDatabase, appConfig, auth);
    const query = new URLSearchParams({
      client_id: "mcp-client",
      redirect_uri: "https://mcp.example/callback",
      response_type: "code",
      scope: "artifacts:read",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      state: "mcp-state",
    });
    const response = await app.handle(new Request(`http://localhost/api/auth/mcp/authorize?${query}`));

    expect(response.status).toBe(302);
    const loginURL = new URL(response.headers.get("location") ?? "http://invalid", "http://localhost");
    expect(loginURL.pathname).toBe("/login");
    expect(loginURL.searchParams.get("client_id")).toBe("mcp-client");
    const login = await app.handle(new Request(`http://localhost${loginURL.pathname}${loginURL.search}`));
    expect(await login.text()).toContain("Sign in with Microsoft");
  });

  test("shows a generic retry page for a failed Microsoft flow", async () => {
    const response = await createApp(noDatabase, config(microsoftEnv)).handle(new Request("http://localhost/login/error?error=invalid_code&code=secret"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Sign-in failed");
    expect(body).toContain("Try again");
    expect(body).not.toContain("invalid_code");
    expect(body).not.toContain("secret");
  });

  test("does not expose password authentication in Microsoft mode", async () => {
    const appConfig = config(microsoftEnv);
    const auth = createAuth(noDatabase, appConfig);
    const app = createApp(noDatabase, appConfig, auth);

    for (const path of ["/api/auth/sign-in/email", "/api/auth/sign-up/email"]) {
      const response = await app.handle(new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "person@example.com", password: "password123", name: "Person" }),
      }));
      expect(response.status).toBe(400);
    }
  });

  test("sends an invalid callback to the generic retry page", async () => {
    const appConfig = config(microsoftEnv);
    const auth = createAuth(noDatabase, appConfig);
    const app = createApp(noDatabase, appConfig, auth);
    const response = await app.handle(new Request("http://localhost/api/auth/callback/microsoft?code=secret&state=invalid"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost/login/error");
  });

  test("keeps the existing MCP error endpoint contract", async () => {
    const appConfig = config(microsoftEnv);
    const auth = createAuth(noDatabase, appConfig);
    const app = createApp(noDatabase, appConfig, auth);
    const response = await app.handle(new Request("http://localhost/api/auth/error?error=invalid_client"));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });
});
