# Portifact Artifact Context

Portifact stores self-contained work products that can be viewed, reused, and shared independently of the conversation or process that created them.

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

## Access language

**Owner**:
The Internal user who owns an Artifact and has authority to manage its name, access, sharing, and deletion.
_Avoid_: Creator (when ownership is meant)

**Explicit access**:
Permission granted directly to a named Internal user for one Artifact.
_Avoid_: Invite (after access has been granted)

**Viewer**:
An Internal user with Explicit access limited to viewing an Artifact and its available Versions, without changing its content or access.
_Avoid_: Reader

**Editor**:
An Internal user with Explicit access to contribute new Versions to an Artifact through supported uploads, without owning the Artifact or managing its access.
_Avoid_: Collaborator (when the role matters)

**General access**:
An Artifact-wide audience rule that determines whether access is limited to people with Explicit access, available to all logged-in Internal users, or available to anyone with the Artifact link.
_Avoid_: Public access (because some modes are not public)

**Shared version**:
The Version shown to viewers who reach an Artifact through General access without Explicit access. `latest` follows the newest Version, while a numbered Version remains fixed; people with Explicit access can access every Version instead.
_Avoid_: Published revision

**Version history**:
The ordered collection of immutable Versions belonging to an Artifact, which people with Explicit access can browse and open individually.
_Avoid_: Revision history

**Artifact link**:
The one stable address for an Artifact and all of its Versions, regardless of whether the viewer is its Owner, has Explicit access, is a logged-in Internal user, or is an anonymous link visitor.
_Avoid_: Share link (when referring to a separate URL)

**Pin**:
A personal marker an Internal user applies to an Artifact for dashboard organization.
_Avoid_: Favorite

**Trash**:
The recoverable state of a deleted Artifact during its retention period.
_Avoid_: Archive
