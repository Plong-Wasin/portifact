import { and, asc, desc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { artifact, artifactVersion, job, oauthAccessToken, oauthApplication, shareLink } from "../db/schema";
import { contentBytes, contentDigest, type ArtifactFormat } from "./content";
import { decryptToken, DomainError, encryptToken, tokenDigest, tokenValue, validateName } from "./domain";
import type { Config } from "../config";

const now = () => new Date();
const id = () => crypto.randomUUID();

export type ArtifactMetadata = Omit<typeof artifact.$inferSelect, "latestVersionId" | "publishedVersionId"> & {
  latestVersionId: string | null;
  publishedVersionId: string | null;
};

export type ShareLinkInfo = {
  id: string;
  artifactId: string;
  token: string;
  url: string;
  revokedAt: Date | null;
  createdAt: Date;
};

export function metadata(row: typeof artifact.$inferSelect): ArtifactMetadata {
  return row;
}

export class ArtifactService {
  constructor(private readonly db: Database, private readonly config: Config) {}

  async list(ownerId: string, includeDeleted = false, limit = 1000) {
    return this.db.select().from(artifact).where(includeDeleted ? eq(artifact.ownerId, ownerId) : and(eq(artifact.ownerId, ownerId), isNull(artifact.deletedAt))).orderBy(desc(artifact.updatedAt)).limit(limit);
  }

  async trash(ownerId: string) {
    return this.db.select().from(artifact).where(and(eq(artifact.ownerId, ownerId), isNotNull(artifact.deletedAt))).orderBy(desc(artifact.updatedAt));
  }

  async get(ownerId: string, artifactId: string, includeDeleted = false) {
    const [row] = await this.db.select().from(artifact).where(includeDeleted ? and(eq(artifact.ownerId, ownerId), eq(artifact.id, artifactId)) : and(eq(artifact.ownerId, ownerId), eq(artifact.id, artifactId), isNull(artifact.deletedAt)));
    if (!row) throw new DomainError("ARTIFACT_NOT_FOUND", "artifact not found", 404);
    return row;
  }

  async versions(ownerId: string, artifactId: string, includeDeleted = false) {
    await this.get(ownerId, artifactId, includeDeleted);
    return this.db.select().from(artifactVersion).where(eq(artifactVersion.artifactId, artifactId)).orderBy(asc(artifactVersion.ordinal));
  }

  // Metadata-only listing: omits the content columns so list_versions does not pull
  // potentially MB of content per version only to discard it.
  async versionsMeta(ownerId: string, artifactId: string, includeDeleted = false) {
    await this.get(ownerId, artifactId, includeDeleted);
    return this.db.select({
      id: artifactVersion.id, artifactId: artifactVersion.artifactId, parentVersionId: artifactVersion.parentVersionId,
      ordinal: artifactVersion.ordinal, byteSize: artifactVersion.byteSize, digest: artifactVersion.digest,
      source: artifactVersion.source, creatorId: artifactVersion.creatorId, createdAt: artifactVersion.createdAt,
    }).from(artifactVersion).where(eq(artifactVersion.artifactId, artifactId)).orderBy(asc(artifactVersion.ordinal));
  }

  async shareLinks(ownerId: string, artifactId: string): Promise<ShareLinkInfo[]> {
    await this.get(ownerId, artifactId);
    const rows = await this.db.select({
      id: shareLink.id,
      artifactId: shareLink.artifactId,
      encryptedToken: shareLink.encryptedToken,
      revokedAt: shareLink.revokedAt,
      createdAt: shareLink.createdAt,
    }).from(shareLink).where(eq(shareLink.artifactId, artifactId)).orderBy(desc(shareLink.createdAt));
    return rows.map((row) => {
      const token = decryptToken(row.encryptedToken, this.config.shareLinkEncryptionKey);
      return { id: row.id, artifactId: row.artifactId, token, url: `/s/${token}`, revokedAt: row.revokedAt, createdAt: row.createdAt };
    });
  }

  async version(ownerId: string, artifactId: string, versionId: string, includeDeleted = false) {
    await this.get(ownerId, artifactId, includeDeleted);
    const [row] = await this.db.select().from(artifactVersion).where(and(eq(artifactVersion.artifactId, artifactId), eq(artifactVersion.id, versionId)));
    if (!row) throw new DomainError("VERSION_NOT_FOUND", "version not found", 404);
    return row;
  }

  async create(ownerId: string, nameInput: unknown, content: string, format: ArtifactFormat, source = "dashboard") {
    const name = validateName(nameInput);
    const bytes = contentBytes(content);
    if (!bytes.byteLength) throw new DomainError("EMPTY_CONTENT");
    if (bytes.byteLength > this.config.maxContentBytes) throw new DomainError("CONTENT_TOO_LARGE", "content is too large", 413);
    const retained = await this.db.select({ bytes: sql<number>`coalesce(sum(${artifactVersion.byteSize}), 0)` }).from(artifactVersion).innerJoin(artifact, eq(artifactVersion.artifactId, artifact.id)).where(and(eq(artifact.ownerId, ownerId), isNull(artifact.deletedAt)));
    if (Number(retained[0]?.bytes ?? 0) + bytes.byteLength > this.config.maxStorageBytes) throw new DomainError("USER_STORAGE_LIMIT_EXCEEDED");
    const artifactId = id();
    const versionId = id();
    const created = now();
    await this.db.transaction(async (tx) => {
      await tx.insert(artifact).values({ id: artifactId, ownerId, name, format, createdAt: created, updatedAt: created });
      await tx.insert(artifactVersion).values({ id: versionId, artifactId, ordinal: 1, content, byteSize: bytes.byteLength, digest: contentDigest(content), source, creatorId: ownerId, createdAt: created });
      await tx.update(artifact).set({ latestVersionId: versionId }).where(and(eq(artifact.id, artifactId), eq(artifact.ownerId, ownerId)));
    });
    return { artifact: await this.get(ownerId, artifactId), version: await this.version(ownerId, artifactId, versionId) };
  }

  async rename(ownerId: string, artifactId: string, nameInput: unknown) {
    const name = validateName(nameInput);
    await this.get(ownerId, artifactId);
    await this.db.update(artifact).set({ name, updatedAt: now() }).where(and(eq(artifact.ownerId, ownerId), eq(artifact.id, artifactId), isNull(artifact.deletedAt)));
    return this.get(ownerId, artifactId);
  }

  async createVersion(ownerId: string, artifactId: string, parentId: string, content: string, format: ArtifactFormat, source = "mcp") {
    const current = await this.get(ownerId, artifactId);
    const parent = await this.version(ownerId, artifactId, parentId);
    if (current.format !== format) throw new DomainError("ARTIFACT_FORMAT_MISMATCH", "artifact format cannot change", 409);
    const bytes = contentBytes(content);
    if (!bytes.byteLength) throw new DomainError("EMPTY_CONTENT");
    if (bytes.byteLength > this.config.maxContentBytes) throw new DomainError("CONTENT_TOO_LARGE", "content is too large", 413);
    const created = now();
    const versionId = id();
    await this.db.transaction(async (tx) => {
      const locked = await tx.select().from(artifact).where(and(eq(artifact.ownerId, ownerId), eq(artifact.id, artifactId))).for("update");
      if (!locked[0] || locked[0].deletedAt) throw new DomainError("ARTIFACT_DELETED", "artifact deleted", 409);
      const retained = await tx.select({ bytes: sql<number>`coalesce(sum(${artifactVersion.byteSize}), 0)` }).from(artifactVersion).innerJoin(artifact, eq(artifactVersion.artifactId, artifact.id)).where(and(eq(artifact.ownerId, ownerId), isNull(artifact.deletedAt)));
      if (Number(retained[0]?.bytes ?? 0) + bytes.byteLength > this.config.maxStorageBytes) throw new DomainError("USER_STORAGE_LIMIT_EXCEEDED");
      const [last] = await tx.select({ ordinal: artifactVersion.ordinal }).from(artifactVersion).where(eq(artifactVersion.artifactId, artifactId)).orderBy(desc(artifactVersion.ordinal)).limit(1);
      await tx.insert(artifactVersion).values({ id: versionId, artifactId, parentVersionId: parent.id, ordinal: (last?.ordinal ?? 0) + 1, content, byteSize: bytes.byteLength, digest: contentDigest(content), source, creatorId: ownerId, createdAt: created });
      await tx.update(artifact).set({ latestVersionId: versionId, updatedAt: created }).where(and(eq(artifact.ownerId, ownerId), eq(artifact.id, artifactId)));
    });
    return { artifact: current, version: await this.version(ownerId, artifactId, versionId) };
  }

  async publish(ownerId: string, artifactId: string, versionId: string) {
    const selected = await this.version(ownerId, artifactId, versionId);
    let token = "";
    await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(artifact).where(and(eq(artifact.ownerId, ownerId), eq(artifact.id, artifactId), isNull(artifact.deletedAt))).for("update");
      if (!current) throw new DomainError("ARTIFACT_NOT_FOUND", "artifact not found", 404);
      const [link] = await tx.select().from(shareLink).where(and(eq(shareLink.artifactId, artifactId), isNull(shareLink.revokedAt)));
      if (link) {
        token = decryptToken(link.encryptedToken, this.config.shareLinkEncryptionKey);
      } else {
        token = tokenValue();
        await tx.insert(shareLink).values({
          id: id(),
          artifactId,
          tokenHash: tokenDigest(token),
          encryptedToken: encryptToken(token, this.config.shareLinkEncryptionKey),
          revokedAt: null,
          createdAt: now(),
        });
      }
      await tx.update(artifact).set({ publishedVersionId: selected.id, updatedAt: now() }).where(eq(artifact.id, artifactId));
    });
    return { artifact: await this.get(ownerId, artifactId), version: selected, token, url: `/s/${token}` };
  }

  async unpublish(ownerId: string, artifactId: string) {
    await this.get(ownerId, artifactId);
    await this.db.update(artifact).set({ publishedVersionId: null, updatedAt: now() }).where(and(eq(artifact.ownerId, ownerId), eq(artifact.id, artifactId)));
  }

  async rotate(ownerId: string, artifactId: string) {
    let token = "";
    await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(artifact).where(and(eq(artifact.ownerId, ownerId), eq(artifact.id, artifactId), isNull(artifact.deletedAt))).for("update");
      if (!current) throw new DomainError("ARTIFACT_NOT_FOUND", "artifact not found", 404);
      if (!current.publishedVersionId) throw new DomainError("ARTIFACT_NOT_PUBLISHED", "artifact not published", 409);
      const timestamp = now();
      await tx.update(shareLink).set({ revokedAt: timestamp }).where(and(eq(shareLink.artifactId, artifactId), isNull(shareLink.revokedAt)));
      token = tokenValue();
      await tx.insert(shareLink).values({
        id: id(),
        artifactId,
        tokenHash: tokenDigest(token),
        encryptedToken: encryptToken(token, this.config.shareLinkEncryptionKey),
        revokedAt: null,
        createdAt: timestamp,
      });
    });
    return { token, url: `/s/${token}` };
  }

  async remove(ownerId: string, artifactId: string) {
    const current = await this.get(ownerId, artifactId);
    const deleted = now();
    const purgeAfter = new Date(deleted.getTime() + this.config.retentionDays * 86_400_000);
    await this.db.transaction(async (tx) => {
      await tx.update(artifact).set({ deletedAt: deleted, purgeAfter, publishedVersionId: null, updatedAt: deleted }).where(and(eq(artifact.ownerId, ownerId), eq(artifact.id, artifactId)));
      await tx.update(shareLink).set({ revokedAt: deleted }).where(and(eq(shareLink.artifactId, artifactId), isNull(shareLink.revokedAt)));
      await tx.insert(job).values({ id: id(), kind: "purge_artifact", artifactId, status: "pending", scheduledAt: purgeAfter, attempts: 0, createdAt: deleted, updatedAt: deleted });
    });
    return current;
  }

  async restore(ownerId: string, artifactId: string) {
    await this.get(ownerId, artifactId, true);
    await this.db.transaction(async (tx) => {
      await tx.update(artifact).set({ deletedAt: null, purgeAfter: null, publishedVersionId: null, updatedAt: now() }).where(and(eq(artifact.ownerId, ownerId), eq(artifact.id, artifactId)));
      await tx.delete(job).where(and(eq(job.artifactId, artifactId), eq(job.kind, "purge_artifact"), eq(job.status, "pending")));
    });
    return this.get(ownerId, artifactId);
  }

  async shared(token: string) {
    const [link] = await this.db.select().from(shareLink).where(eq(shareLink.tokenHash, tokenDigest(token)));
    if (!link) throw new DomainError("SHARE_NOT_FOUND", "share not found", 404);
    if (link.revokedAt) throw new DomainError("SHARE_REVOKED", "share revoked", 410);
    if (decryptToken(link.encryptedToken, this.config.shareLinkEncryptionKey) !== token) throw new DomainError("SHARE_NOT_FOUND", "share not found", 404);
    const [row] = await this.db.select().from(artifact).where(and(eq(artifact.id, link.artifactId), isNull(artifact.deletedAt)));
    if (!row?.publishedVersionId) throw new DomainError("SHARE_NOT_PUBLISHED", "share not published", 404);
    const [version] = await this.db.select().from(artifactVersion).where(and(eq(artifactVersion.artifactId, row.id), eq(artifactVersion.id, row.publishedVersionId)));
    if (!version) throw new DomainError("VERSION_NOT_FOUND", "version not found", 404);
    return { artifact: row, version };
  }

  async connections(ownerId: string) {
    return this.db.select({ id: oauthApplication.id, clientId: oauthApplication.clientId, name: oauthApplication.name, disabled: oauthApplication.disabled, createdAt: oauthApplication.createdAt }).from(oauthApplication).where(eq(oauthApplication.userId, ownerId)).orderBy(desc(oauthApplication.createdAt));
  }

  async revokeClient(ownerId: string, clientId: string) {
    const [client] = await this.db.select({ id: oauthApplication.id }).from(oauthApplication).where(and(eq(oauthApplication.userId, ownerId), eq(oauthApplication.clientId, clientId)));
    if (!client) throw new DomainError("OAUTH_CLIENT_NOT_FOUND", "oauth client not found", 404);
    await this.db.transaction(async (tx) => {
      // Disable the client so no further authorization grants are accepted, then
      // delete outstanding access/refresh tokens so active MCP sessions stop now.
      await tx.update(oauthApplication).set({ disabled: true, updatedAt: now() }).where(and(eq(oauthApplication.id, client.id)));
      await tx.delete(oauthAccessToken).where(eq(oauthAccessToken.clientId, clientId));
    });
  }
}
