import { describe, expect, test } from "bun:test";
import { renderPreview } from "../src/artifacts/renderer";

describe("document artifact previews", () => {
  test("renders safe Markdown features", async () => {
    const preview = await renderPreview("markdown", "# Hello\n\n- [x] done\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst answer = 42;\n```");

    expect(preview.warnings).toEqual([]);
    expect(preview.html).toContain("<h1>Hello</h1>");
    expect(preview.html).toContain("type=\"checkbox\"");
    expect(preview.html).toContain("<table>");
    expect(preview.html).toContain("language-ts");
  });

  test("does not execute raw HTML or unsafe links in Markdown", async () => {
    const preview = await renderPreview("markdown", "<script>alert(1)</script>\n\n[bad](javascript:alert(1))");

    expect(preview.html).not.toContain("<script>");
    expect(preview.html).toContain("&lt;script&gt;");
    expect(preview.html).not.toContain("javascript:");
  });

  test("keeps HTTPS document resources and rejects other schemes", async () => {
    const preview = await renderPreview("markdown", "[safe](https://example.com)\n\n![image](https://example.com/image.png)\n\n[unsafe](http://example.com)");

    expect(preview.html).toContain('href="https://example.com"');
    expect(preview.html).toContain('src="https://example.com/image.png"');
    expect(preview.html).not.toContain('href="http://example.com"');
  });

  test("renders plain text as escaped preformatted content", async () => {
    const preview = await renderPreview("plain_text", "line 1\n<script>alert(1)</script>\n  line 3");

    expect(preview.html).toContain("<pre");
    expect(preview.html).toContain("line 1\n&lt;script&gt;alert(1)&lt;/script&gt;\n  line 3");
    expect(preview.html).not.toContain("<script>");
  });

  test("renders Mermaid fences as sanitized static SVG", async () => {
    const preview = await renderPreview("markdown", "```mermaid\ngraph TD; A[Hello] --> B[World]\n```");

    expect(preview.warnings).toEqual([]);
    expect(preview.html).toContain("<svg");
    expect(preview.html).not.toContain("<script");
    expect(preview.html).not.toContain("onclick");
    expect(preview.html).not.toContain("bindFunctions");
  });

  test("disables Mermaid directives and callbacks", async () => {
    const preview = await renderPreview("markdown", "```mermaid\n%%{init: { securityLevel: 'loose' }}%%\ngraph TD\nA --> B\nclick A callback\n```");

    expect(preview.html).toContain("<svg");
    expect(preview.html).not.toContain("<script");
    expect(preview.html).not.toContain("onclick");
    expect(preview.html).not.toContain("javascript:");
  });

  test("supports Mermaid diagram families beyond flowcharts", async () => {
    const fixtures = [
      "mindmap\n root((Mind))\n  A",
      "architecture-beta\n service api(server)[API]",
      "requirementDiagram\n requirement testreq {\n id: 1\n text: \"hello requirement\"\n risk: low\n verifyMethod: test\n }",
    ];

    for (const source of fixtures) {
      const preview = await renderPreview("markdown", `\`\`\`mermaid\n${source}\n\`\`\``);
      expect(preview.warnings).toEqual([]);
      expect(preview.html).toContain("<svg");
    }
  });

  test("preserves Mermaid source when a diagram cannot render", async () => {
    const preview = await renderPreview("markdown", "```mermaid\nnot a valid diagram\n```");

    expect(preview.warnings).toHaveLength(1);
    expect(preview.html).toContain("language-mermaid");
    expect(preview.html).toContain("not a valid diagram");
  });

  test("keeps HTML source unchanged for the interactive renderer", async () => {
    const html = "<!doctype html><h1>Hello</h1><script>window.ready = true</script>";
    const preview = await renderPreview("html", html);

    expect(preview.html).toBe(html);
    expect(preview.warnings).toEqual([]);
  });
});
