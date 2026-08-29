# Portifact Artifact Context

Portifact stores and shares self-contained work products that can be viewed, reused, and published independently of the conversation or process that created them.

## Artifact language

**Artifact**:
A self-contained work product that can be versioned, previewed, downloaded, and shared. An artifact has one stable format throughout its lifetime.
_Avoid_: File, attachment

**Interactive artifact**:
An artifact whose content is intended to behave as a web experience, currently represented by HTML.
_Avoid_: App file, webpage file

**Document artifact**:
An artifact whose content is intended to be read as a document rather than executed as an application. Markdown and plain text are document artifacts.
_Avoid_: Text artifact

**Format**:
The stable kind of content an artifact contains, such as HTML, Markdown, or plain text.
_Avoid_: Extension, MIME type

**Version**:
An immutable snapshot of an artifact's content. Versions may change the content but must retain the artifact's format.
_Avoid_: Revision file

**Preview**:
A view of an artifact's content rendered according to its format. A preview is distinct from the source content and from the downloaded source.
_Avoid_: Browser view

**Source view**:
The faithful, unrendered content of a document artifact, available alongside its rendered preview.
_Avoid_: Raw preview

**Canonical source**:
The UTF-8 content that is authoritative for an artifact version and is used for download, digest, and rebuilding its preview.
_Avoid_: Rendered content

**Mermaid diagram**:
A diagram declared with Mermaid syntax inside a document artifact.
_Avoid_: Diagram attachment, image artifact

## Identity language

**Organization**:
The single administrative boundary served by one Portifact deployment.
_Avoid_: Tenant, workspace (when referring to the whole deployment)

**Internal user**:
A person authenticated as a member of the Organization.
_Avoid_: Company user, employee (unless employment status is relevant)

**Microsoft identity**:
The organization-managed identity used by an Internal user to sign in to Portifact.
_Avoid_: Microsoft account (when a personal Microsoft account is not allowed)
