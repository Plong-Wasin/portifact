import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { artifact, artifactAccess, artifactPin, artifactVersion, job, oauthAccessToken, oauthApplication, user } from "../db/schema";
import { contentBytes, contentDigest, type ArtifactFormat } from "./content";
import { ARTIFACT_ACCESS_ROLES, DomainError, GENERAL_ACCESS_MODES, type ArtifactAccessRole, type GeneralAccessMode, validateName } from "./domain";
import type { Config } from "../config";

const now = () => new Date();
const id = () => crypto.randomUUID();

export type ArtifactMetadata = typeof artifact.$inferSelect;

export type AccessKind = "owner" | "editor" | "viewer" | "general";

export type ArtifactViewerAccess = {
  kind: AccessKind;
  role?: ArtifactAccessRole;
  canManage: boolean;
  canContribute: boolean;
  canBrowseVersions: boolean;
  canViewSource: boolean;
  canDownload: boolean;
};

export type ArtifactViewer = {
  artifact: ArtifactMetadata;
  access: ArtifactViewerAccess;
};

export type ArtifactListItem = ArtifactMetadata & {
  accessRole: "owner" | ArtifactAccessRole;
  ownerName: string;
  ownerEmail: string;
  pinned: boolean;
};

export type PeopleWithAccess = {
  user: { id: string; name: string; email: string; banned: boolean; banExpires: Date | null };
  role: "owner" | ArtifactAccessRole;
};

const ownerAccess = (): ArtifactViewerAccess => ({
  kind: "owner",
  canManage: true,
  canContribute: true,
  canBrowseVersions: true,
  canViewSource: true,
  canDownload: true,
});

const editorAccess = (): ArtifactViewerAccess => ({
  kind: "editor",
  role: "editor",
  canManage: false,
  canContribute: true,
  canBrowseVersions: true,
  canViewSource: true,
  canDownload: true,
});

const viewerAccess = (): ArtifactViewerAccess => ({
  kind: "viewer",
  role: "viewer",
  canManage: false,
  canContribute: false,
  canBrowseVersions: true,
  canViewSource: false,
  canDownload: true,
});

const generalAccess = (): ArtifactViewerAccess => ({
  kind: "general",
  canManage: false,
  canContribute: false,
  canBrowseVersions: false,
  canViewSource: false,
  canDownload: false,
});

function notFound(): never {
  throw new DomainError("ARTIFACT_NOT_FOUND", "artifact not found", 404);
}

function forbidden(code = "ARTIFACT_ACCESS_FORBIDDEN"): never {
  throw new DomainError(code, "artifact access forbidden", 403);
}

function activeUser(row: typeof user.$inferSelect | undefined): typeof user.$inferSelect | null {
  if (!row) return null;
  if (row.banned) return null;
  if (row.banExpires && row.banExpires.getTime() > Date.now()) return null;
  return row;
}

export class ArtifactService {
  constructor(private readonly db: Database, private readonly config: Config) {}

  async list(ownerId: string, includeDeleted = false, limit = 1000) {
    const [current] = await this.db.select().from(user).where(eq(user.id, ownerId));
    if (!activeUser(current)) return [];
    return this.db.select().from(artifact).where(includeDeleted
      ? eq(artifact.ownerId, ownerId)
      : and(eq(artifact.ownerId, ownerId), isNull(artifact.deletedAt))).orderBy(desc(artifact.updatedAt)).limit(limit);
  }

