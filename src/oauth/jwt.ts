import { exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";
import type { Config } from "../config";

// Better Auth's MCP plugin issues opaque access tokens and only signs id_tokens.
// The MVP requires JWT access tokens that the resource server verifies locally via
// jose + JWKS, with audience bound to the MCP resource. We satisfy that here by
// exposing our own RS256 keypair and minting JWT access tokens at the token
// endpoint (see src/app.ts interception), then verifying them in src/mcp.ts.
//
// ponytail: single-process key. When running multiple app instances behind a
// load balancer, lift this to a DB/secret-backed key so all instances share one.

type AccessKey = { kid: string; privateKey: CryptoKey; publicJwk: Record<string, unknown> };

let cached: AccessKey | undefined;

async function loadKey(config: Config): Promise<AccessKey> {
  if (cached) return cached;
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const exported = await exportJWK(publicKey);
  cached = {
    kid: config.accessTokenKeyId,
    privateKey,
    publicJwk: { ...exported, kid: config.accessTokenKeyId, alg: "RS256", use: "sig" },
  };
  return cached;
}

export async function publicJwks(config: Config) {
  const { publicJwk } = await loadKey(config);
  return { keys: [publicJwk] };
}

export async function signAccessJwt(
  config: Config,
  claims: { sub: string; scope: string; clientId: string; jti: string },
) {
  const { privateKey, kid } = await loadKey(config);
  return new SignJWT({ scope: claims.scope, client_id: claims.clientId, jti: claims.jti })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(config.appUrl.origin)
    .setAudience(`${config.appUrl.origin}/mcp`)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtlSeconds}s`)
    .sign(privateKey);
}
