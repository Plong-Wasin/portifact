import { createHash } from "node:crypto";
import { DomainError } from "./domain";

export const ARTIFACT_FORMATS = ["html", "markdown", "plain_text"] as const;
export type ArtifactFormat = typeof ARTIFACT_FORMATS[number];

const formatByExtension: Record<string, ArtifactFormat> = {
  ".html": "html",
  ".md": "markdown",
  ".txt": "plain_text",
};

const formatExtensions: Record<ArtifactFormat, string> = {
  html: ".html",
  markdown: ".md",
  plain_text: ".txt",
};

const formatMimes: Record<ArtifactFormat, string> = {
  html: "text/html; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  plain_text: "text/plain; charset=utf-8",
};

export function formatFromFilename(filename: string): ArtifactFormat {
  const lower = filename.toLowerCase();
  const extension = lower.slice(lower.lastIndexOf("."));
  const format = formatByExtension[extension];
  if (!format) throw new DomainError("UNSUPPORTED_ARTIFACT_FORMAT", "unsupported artifact format", 400);
  return format;
}

export function formatExtension(format: ArtifactFormat): string {
  return formatExtensions[format];
}

export function contentMimeType(format: ArtifactFormat): string {
  return formatMimes[format];
}

export function contentBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function contentDigest(value: string): string {
  return createHash("sha256").update(contentBytes(value)).digest("hex");
}

export function decodeContent(bytes: Uint8Array, maxBytes: number): string {
  if (bytes.byteLength === 0) throw new DomainError("EMPTY_CONTENT", "content is empty");
  if (bytes.byteLength > maxBytes) throw new DomainError("CONTENT_TOO_LARGE", "content is too large", 413);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new DomainError("INVALID_CONTENT_ENCODING", "content must be valid UTF-8");
  }
}
