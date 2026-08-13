import { betterAuth } from "better-auth";
import { admin, jwt, mcp } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Database } from "./db/client";
import type { Config } from "./config";
import * as schema from "./db/schema";

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(db: Database, config: Config) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema }),
    baseURL: config.appUrl.toString(),
    secret: config.betterAuthSecret,
    emailAndPassword: {
      enabled: true,
      disableSignUp: !config.registrationEnabled,
      autoSignIn: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
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
          scopes: ["artifacts:read", "artifacts:write", "artifacts:publish"],
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
