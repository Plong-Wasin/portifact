# Use a format-neutral content model

**Status: accepted.** Portifact will store each version's canonical source in a format-neutral `content` field and store the artifact's stable `format` separately, with `html`, `markdown`, and `plain_text` as the initial formats. Existing `html` data and the MCP `html` input may be changed directly because the system has no deployed users or clients that require backward compatibility. The MCP create and version operations will use `content + format`, and renderers will be selected from the artifact format rather than from a format-specific storage column.

## Consequences

- Existing HTML data is migrated from `html` into `content` with `format=html`.
- The data model does not need separate HTML, Markdown, and text columns.
- Download and preview behavior can remain faithful to the artifact's format.
- The first release can make a clean API/schema change instead of carrying an `html` compatibility alias.

The canonical format enum is `html`, `markdown`, or `plain_text`; file extensions and MIME types are boundary concerns. Each version keeps one canonical UTF-8 source, while rendered HTML/SVG is derived and may be cached rather than becoming version data. The initial model remains single-content: Markdown may reference external HTTPS images under the document policy, but bundled or relative assets are deferred.
