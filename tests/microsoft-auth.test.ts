import { describe, expect, test } from "bun:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createApp } from "../src/app";
import { createAuth } from "../src/auth";
import { createDb } from "../src/db/client";
import { config } from "./helpers";

const tenantId = "11111111-2222-3333-4444-555555555555";
const clientId = "client-id";
const noDatabase = {} as never;

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.();
  if (values?.length) return values;
  return (response.headers.get("set-cookie") ?? "").split(/,\s*(?=[^;,=]+=[^;,]*)/);
}

function cookie(response: Response, name: string): string {
  return setCookies(response).map((value) => value.split(";", 1)[0]).find((value) => value.startsWith(`${name}=`)) ?? "";
}

type Identity = {
  sub: string;
  email: string;
  name: string;
  tid?: string;
  acct?: number;
};

async function signedIdentity(identity: Identity, privateKey: CryptoKey) {
  return new SignJWT({
    tid: identity.tid ?? tenantId,
    acct: identity.acct ?? 0,
    preferred_username: identity.email,
    email: identity.email,
    name: identity.name,
    email_verified: true,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer(`https://login.microsoftonline.com/${identity.tid ?? tenantId}/v2.0`)
    .setAudience(clientId)
    .setSubject(identity.sub)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
}

async function startFlow(app: ReturnType<typeof createApp>) {
  const login = await app.handle(new Request("http://localhost/login"));
  const body = await login.text();
  const csrf = body.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
  const csrfCookie = cookie(login, "portifact_csrf");
  const start = await app.handle(new Request("http://localhost/login/microsoft", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: csrfCookie,
      origin: "http://localhost",
    },
    body: new URLSearchParams({ csrf }),
  }));
  const location = new URL(start.headers.get("location") ?? "http://invalid");
  return {
    state: location.searchParams.get("state") ?? "",
    cookies: [csrfCookie, cookie(start, "better-auth.oauth_state")].filter(Boolean).join("; "),
  };
}

describe.skipIf(!Bun.env.TEST_DATABASE_URL)("Microsoft authentication callback (needs TEST_DATABASE_URL)", () => {
  test("provisions a user, keeps identity continuity, and creates a dashboard session", async () => {
    const cfg = config({
      DATABASE_URL: Bun.env.TEST_DATABASE_URL!,
      MICROSOFT_CLIENT_ID: clientId,
      MICROSOFT_CLIENT_SECRET: "client-secret",
      MICROSOFT_TENANT_ID: tenantId,
    });
    const resources = createDb(cfg);
    const auth = createAuth(resources.db, cfg);
    const app = createApp(resources.db, cfg, auth);
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    Object.assign(jwk, { kid: "test-kid", alg: "RS256", use: "sig" });
    const identityId = crypto.randomUUID();
    let identity: Identity = {
      sub: `microsoft-${identityId}`,
      email: `person-${identityId}@company.example`,
      name: "Company Person",
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/oauth2/v2.0/token")) {
        return Response.json({ token_type: "Bearer", access_token: "test-access-token", id_token: await signedIdentity(identity, privateKey), scope: "openid profile email", expires_in: 3600 });
      }
      if (url.endsWith("/discovery/v2.0/keys")) return Response.json({ keys: [jwk] });
      if (url.includes("graph.microsoft.com")) throw new Error("Microsoft Graph must not be called for sign-in");
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const firstFlow = await startFlow(app);
      const firstCallback = await app.handle(new Request(`http://localhost/api/auth/callback/microsoft?code=first&state=${encodeURIComponent(firstFlow.state)}`, { headers: { cookie: firstFlow.cookies } }));
      const firstSessionCookie = cookie(firstCallback, "better-auth.session_token");
      const firstSession = await auth.api.getSession({ headers: new Headers({ cookie: firstSessionCookie }) });

      expect(firstCallback.status).toBe(302);
      expect(firstCallback.headers.get("location")).toBe("/artifacts");
      expect(firstSession?.user.email).toBe(`person-${identityId}@company.example`);

      identity = { ...identity, email: `person.alias-${identityId}@company.example`, name: "Renamed Person" };
      const secondFlow = await startFlow(app);
      const secondCallback = await app.handle(new Request(`http://localhost/api/auth/callback/microsoft?code=second&state=${encodeURIComponent(secondFlow.state)}`, { headers: { cookie: secondFlow.cookies } }));
      const secondSession = await auth.api.getSession({ headers: new Headers({ cookie: cookie(secondCallback, "better-auth.session_token") }) });

      expect(secondCallback.status).toBe(302);
      expect(secondSession?.user.id).toBe(firstSession?.user.id);
    } finally {
      globalThis.fetch = originalFetch;
      await resources.sql.close();
    }
  });

  test("rejects a non-member identity without creating a session", async () => {
    const cfg = config({
      DATABASE_URL: Bun.env.TEST_DATABASE_URL!,
      MICROSOFT_CLIENT_ID: clientId,
      MICROSOFT_CLIENT_SECRET: "client-secret",
      MICROSOFT_TENANT_ID: tenantId,
    });
    const resources = createDb(cfg);
    const auth = createAuth(resources.db, cfg);
    const app = createApp(resources.db, cfg, auth);
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    Object.assign(jwk, { kid: "test-kid", alg: "RS256", use: "sig" });
    let identity: Identity = {
      sub: `consumer-${crypto.randomUUID()}`,
      email: "personal@outlook.example",
      name: "Personal Account",
      acct: 1,
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/oauth2/v2.0/token")) return Response.json({ token_type: "Bearer", access_token: "test-access-token", id_token: await signedIdentity(identity, privateKey), scope: "openid profile email", expires_in: 3600 });
      if (url.endsWith("/discovery/v2.0/keys")) return Response.json({ keys: [jwk] });
      if (url.includes("graph.microsoft.com")) throw new Error("Microsoft Graph must not be called for sign-in");
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      for (const code of ["consumer", "foreign-tenant"]) {
        if (code === "foreign-tenant") identity = { ...identity, tid: "22222222-3333-4444-5555-666666666666", acct: 0 };
        const flow = await startFlow(app);
        const callback = await app.handle(new Request(`http://localhost/api/auth/callback/microsoft?code=${code}&state=${encodeURIComponent(flow.state)}`, { headers: { cookie: flow.cookies } }));
        const body = await callback.text();

        expect(callback.status).toBe(302);
        expect(callback.headers.get("location")).toContain("/login/error");
        expect(cookie(callback, "better-auth.session_token")).toBe("");
        expect(body).not.toContain("personal@outlook.example");
        expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();
      }
    } finally {
      globalThis.fetch = originalFetch;
      await resources.sql.close();
    }
  });
});