  async listForUser(userId: string, filter: "all" | "yours" | "shared" = "all", search = "", limit = 1000): Promise<ArtifactListItem[]> {
    const current = activeUser((await this.db.select().from(user).where(eq(user.id, userId)))[0]);
    if (!current) return [];
    const owned = filter === "shared" ? [] : await this.db.select().from(artifact).where(and(eq(artifact.ownerId, userId), isNull(artifact.deletedAt)));
    const shared = filter === "yours" ? [] : await this.db.select({ artifact: artifact, access: artifactAccess }).from(artifactAccess)
      .innerJoin(artifact, eq(artifactAccess.artifactId, artifact.id))
      .where(and(eq(artifactAccess.userId, userId), isNull(artifact.deletedAt)));
    const artifactRows = new Map<string, ArtifactListItem>();
    for (const row of owned) artifactRows.set(row.id, { ...row, accessRole: "owner", ownerName: current.name, ownerEmail: current.email, pinned: false });
    const ownerIds = [...new Set(shared.map((row) => row.artifact.ownerId))];
    const owners = ownerIds.length ? await this.db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, ownerIds)) : [];
    const ownerById = new Map(owners.map((row) => [row.id, row]));
    for (const row of shared) {
      const owner = ownerById.get(row.artifact.ownerId);
      if (owner) artifactRows.set(row.artifact.id, { ...row.artifact, accessRole: row.access.role, ownerName: owner.name, ownerEmail: owner.email, pinned: false });
    }
    const visible = [...artifactRows.values()];
    const pins = visible.length
      ? await this.db.select({ artifactId: artifactPin.artifactId }).from(artifactPin).where(and(eq(artifactPin.userId, userId), inArray(artifactPin.artifactId, visible.map((row) => row.id))))
      : [];
    const pinned = new Set(pins.map((row) => row.artifactId));
    for (const row of visible) row.pinned = pinned.has(row.id);
    const needle = search.trim().toLocaleLowerCase();
    return visible.filter((row) => !needle || row.name.toLocaleLowerCase().includes(needle))
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt.getTime() - left.updatedAt.getTime())
      .slice(0, limit);
  }

  async trash(ownerId: string) {
    const [current] = await this.db.select().from(user).where(eq(user.id, ownerId));
    if (!activeUser(current)) return [];
    return this.db.select().from(artifact).where(and(eq(artifact.ownerId, ownerId), isNotNull(artifact.deletedAt))).orderBy(desc(artifact.updatedAt));
  }

  async get(ownerId: string, artifactId: string, includeDeleted = false): Promise<ArtifactMetadata> {
    const [current] = await this.db.select().from(user).where(eq(user.id, ownerId));
    if (!activeUser(current)) return notFound();
    const [row] = await this.db.select().from(artifact).where(includeDeleted
      ? and(eq(artifact.ownerId, ownerId), eq(artifact.id, artifactId))
      : and(eq(artifact.ownerId, ownerId), eq(artifact.id, artifactId), isNull(artifact.deletedAt)));
    if (!row) return notFound();
    return row;
  }

  async getForViewer(userId: string | null, artifactId: string): Promise<ArtifactViewer> {
    const [row] = await this.db.select().from(artifact).where(and(eq(artifact.id, artifactId), isNull(artifact.deletedAt)));
    if (!row) return notFound();
    const current = userId ? activeUser((await this.db.select().from(user).where(eq(user.id, userId)))[0]) : null;
    if (userId && !current) return notFound();
    if (!current && row.generalAccess === "everyone_with_login") {
      throw new DomainError("LOGIN_REQUIRED", "sign in required", 401);
    }
    if (current?.id === row.ownerId) return { artifact: row, access: ownerAccess() };
    if (current) {
      const [grant] = await this.db.select().from(artifactAccess).where(and(eq(artifactAccess.artifactId, artifactId), eq(artifactAccess.userId, current.id)));
      if (grant) return { artifact: row, access: grant.role === "editor" ? editorAccess() : viewerAccess() };
    }
    if (row.generalAccess === "everyone_with_login" && current) return { artifact: row, access: generalAccess() };
    if (row.generalAccess === "anyone_with_the_link") return { artifact: row, access: generalAccess() };
    return notFound();
  }

  async versions(ownerId: string, artifactId: string, includeDeleted = false) {
    await this.get(ownerId, artifactId, includeDeleted);
    return this.db.select().from(artifactVersion).where(eq(artifactVersion.artifactId, artifactId)).orderBy(asc(artifactVersion.ordinal));
  }

  async versionsMeta(ownerId: string, artifactId: string, includeDeleted = false) {
    await this.get(ownerId, artifactId, includeDeleted);
    return this.versionMetadata(artifactId);
  }

  async versionsMetaForViewer(userId: string, artifactId: string) {
    const viewer = await this.getForViewer(userId, artifactId);
    if (!viewer.access.canBrowseVersions) return forbidden("VERSION_HISTORY_FORBIDDEN");
    return this.versionMetadata(viewer.artifact.id);
  }

  private async versionMetadata(artifactId: string) {
    return this.db.select({
      id: artifactVersion.id, artifactId: artifactVersion.artifactId, parentVersionId: artifactVersion.parentVersionId,
      ordinal: artifactVersion.ordinal, byteSize: artifactVersion.byteSize, digest: artifactVersion.digest,
      source: artifactVersion.source, creatorId: artifactVersion.creatorId, createdAt: artifactVersion.createdAt,
    }).from(artifactVersion).where(eq(artifactVersion.artifactId, artifactId)).orderBy(asc(artifactVersion.ordinal));
  }

  async version(ownerId: string, artifactId: string, versionId: string, includeDeleted = false) {
    await this.get(ownerId, artifactId, includeDeleted);
    return this.versionById(artifactId, versionId);
  }

  async versionForViewer(userId: string, artifactId: string, versionId: string) {
    const viewer = await this.getForViewer(userId, artifactId);
    if (!viewer.access.canBrowseVersions) return forbidden("VERSION_FORBIDDEN");
    return this.versionById(viewer.artifact.id, versionId);
  }

  private async versionById(artifactId: string, versionId: string) {
    const [row] = await this.db.select().from(artifactVersion).where(and(eq(artifactVersion.artifactId, artifactId), eq(artifactVersion.id, versionId)));
    if (!row) throw new DomainError("VERSION_NOT_FOUND", "version not found", 404);
    return row;
  }

  async viewerVersion(userId: string | null, artifactId: string, requestedVersionId?: string) {
    const viewer = await this.getForViewer(userId, artifactId);
    if (requestedVersionId && viewer.access.canBrowseVersions) return { ...viewer, version: await this.versionById(viewer.artifact.id, requestedVersionId) };
    if (requestedVersionId && !viewer.access.canBrowseVersions) {
      const effectiveSharedVersionId = viewer.artifact.sharedVersionId ?? viewer.artifact.latestVersionId;
      if (requestedVersionId !== effectiveSharedVersionId) return forbidden("VERSION_FORBIDDEN");
      return { ...viewer, version: await this.versionById(viewer.artifact.id, requestedVersionId) };
    }
    const selectedVersionId = viewer.access.canBrowseVersions
      ? viewer.artifact.latestVersionId
      : viewer.artifact.sharedVersionId ?? viewer.artifact.latestVersionId;
    if (!selectedVersionId) throw new DomainError("VERSION_NOT_FOUND", "version not found", 404);
    return { ...viewer, version: await this.versionById(viewer.artifact.id, selectedVersionId) };
  }

  async shareSettings(userId: string, artifactId: string) {
    const viewer = await this.getForViewer(userId, artifactId);
    const rows = await this.db.select({ access: artifactAccess, person: user }).from(artifactAccess)
      .innerJoin(user, eq(artifactAccess.userId, user.id)).where(eq(artifactAccess.artifactId, artifactId));
    const [owner] = await this.db.select().from(user).where(eq(user.id, viewer.artifact.ownerId));
    const people: PeopleWithAccess[] = [];
    if (owner) people.push({ user: { id: owner.id, name: owner.name, email: owner.email, banned: owner.banned, banExpires: owner.banExpires }, role: "owner" });
    for (const row of rows) people.push({ user: { id: row.person.id, name: row.person.name, email: row.person.email, banned: row.person.banned, banExpires: row.person.banExpires }, role: row.access.role });
    return { artifact: viewer.artifact, access: viewer.access, people, canManage: viewer.access.kind === "owner" };
  }

  async searchInternalUsers(ownerId: string, query: unknown, limit = 20) {
    const value = typeof query === "string" ? query.trim() : "";
    if (!value) return [];
    const pattern = `%${value}%`;
    return this.db.select({ id: user.id, name: user.name, email: user.email }).from(user)
      .where(and(eq(user.banned, false), or(isNull(user.banExpires), gt(user.banExpires, new Date())), or(ilike(user.name, pattern), ilike(user.email, pattern)), sql`${user.id} <> ${ownerId}`))
      .orderBy(user.name).limit(limit);
  }

  async create(ownerId: string, nameInput: unknown, content: string, format: ArtifactFormat, source = "dashboard") {
    const [owner] = await this.db.select().from(user).where(eq(user.id, ownerId));
    if (!activeUser(owner)) return notFound();
    const name = validateName(nameInput);
    const bytes = contentBytes(content);
    if (!bytes.byteLength) throw new DomainError("EMPTY_CONTENT");
    if (bytes.byteLength > this.config.maxContentBytes) throw new DomainError("CONTENT_TOO_LARGE", "content is too large", 413);
    const retained = await this.db.select({ bytes: sql<number>`coalesce(sum(${artifactVersion.byteSize}), 0)` }).from(artifactVersion)
      .innerJoin(artifact, eq(artifactVersion.artifactId, artifact.id)).where(and(eq(artifact.ownerId, ownerId), isNull(artifact.deletedAt)));
    if (Number(retained[0]?.bytes ?? 0) + bytes.byteLength > this.config.maxStorageBytes) throw new DomainError("USER_STORAGE_LIMIT_EXCEEDED");
    const artifactId = id();
    const versionId = id();
    const created = now();
    await this.db.transaction(async (tx) => {
      await tx.insert(artifact).values({ id: artifactId, ownerId, name, format, generalAccess: "only_people_with_access", sharedVersionId: null, createdAt: created, updatedAt: created });
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

  async createVersion(actorId: string, artifactId: string, parentId: string, content: string, format: ArtifactFormat, source = "mcp") {
    const viewer = await this.getForViewer(actorId, artifactId);
    if (!viewer.access.canContribute) return forbidden("VERSION_CREATE_FORBIDDEN");
    if (viewer.artifact.format !== format) throw new DomainError("ARTIFACT_FORMAT_MISMATCH", "artifact format cannot change", 409);
    const parent = await this.versionById(artifactId, parentId);
    const bytes = contentBytes(content);
    if (!bytes.byteLength) throw new DomainError("EMPTY_CONTENT");
    if (bytes.byteLength > this.config.maxContentBytes) throw new DomainError("CONTENT_TOO_LARGE", "content is too large", 413);
    const digest = contentDigest(content);
    const created = now();
    const versionId = id();
    let resultVersionId: string = versionId;
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(artifact).where(and(eq(artifact.id, artifactId), isNull(artifact.deletedAt))).for("update");
      if (!locked) return notFound();
      if (locked.latestVersionId !== parent.id) throw new DomainError("VERSION_CONFLICT", "artifact has a newer version", 409);
      const [latest] = await tx.select().from(artifactVersion).where(eq(artifactVersion.id, locked.latestVersionId));
      if (latest?.digest === digest) {
        resultVersionId = latest.id;
        return;
      }
      const retained = await tx.select({ bytes: sql<number>`coalesce(sum(${artifactVersion.byteSize}), 0)` }).from(artifactVersion)
        .innerJoin(artifact, eq(artifactVersion.artifactId, artifact.id)).where(and(eq(artifact.ownerId, locked.ownerId), isNull(artifact.deletedAt)));
      if (Number(retained[0]?.bytes ?? 0) + bytes.byteLength > this.config.maxStorageBytes) throw new DomainError("USER_STORAGE_LIMIT_EXCEEDED");
      const [last] = await tx.select({ ordinal: artifactVersion.ordinal }).from(artifactVersion).where(eq(artifactVersion.artifactId, artifactId)).orderBy(desc(artifactVersion.ordinal)).limit(1);
      await tx.insert(artifactVersion).values({ id: versionId, artifactId, parentVersionId: parent.id, ordinal: (last?.ordinal ?? 0) + 1, content, byteSize: bytes.byteLength, digest, source, creatorId: actorId, createdAt: created });
      await tx.update(artifact).set({ latestVersionId: versionId, updatedAt: created }).where(eq(artifact.id, artifactId));
    });
    return { artifact: (await this.getForViewer(actorId, artifactId)).artifact, version: await this.versionById(artifactId, resultVersionId) };
  }

  async grantAccess(ownerId: string, artifactId: string, targetUserId: unknown, roleInput: unknown) {
    await this.get(ownerId, artifactId);
    const targetId = typeof targetUserId === "string" ? targetUserId : "";
    const role = typeof roleInput === "string" && ARTIFACT_ACCESS_ROLES.includes(roleInput as ArtifactAccessRole) ? roleInput as ArtifactAccessRole : null;
    if (!targetId || !role) throw new DomainError("INVALID_ARTIFACT_ACCESS", "invalid artifact access");
    if (targetId === ownerId) throw new DomainError("OWNER_ACCESS_IMMUTABLE", "owner access cannot be changed", 409);
    const target = activeUser((await this.db.select().from(user).where(eq(user.id, targetId)))[0]);
    if (!target) throw new DomainError("USER_NOT_FOUND", "user not found", 404);
    const timestamp = now();
    await this.db.insert(artifactAccess).values({ id: id(), artifactId, userId: targetId, role, createdAt: timestamp, updatedAt: timestamp }).onConflictDoUpdate({
      target: [artifactAccess.artifactId, artifactAccess.userId],
      set: { role, updatedAt: timestamp },
    });
  }

  async removeAccess(ownerId: string, artifactId: string, targetUserId: string) {
    await this.get(ownerId, artifactId);
    await this.db.delete(artifactAccess).where(and(eq(artifactAccess.artifactId, artifactId), eq(artifactAccess.userId, targetUserId)));
  }

  async leaveAccess(userId: string, artifactId: string) {
    const viewer = await this.getForViewer(userId, artifactId);
    if (viewer.access.kind === "owner") throw new DomainError("OWNER_ACCESS_IMMUTABLE", "owner cannot leave an artifact", 409);
    if (viewer.access.kind === "general") throw new DomainError("ACCESS_LEAVE_FORBIDDEN", "general access cannot be left", 403);
    await this.db.delete(artifactAccess).where(and(eq(artifactAccess.artifactId, artifactId), eq(artifactAccess.userId, userId)));
  }

  async setGeneralAccess(ownerId: string, artifactId: string, modeInput: unknown) {
    const current = await this.get(ownerId, artifactId);
    const mode = typeof modeInput === "string" && GENERAL_ACCESS_MODES.includes(modeInput as GeneralAccessMode) ? modeInput as GeneralAccessMode : null;
    if (!mode) throw new DomainError("INVALID_GENERAL_ACCESS", "invalid general access mode");
    await this.db.update(artifact).set({ generalAccess: mode, sharedVersionId: mode === "only_people_with_access" ? null : current.sharedVersionId, updatedAt: now() }).where(and(eq(artifact.id, artifactId), eq(artifact.ownerId, ownerId), isNull(artifact.deletedAt)));
    return this.get(ownerId, artifactId);
  }

  async setSharedVersion(ownerId: string, artifactId: string, versionInput: unknown) {
    const current = await this.get(ownerId, artifactId);
    if (current.generalAccess === "only_people_with_access") {
      if (current.sharedVersionId !== null) await this.db.update(artifact).set({ sharedVersionId: null, updatedAt: now() }).where(eq(artifact.id, artifactId));
      return this.get(ownerId, artifactId);
    }
    const sharedVersionSelection = typeof versionInput === "string" ? versionInput : "latest";
    const selected = sharedVersionSelection === "latest" || sharedVersionSelection === "" ? null : await this.versionById(artifactId, sharedVersionSelection);
    await this.db.update(artifact).set({ sharedVersionId: selected ? selected.id : null, updatedAt: now() }).where(and(eq(artifact.id, artifactId), eq(artifact.ownerId, ownerId), isNull(artifact.deletedAt)));
    return this.get(ownerId, artifactId);
  }

  async pin(userId: string, artifactId: string) {
    await this.getForViewer(userId, artifactId);
    await this.db.insert(artifactPin).values({ id: id(), artifactId, userId, createdAt: now() }).onConflictDoNothing({ target: [artifactPin.artifactId, artifactPin.userId] });
  }

  async unpin(userId: string, artifactId: string) {
    await this.getForViewer(userId, artifactId);
    await this.db.delete(artifactPin).where(and(eq(artifactPin.artifactId, artifactId), eq(artifactPin.userId, userId)));
  }

  async isPinned(userId: string, artifactId: string): Promise<boolean> {
    await this.getForViewer(userId, artifactId);
    const [row] = await this.db.select({ id: artifactPin.id }).from(artifactPin).where(and(eq(artifactPin.artifactId, artifactId), eq(artifactPin.userId, userId)));
    return Boolean(row);
  }

  async remove(ownerId: string, artifactId: string) {
    const current = await this.get(ownerId, artifactId);
    const deleted = now();
    const purgeAfter = new Date(deleted.getTime() + this.config.retentionDays * 86_400_000);
    await this.db.transaction(async (tx) => {
      await tx.update(artifact).set({ deletedAt: deleted, purgeAfter, generalAccess: "only_people_with_access", sharedVersionId: null, updatedAt: deleted }).where(and(eq(artifact.ownerId, ownerId), eq(artifact.id, artifactId)));
      await tx.insert(job).values({ id: id(), kind: "purge_artifact", artifactId, status: "pending", scheduledAt: purgeAfter, attempts: 0, createdAt: deleted, updatedAt: deleted });
    });
    return current;
  }

  async restore(ownerId: string, artifactId: string) {
    await this.get(ownerId, artifactId, true);
    await this.db.transaction(async (tx) => {
      await tx.update(artifact).set({ deletedAt: null, purgeAfter: null, generalAccess: "only_people_with_access", sharedVersionId: null, updatedAt: now() }).where(and(eq(artifact.ownerId, ownerId), eq(artifact.id, artifactId)));
      await tx.delete(job).where(and(eq(job.artifactId, artifactId), eq(job.kind, "purge_artifact"), eq(job.status, "pending")));
    });
    return this.get(ownerId, artifactId);
  }

  async connections(ownerId: string) {
    return this.db.select({ id: oauthApplication.id, clientId: oauthApplication.clientId, name: oauthApplication.name, disabled: oauthApplication.disabled, createdAt: oauthApplication.createdAt }).from(oauthApplication).where(eq(oauthApplication.userId, ownerId)).orderBy(desc(oauthApplication.createdAt));
  }

  async revokeClient(ownerId: string, clientId: string) {
    const [client] = await this.db.select({ id: oauthApplication.id }).from(oauthApplication).where(and(eq(oauthApplication.userId, ownerId), eq(oauthApplication.clientId, clientId)));
    if (!client) throw new DomainError("OAUTH_CLIENT_NOT_FOUND", "oauth client not found", 404);
    await this.db.transaction(async (tx) => {
      await tx.update(oauthApplication).set({ disabled: true, updatedAt: now() }).where(and(eq(oauthApplication.id, client.id)));
      await tx.delete(oauthAccessToken).where(eq(oauthAccessToken.clientId, clientId));
    });
  }
}
