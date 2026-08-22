import { JSDOM } from "jsdom";
import { marked, Renderer } from "marked";
import sanitizeHtml from "sanitize-html";
import { escapeHtml } from "./domain";
import type { ArtifactFormat } from "./content";

export type PreviewWarning = string;

export type PreviewResult = {
  html: string;
  warnings: PreviewWarning[];
};

const markdownTags = [
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "img", "input", "li", "ol", "p", "pre", "span", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
];

const markdownAttributes: sanitizeHtml.IOptions["allowedAttributes"] = {
  a: ["href", "title"],
  code: ["class"],
  img: ["alt", "height", "src", "title", "width"],
  input: ["checked", "class", "disabled", "type"],
  span: ["data-mermaid-id"],
};

const svgTags = [
  "circle", "clipPath", "defs", "desc", "ellipse", "g", "line", "linearGradient", "marker", "mask",
  "path", "pattern", "polygon", "polyline", "rect", "stop", "style", "svg", "symbol", "text", "title", "tspan", "use",
];

const svgAttributes = [
  "aria-label", "aria-roledescription", "class", "clip-path", "d", "fill", "fill-opacity", "font-family", "font-size",
  "font-weight", "height", "id", "marker-end", "marker-height", "marker-start", "marker-width", "offset", "opacity",
  "points", "preserveAspectRatio", "refX", "refY", "role", "rx", "ry", "stop-color", "stop-opacity", "stroke",
  "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-width", "text-anchor",
  "transform", "version", "viewBox", "width", "x", "x1", "x2", "xmlns", "y", "y1", "y2",
];

const mermaidPlaceholder = (id: string) => `<span data-mermaid-id="${id}"></span>`;

function sanitizeMarkdown(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: markdownTags,
    allowedAttributes: markdownAttributes,
    allowedSchemes: ["https"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
  });
}

function sanitizeSvg(svg: string): string {
  const sanitized = sanitizeHtml(svg, {
    allowedTags: svgTags,
    allowedAttributes: { "*": svgAttributes },
    allowedSchemes: ["https"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    allowVulnerableTags: true,
  });
  return sanitized.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_match, attributes, css) => {
    const safeCss = css
      .replace(/@import[^;]+;?/gi, "")
      .replace(/(?:url|expression|javascript)\s*\([^)]*\)/gi, "none");
    return `<style${attributes}>${safeCss}</style>`;
  });
}

type MermaidApi = {
  initialize: (options: Record<string, unknown>) => void;
  render: (id: string, source: string) => Promise<{ svg: string; bindFunctions?: unknown }>;
};

function initializeMermaid(api: MermaidApi): void {
  api.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    theme: "default",
    suppressErrorRendering: true,
  });
}

let mermaidPromise: Promise<MermaidApi> | undefined;
let mermaidQueue = Promise.resolve();
let mermaidDom: JSDOM | undefined;

function installMermaidDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: false });
  Object.assign(dom.window, {
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
  });
  const svgPrototype = dom.window.SVGElement.prototype as SVGElement & { getBBox?: () => DOMRect };
  if (!svgPrototype.getBBox) {
    Object.defineProperty(svgPrototype, "getBBox", {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 100, height: 40 }),
    });
  }
  const svgMethods = svgPrototype as SVGElement & {
    getComputedTextLength?: () => number;
    getTotalLength?: () => number;
  };
  if (!svgMethods.getComputedTextLength) {
    Object.defineProperty(svgMethods, "getComputedTextLength", {
      configurable: true,
      value: function () { return (this.textContent?.length ?? 0) * 8; },
    });
  }
  if (!svgMethods.getTotalLength) {
    Object.defineProperty(svgMethods, "getTotalLength", {
      configurable: true,
      value: () => 100,
    });
  }
  const canvasPrototype = dom.window.HTMLCanvasElement.prototype as HTMLCanvasElement & { getContext?: () => unknown };
  const canvasContext = new Proxy({
    measureText: (text: string) => ({ width: text.length * 8 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
  }, {
    get: (target, property: string | symbol) => {
      if (property in target) return target[property as keyof typeof target];
      return () => undefined;
    },
    set: () => true,
  });
  Object.defineProperty(canvasPrototype, "getContext", {
    configurable: true,
    value: () => canvasContext,
  });

  const globals = globalThis as Record<string, unknown>;
  Object.assign(globals, {
    window: dom.window,
    document: dom.window.document,
    DOMParser: dom.window.DOMParser,
    XMLSerializer: dom.window.XMLSerializer,
    SVGElement: dom.window.SVGElement,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    navigator: dom.window.navigator,
    CSSStyleSheet: dom.window.CSSStyleSheet,
    CSSStyleRule: dom.window.CSSStyleRule,
    CSSRule: dom.window.CSSRule,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  });
  return dom;
}

async function loadMermaidApi(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = (async () => {
      mermaidDom = installMermaidDom();
      const imported = await import("mermaid");
      const api = imported.default as MermaidApi;
      initializeMermaid(api);
      return api;
    })();
  }
  return mermaidPromise;
}

async function renderMermaid(source: string, id: string): Promise<string> {
  const previous = mermaidQueue;
  let release!: () => void;
  mermaidQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  const api = await loadMermaidApi();
  mermaidDom ??= installMermaidDom();
  try {
    initializeMermaid(api);
    const safeSource = source
      .replace(/%%\{[\s\S]*?\}%%/g, "")
      .split("\n")
      .filter((line) => !/^\s*click\b/i.test(line))
      .join("\n");
    const result = await api.render(id, safeSource);
    return sanitizeSvg(result.svg);
  } finally {
    release();
  }
}

async function renderMarkdown(source: string): Promise<PreviewResult> {
  const warnings: PreviewWarning[] = [];
  const diagrams = new Map<string, string>();
  let diagramNumber = 0;
  const renderer = new Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.code = ({ text, lang }) => {
    if (lang?.trim().toLowerCase() !== "mermaid") {
      const className = lang ? ` class="language-${escapeHtml(lang.trim())}"` : "";
      return `<pre><code${className}>${escapeHtml(text)}</code></pre>`;
    }
    const id = `mermaid-${diagramNumber++}`;
    diagrams.set(id, text);
    return mermaidPlaceholder(id);
  };

  const parsed = await marked.parse(source, { gfm: true, renderer });
  let html = sanitizeMarkdown(parsed);
  for (const [id, diagramSource] of diagrams) {
    const placeholder = mermaidPlaceholder(id);
    try {
      const svg = await renderMermaid(diagramSource, id);
      html = html.replace(placeholder, svg || `<pre><code class="language-mermaid">${escapeHtml(diagramSource)}</code></pre>`);
      if (!svg) warnings.push("A Mermaid diagram could not be rendered; the source was preserved.");
    } catch {
      warnings.push("A Mermaid diagram could not be rendered; the source was preserved.");
      html = html.replace(placeholder, `<pre><code class="language-mermaid">${escapeHtml(diagramSource)}</code></pre>`);
    }
  }
  return { html, warnings };
}

export async function renderPreview(format: ArtifactFormat, source: string): Promise<PreviewResult> {
  if (format === "html") return { html: source, warnings: [] };
  if (format === "plain_text") return { html: `<pre class="artifact-text">${escapeHtml(source)}</pre>`, warnings: [] };
  return renderMarkdown(source);
}
