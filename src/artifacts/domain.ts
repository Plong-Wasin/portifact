import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const keyBytes = (key: string) => createHash("sha256").update(key).digest();

export function encryptToken(token: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function decryptToken(encoded: string, key: string): string {
  try {
    const payload = Buffer.from(encoded, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw new DomainError("INVALID_SHARE_TOKEN", "invalid share token", 404);
  }
}

export const shareTokenKey = keyBytes;


export const ARTIFACT_ROBOTS = "noindex, nofollow, noarchive, nosnippet, noimageindex";
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  "img-src https: data: blob:",
  "font-src https: data:",
  "media-src https: data: blob:",
  "connect-src https:",
  "worker-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message = code,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function validateName(value: unknown): string {
  if (typeof value !== "string") throw new DomainError("INVALID_ARTIFACT_NAME");
  const name = value.trim();
  const length = [...name].length;
  if (length < 1 || length > 200) throw new DomainError("INVALID_ARTIFACT_NAME");
  return name;
}

export function decodeHtml(bytes: Uint8Array, maxBytes: number): string {
  if (bytes.byteLength === 0) throw new DomainError("EMPTY_HTML");
  if (bytes.byteLength > maxBytes) throw new DomainError("HTML_TOO_LARGE");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DomainError("INVALID_HTML_ENCODING");
  }
}

export function htmlBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function digestHtml(value: string): string {
  return createHash("sha256").update(htmlBytes(value)).digest("hex");
}

export function tokenValue(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function artifactHeaders(headers = new Headers()): Headers {
  headers.set("X-Robots-Tag", ARTIFACT_ROBOTS);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "private, no-store");
  return headers;
}

export function robotsMeta(): string {
  return `<meta name="robots" content="${ARTIFACT_ROBOTS}">`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}
