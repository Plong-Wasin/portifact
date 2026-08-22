import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_FORMATS,
  contentBytes,
  contentDigest,
  contentMimeType,
  decodeContent,
  formatFromFilename,
} from "../src/artifacts/content";

function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error("expected action to fail");
}

describe("artifact content contract", () => {
  test("defines the supported artifact formats", () => {
    expect(ARTIFACT_FORMATS).toEqual(["html", "markdown", "plain_text"]);
  });

  test("maps allowlisted filenames to stable formats", () => {
    expect(formatFromFilename("REPORT.HTML")).toBe("html");
    expect(formatFromFilename("notes.md")).toBe("markdown");
    expect(formatFromFilename("prompt.txt")).toBe("plain_text");
  });

  test("rejects unsupported filenames", () => {
    expect(errorCode(() => formatFromFilename("archive.pdf"))).toBe("UNSUPPORTED_ARTIFACT_FORMAT");
    expect(errorCode(() => formatFromFilename("README"))).toBe("UNSUPPORTED_ARTIFACT_FORMAT");
  });

  test("decodes valid UTF-8 and enforces content limits", () => {
    expect(decodeContent(new TextEncoder().encode("Hello"), 10)).toBe("Hello");
    expect(errorCode(() => decodeContent(new TextEncoder().encode("12345678901"), 10))).toBe("CONTENT_TOO_LARGE");
    expect(errorCode(() => decodeContent(new Uint8Array([0xc3, 0x28]), 10))).toBe("INVALID_CONTENT_ENCODING");
    expect(errorCode(() => decodeContent(new Uint8Array(), 10))).toBe("EMPTY_CONTENT");
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);
    expect(Array.from(new TextEncoder().encode(decodeContent(withBom, 10)))).toEqual(Array.from(withBom));
  });

  test("provides format-appropriate download metadata", () => {
    expect(contentMimeType("html")).toBe("text/html; charset=utf-8");
    expect(contentMimeType("markdown")).toBe("text/markdown; charset=utf-8");
    expect(contentMimeType("plain_text")).toBe("text/plain; charset=utf-8");
    expect(new TextDecoder().decode(contentBytes("hello"))).toBe("hello");
    expect(contentDigest("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});
