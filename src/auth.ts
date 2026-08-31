import { betterAuth } from "better-auth";
import { admin, jwt, mcp } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";
import type { Database } from "./db/client";
import type { Config } from "./config";
import * as schema from "./db/schema";

export type Auth = ReturnType<typeof createAuth>;

const microsoftAuthority = "https://login.microsoftonline.com";

type MicrosoftJwks = { keys?: JWK[] };

export function microsoftJwkAlgorithm(_jwk: JWK): "RS256" {
  // The callback verifier only accepts RS256. Microsoft currently omits alg
  // from these RSA JWKS entries, so supply the algorithm required by jose.
  return "RS256";
}

async function getMicrosoftSigningKey(kid: string, tenantId: string): Promise<CryptoKey> {
  const response = await fetch(`${microsoftAuthority}/${tenantId}/discovery/v2.0/keys`);
  if (!response.ok) throw new Error("Microsoft signing keys unavailable");
  const body = await response.json() as MicrosoftJwks;
  const jwk = body.keys?.find((key) => key.kid === kid);
  if (!jwk) throw new Error("Microsoft signing key not found");
  return await importJWK(jwk, microsoftJwkAlgorithm(jwk)) as CryptoKey;
}

export type MicrosoftUserInfoFailureReason =
  | "missing_id_token"
  | "invalid_id_token_header"
  | "id_token_verification_failed"
  | "tenant_mismatch"
  | "guest_identity"
  | "invalid_account_claim"
  | "missing_identity_claims";

export type AuthOptions = {
  onMicrosoftUserInfoFailure?: (reason: MicrosoftUserInfoFailureReason) => void;
};

function reportMicrosoftUserInfoFailure(report: AuthOptions["onMicrosoftUserInfoFailure"], reason: MicrosoftUserInfoFailureReason) {
  try {
    report?.(reason);
  } catch {
    // Diagnostics must never change the authentication result.
  }
}

export function microsoftUserFromClaims(claims: Record<string, unknown>, tenantId: string, report?: AuthOptions["onMicrosoftUserInfoFailure"]) {
  // Microsoft emits acct only when it is configured as an optional claim. A
  // value of 1 explicitly identifies a guest; an omitted claim is normal for
  // managed-user ID tokens and must not make sign-in fail.
  const accountType = claims.acct;
  if (claims.tid !== tenantId) {
    reportMicrosoftUserInfoFailure(report, "tenant_mismatch");
    return null;
  }
  if (accountType !== undefined && accountType !== 0) {
    reportMicrosoftUserInfoFailure(report, accountType === 1 ? "guest_identity" : "invalid_account_claim");
    return null;
  }
  const id = typeof claims.sub === "string" ? claims.sub : "";
  const email = typeof claims.email === "string"
    ? claims.email
    : typeof claims.preferred_username === "string" ? claims.preferred_username : "";
  if (!id || !email) {
    reportMicrosoftUserInfoFailure(report, "missing_identity_claims");
    return null;
  }
  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name : email;
  return {
    user: {
      id,
      name,
      email,
      emailVerified: claims.email_verified === true,
    },
    data: claims,
  };
}

export function createAuth(db: Database, config: Config, options: AuthOptions = {}) {
  const microsoft = config.microsoft;
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema }),
    baseURL: config.appUrl.toString(),
    secret: config.betterAuthSecret,
    logger: {
      level: config.logLevel,
      // Better Auth sometimes passes provider errors as extra arguments. Keep
      // those out of application logs because they may contain OAuth material.
      log: (level, message) => {
        const line = JSON.stringify({ event: "auth", level, message: typeof message === "string" ? message : "authentication event" });
        if (level === "error") console.error(line);
        else console.log(line);
      },
    },
    emailAndPassword: {
      enabled: !microsoft,
      disableSignUp: !config.registrationEnabled,
      autoSignIn: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    account: {
      accountLinking: {
        disableImplicitLinking: true,
      },
      encryptOAuthTokens: true,
      storeStateStrategy: "cookie",
    },
    socialProviders: microsoft ? {
      microsoft: {
        clientId: microsoft.clientId,
        clientSecret: microsoft.clientSecret,
        tenantId: microsoft.tenantId,
        disableDefaultScope: true,
        scope: ["openid", "profile", "email"],
        disableProfilePhoto: true,
        getUserInfo: async (token) => {
          if (!token.idToken) {
            reportMicrosoftUserInfoFailure(options.onMicrosoftUserInfoFailure, "missing_id_token");
            return null;
          }
          let claims: Record<string, unknown>;
          try {
            const { kid, alg } = decodeProtectedHeader(token.idToken);
            if (!kid || alg !== "RS256") {
              reportMicrosoftUserInfoFailure(options.onMicrosoftUserInfoFailure, "invalid_id_token_header");
              return null;
            }
            const publicKey = await getMicrosoftSigningKey(kid, microsoft.tenantId);
            const verified = await jwtVerify(token.idToken, publicKey, {
              algorithms: ["RS256"],
              audience: microsoft.clientId,
              issuer: `${microsoftAuthority}/${microsoft.tenantId}/v2.0`,
              maxTokenAge: "1h",
            });
            claims = verified.payload;
          } catch {
            reportMicrosoftUserInfoFailure(options.onMicrosoftUserInfoFailure, "id_token_verification_failed");
            return null;
          }
          return microsoftUserFromClaims(claims, microsoft.tenantId, options.onMicrosoftUserInfoFailure);
        },
      },
    } : undefined,
    plugins: [
      admin(),
      jwt({
        jwt: {
          issuer: config.appUrl.origin,
          audience: `${config.appUrl.origin}/mcp`,
          expirationTime: `${config.accessTokenTtlSeconds}s`,
        },
        jwks: { jwksPath: "/.well-known/jwks.json" },
      }),
      mcp({
        loginPage: "/login",
        resource: `${config.appUrl.origin}/mcp`,
        oidcConfig: {
          loginPage: "/login",
          accessTokenExpiresIn: config.accessTokenTtlSeconds,
          scopes: ["artifacts:read", "artifacts:write"],
          defaultScope: "artifacts:read",
          requirePKCE: true,
          allowPlainCodeChallengeMethod: false,
          allowDynamicClientRegistration: true,
          useJWTPlugin: true,
        },
      }),
    ],
    advanced: { useSecureCookies: config.appUrl.protocol === "https:" },
  });
}
