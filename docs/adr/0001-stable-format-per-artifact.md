# Keep one stable format per artifact

**Status: accepted.** Portifact will keep a single format for the lifetime of an artifact: versions can change content but cannot change between HTML, Markdown, and plain text. HTML remains the format for interactive artifacts; Markdown and plain text are document artifacts. If content must change format, it becomes a new artifact. This keeps the preview, security boundary, download contract, and share link semantics stable across versions while allowing Portifact to support documents without prematurely adopting Claude Artifacts' larger app-runtime and collaboration surface.

## Considered options

- Allowing each version to change format would make one artifact's preview and security behavior change over time.
- Allowing an artifact to contain multiple files and formats would require a broader package/workspace model than the current single-content artifact.

Markdown document artifacts will support Mermaid fenced blocks and render them as sanitized static SVG using a pinned renderer version. All diagram types supported by that pinned renderer are accepted; a failed render leaves the document available with a warning and the original source block visible. Mermaid callbacks and JavaScript are disabled, while links are subject to the document link policy.
