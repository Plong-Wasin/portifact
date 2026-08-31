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

export const GENERAL_ACCESS_MODES = [
  "only_people_with_access",
  "everyone_with_login",
  "anyone_with_the_link",
] as const;
export type GeneralAccessMode = typeof GENERAL_ACCESS_MODES[number];

export const ARTIFACT_ACCESS_ROLES = ["viewer", "editor"] as const;
export type ArtifactAccessRole = typeof ARTIFACT_ACCESS_ROLES[number];

export function validateName(value: unknown): string {
  if (typeof value !== "string") throw new DomainError("INVALID_ARTIFACT_NAME");
  const name = value.trim();
  const length = [...name].length;
  if (length < 1 || length > 200) throw new DomainError("INVALID_ARTIFACT_NAME");
  return name;
}

function artifactPrivacyHeaders(headers: Headers): Headers {
  headers.set("X-Robots-Tag", ARTIFACT_ROBOTS);
  headers.set("Cache-Control", "private, no-store");
  return headers;
}

export function artifactHeaders(headers = new Headers()): Headers {
  artifactPrivacyHeaders(headers);
  headers.set("Referrer-Policy", "no-referrer");
  return headers;
}

export function artifactWorkspaceHeaders(headers = new Headers()): Headers {
  artifactPrivacyHeaders(headers);
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
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
