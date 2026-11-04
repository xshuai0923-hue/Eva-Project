import { principalLogin } from "./principal-login.js";
// Shared spine for every kind of record Eva-Project keeps in OpenProject.
//
// Requirements and handoffs are different record types but live in the same projects
// and obey the same rules for visibility, ownership, concurrency and description
// sections. Those rules exist once, here, so the two cannot drift apart — a second
// copy of `canRead` would fail silently and in the direction that leaks data.

import { OpenProjectHttpError, type OpenProjectApi } from "./openproject.js";
import type {
  FieldDefinition,
  FieldMap,
  HalLink,
  Principal,
  ProjectResource,
  WorkPackage
} from "./types.js";

export class RequirementConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequirementConflictError";
  }
}

export class RequirementValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequirementValidationError";
  }
}

export const FIELD = {
  requirementId: "requirementId",
  requesterType: "requesterType",
  requesterName: "requesterName",
  requesterId: "requesterId",
  visibility: "visibility",
  ownerUserId: "ownerUserId",
  recordedAt: "recordedAt",
  sourceUpdatedAt: "sourceUpdatedAt",
  modules: "modules",
  responsibleAgent: "responsibleAgent",
  claimedAgent: "claimedAgent",
  claimedSession: "claimedSession",
  claimLabel: "claimLabel",
  claimedAt: "claimedAt",
  claimScope: "claimScope",
  intakeStatus: "intakeStatus",
  state: "state",
  priority: "priority",
  proposedAt: "proposedAt",
  proposedTimePrecision: "proposedTimePrecision",
  sourceSessionId: "sourceSessionId",
  sourceMessageId: "sourceMessageId",
  sourceLabel: "sourceLabel",
  requiredForParent: "requiredForParent",
  verificationStatus: "verificationStatus",
  userAcceptance: "userAcceptance"
} as const;

function hrefId(href: string): string {
  return href.split("/").filter(Boolean).at(-1) ?? href;
}

function linkTitle(value: HalLink | HalLink[] | undefined): string | null {
  if (!value || Array.isArray(value)) {
    return null;
  }
  return value.title ?? null;
}

function linkTitles(value: HalLink | HalLink[] | undefined): string[] {
  if (!value) {
    return [];
  }
  return (Array.isArray(value) ? value : [value])
    .map(item => item.title ?? (typeof item.href === "string" ? hrefId(item.href) : null))
    .filter((item): item is string => Boolean(item));
}

function relationWorkPackageId(link: HalLink): number {
  if (!link.href) throw new Error("Relation work package link has no href");
  const value = Number(hrefId(link.href));
  if (!Number.isInteger(value)) {
    throw new Error(`Invalid work package link: ${link.href}`);
  }
  return value;
}

export { hrefId, linkTitle, linkTitles, relationWorkPackageId };

export abstract class OpenProjectRecordService {
  protected readonly projects = new Map<string, ProjectResource>();
  private readonly openProjectUserIds = new Map<string, number | null>();

  constructor(
    protected readonly client: OpenProjectApi,
    protected readonly map: FieldMap
  ) {}

  protected field(name: string): FieldDefinition {
    const field = this.map.fields[name];
    if (!field) {
      throw new Error(`Field map is missing ${name}`);
    }
    return field;
  }

  protected option(name: string, value: string): string {
    const option = this.field(name).options?.[value];
    if (!option) {
      throw new RequirementValidationError(`Unsupported ${name} value: ${value}`);
    }
    return option;
  }

  protected readText(workPackage: WorkPackage, name: string): string | null {
    const value = workPackage[this.field(name).key];
    // A long text field comes back as { raw, html }; everything else as a string.
    if (value && typeof value === "object" && "raw" in value) {
      const raw = (value as { raw?: unknown }).raw;
      return typeof raw === "string" && raw.length > 0 ? raw : null;
    }
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  protected readBool(workPackage: WorkPackage, name: string): boolean {
    return workPackage[this.field(name).key] === true;
  }

  protected readInt(workPackage: WorkPackage, name: string): number | null {
    const value = workPackage[this.field(name).key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  protected readList(workPackage: WorkPackage, name: string): string[] {
    return linkTitles(workPackage._links[this.field(name).key]);
  }

  /**
   * Long text custom fields.
   *
   * API v3 carries them as `{ raw, html }`, never as a bare string. Sending a plain
   * string is not rejected — OpenProject drops the value without a word. That is why
   * 认领范围 has been empty after every claim ever made, on requirements and handoffs
   * alike: it is the one field declared `format: "text"`, and nothing ever said so.
   *
   * Field maps written before this distinction record it as plain "text", so the one
   * known name is listed here too. It can go once every map has been regenerated.
   */
  private formattable(name: string, field: FieldDefinition): boolean {
    return field.kind === "formattable" || name === "claimScope";
  }

  protected writeField(
    payload: Record<string, unknown>,
    name: string,
    value: string | string[] | boolean | number | null
  ): void {
    const field = this.field(name);
    if (this.formattable(name, field)) {
      payload[field.key] = value === null ? null : { raw: String(value) };
      return;
    }
    if (field.kind === "list") {
      const values = value === null ? [] : Array.isArray(value) ? value : [String(value)];
      const links = values.map(item => ({ href: this.option(name, item) }));
      const root = (payload._links ?? {}) as Record<string, unknown>;
      root[field.key] = field.multi ? links : (links[0] ?? { href: null });
      payload._links = root;
      return;
    }
    payload[field.key] = value;
  }

  /** Null on field maps generated before handoffs existed, which disables the split. */
  protected handoffTypeId(): number | null {
    const href = this.map.handoffTypeHref;
    if (!href) return null;
    const value = Number(hrefId(href));
    return Number.isInteger(value) ? value : null;
  }

  /**
   * The types a project must have enabled before it can serve as a requirement pool:
   * the ones a requirement may be filed as, plus the one a handoff is written as.
   *
   * Which types a new project gets is not decided per project. Two instance-wide
   * settings decide it -- Type#is_default and Setting.default_projects_modules -- and
   * the bootstrap script that converges them does not run on deploy. So the set can
   * drift back to the factory one (Task, Milestone, Summary task) without anything
   * here changing, which is why the check reads the project rather than trusting it.
   */
  protected poolTypeIds(): number[] {
    const hrefs = this.map.requirementTypeHrefs?.length
      ? this.map.requirementTypeHrefs
      : [this.map.typeHref];
    const ids = new Set<number>();
    for (const href of hrefs) {
      const value = Number(hrefId(href));
      if (Number.isInteger(value)) ids.add(value);
    }
    const handoff = this.handoffTypeId();
    if (handoff !== null) ids.add(handoff);
    return [...ids];
  }

  protected workPackageTypeId(workPackage: WorkPackage): number | null {
    const link = Array.isArray(workPackage._links.type) ? undefined : workPackage._links.type;
    return link?.href ? Number(hrefId(link.href)) : null;
  }

  protected statusHref(state: string): string {
    const href = this.map.statusHrefs[state];
    if (!href) {
      throw new RequirementValidationError(`No OpenProject status mapped for state: ${state}`);
    }
    return href;
  }

  protected async project(identifier?: string): Promise<ProjectResource> {
    const key = identifier ?? this.map.defaultProjectIdentifier;
    const cached = this.projects.get(key);
    if (cached) return cached;
    try {
      const project = await this.client.getProject(key);
      this.projects.set(key, project);
      this.projects.set(project.identifier, project);
      this.projects.set(String(project.id), project);
      return project;
    } catch (error) {
      if (error instanceof OpenProjectHttpError && error.status === 404) {
        throw new RequirementValidationError(`Project not found: ${key}`);
      }
      throw error;
    }
  }

  /**
   * The OpenProject user this identity acts as.
   *
   * Project visibility is OpenProject's own judgement — membership plus the project's
   * public flag — so it can only be asked in OpenProject's terms. Cached per login: an
   * account's id changes about as often as the account does.
   */
  protected async openProjectUserId(principal: Principal): Promise<number | null> {
    const login = principalLogin(principal);
    if (login === null) return null;
    const cached = this.openProjectUserIds.get(login);
    if (cached !== undefined) return cached;
    const result = await this.client.listUsers({
      filters: JSON.stringify([{ login: { operator: "=", values: [login] } }]),
      pageSize: "2"
    });
    const id = result._embedded.elements.find(user => user.login === login)?.id ?? null;
    this.openProjectUserIds.set(login, id);
    return id;
  }

  /**
   * Resolves a project, refusing it when this caller cannot see it.
   *
   * Nothing used to check this. The MCP reads through a service token, so a project's
   * public flag and its memberships never applied to the caller: any authenticated
   * identity could read any project's requirements, held back only by per-record
   * `canRead`. Asking OpenProject keeps one source of truth — projects and people are
   * administered there — instead of a second access list inside `principals.json`.
   *
   * The decision itself is deliberately not cached. A membership revoked in OpenProject
   * has to take effect on the next call, not whenever a cache happens to expire.
   */
  protected async visibleProject(
    identifier: string | undefined,
    principal: Principal
  ): Promise<ProjectResource> {
    const project = await this.project(identifier);
    // Archiving is not a soft hide: OpenProject answers 403 for an archived project's
    // types, so everything built on top of it fails a step later with a status code and
    // a URL, which reads like a permission problem rather than the plain fact that the
    // project was put away. Say the fact here instead.
    if (project.active === false) {
      throw new RequirementValidationError(
        `Project ${identifier ?? project.identifier} is archived; ` +
        "OpenProject refuses its types while it is, so unarchive it before using it as a pool"
      );
    }
    if (principal.role === "admin") return project;

    const userId = await this.openProjectUserId(principal);
    if (userId === null) {
      throw new RequirementValidationError(
        `No OpenProject account matches ${principalLogin(principal) ?? "(unlinked)"}; ` +
        "ask an administrator to link a webpage account in MCP user management (openProjectLogin)"
      );
    }
    const match = await this.client.listProjects({
      filters: JSON.stringify([
        { visible: { operator: "=", values: [String(userId)] } },
        { id: { operator: "=", values: [String(project.id)] } }
      ]),
      pageSize: "1"
    });
    if (match.total === 0) {
      // Same wording as a missing project: whether a project one cannot see exists is
      // itself not something to disclose.
      throw new RequirementValidationError(`Project not found: ${identifier ?? project.identifier}`);
    }
    return project;
  }

  protected readMarkdownSection(markdown: string, heading: string): string | null {
    const runs = this.readMarkdownSections(markdown, heading);
    return runs.length ? runs.join("\n\n") : null;
  }

  /**
   * Every run under `## heading`, in document order.
   *
   * A body is not guaranteed to name a heading once. 变更记录 in particular was pasted
   * fresh by each state update and each release, so one requirement carried 22 of them --
   * and reading the first match returned the oldest line and silently dropped the other
   * 21. Runs are returned separately rather than merged so the caller decides; the
   * headings between them are not necessarily the same, so the order is document order,
   * which for an appended log is also time order.
   */
  protected readMarkdownSections(markdown: string, heading: string): string[] {
    const lines = markdown.split("\n");
    const marker = `## ${heading}`;
    const runs: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]?.trim() !== marker) continue;
      let end = lines.length;
      for (let scan = index + 1; scan < lines.length; scan += 1) {
        if (lines[scan]?.startsWith("## ")) {
          end = scan;
          break;
        }
      }
      const value = lines.slice(index + 1, end).join("\n").trim();
      if (value) runs.push(value);
      index = end - 1;
    }
    return runs;
  }

  /** Removes every later run of `marker`, keeping the one already written. */
  private dropRepeatedSections(lines: string[], marker: string, from: number): string {
    const kept: string[] = lines.slice(0, from);
    for (let index = from; index < lines.length; index += 1) {
      if (lines[index]?.trim() !== marker) {
        kept.push(lines[index] as string);
        continue;
      }
      // Skip the heading and everything under it, up to the next heading.
      let end = lines.length;
      for (let scan = index + 1; scan < lines.length; scan += 1) {
        if (lines[scan]?.startsWith("## ")) {
          end = scan;
          break;
        }
      }
      index = end - 1;
    }
    return kept.join("\n");
  }

  /** The headings a body carries, in document order, each named once. */
  protected markdownSectionNames(markdown: string): string[] {
    const names: string[] = [];
    for (const line of markdown.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("## ")) continue;
      const name = trimmed.slice(3).trim();
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  }

  protected writeMarkdownSection(markdown: string, heading: string, content: string): string {
    const lines = markdown.split("\n");
    const marker = `## ${heading}`;
    const start = lines.findIndex(line => line.trim() === marker);
    const replacement = [marker, "", content.trim()];
    if (start >= 0) {
      let end = lines.length;
      for (let index = start + 1; index < lines.length; index += 1) {
        if (lines[index]?.startsWith("## ")) {
          end = index;
          break;
        }
      }
      lines.splice(start, end - start, ...replacement, "");
      // A body should not carry two sections under one name. Writing collapses any extra
      // runs into the one just written, so a read-modify-write heals a body that older
      // code duplicated -- and pairs with readMarkdownSections, which gathers them.
      return this.dropRepeatedSections(lines, marker, start + replacement.length).trim();
    }
    const history = lines.findIndex(line => line.trim() === "## 变更记录");
    if (history >= 0) {
      lines.splice(history, 0, ...replacement, "");
    } else {
      lines.push("", ...replacement);
    }
    return lines.join("\n").trim();
  }

  protected addStatusLink(payload: Record<string, unknown>, state: string): void {
    const links = (payload._links ?? {}) as Record<string, unknown>;
    links.status = { href: this.statusHref(state) };
    payload._links = links;
  }

  protected assertExpectedVersion(workPackage: WorkPackage, expected?: number): void {
    if (expected !== undefined && expected !== workPackage.lockVersion) {
      throw new RequirementConflictError(
        `Stale lockVersion: expected ${expected}, current ${workPackage.lockVersion}`
      );
    }
  }

  protected canRead(workPackage: WorkPackage, principal: Principal): boolean {
    if (principal.role === "admin") return true;
    if (this.readText(workPackage, FIELD.ownerUserId) === principal.userId) return true;
    return this.readList(workPackage, FIELD.visibility)[0] === "公开";
  }

  protected assertReadable(workPackage: WorkPackage, principal: Principal): void {
    if (!this.canRead(workPackage, principal)) {
      throw new RequirementValidationError("Requirement not found");
    }
  }

  protected assertOwnerOrAdmin(workPackage: WorkPackage, principal: Principal): void {
    if (principal.role === "admin" || this.readText(workPackage, FIELD.ownerUserId) === principal.userId) {
      return;
    }
    throw new RequirementValidationError("Requirement not found");
  }

  protected assertClaimOrOwner(workPackage: WorkPackage, principal: Principal, sessionId?: string): void {
    const currentSession = this.readText(workPackage, FIELD.claimedSession);
    if (currentSession && currentSession === sessionId) return;
    this.assertOwnerOrAdmin(workPackage, principal);
  }

  protected async updateWithConflict(id: number, payload: Record<string, unknown>): Promise<WorkPackage> {
    try {
      return await this.client.updateWorkPackage(id, payload);
    } catch (error) {
      if (error instanceof OpenProjectHttpError && error.status === 409) {
        throw new RequirementConflictError("OpenProject lockVersion conflict; reload before retrying");
      }
      throw error;
    }
  }

  async findByRequirementId(
    requirementId: string,
    projectIdentifier: string | undefined,
    principal: Principal
  ): Promise<WorkPackage | null> {
    const project = await this.visibleProject(projectIdentifier, principal);
    const key = this.field(FIELD.requirementId).key;
    const filters = JSON.stringify([
      { [key]: { operator: "=", values: [requirementId] } }
    ]);
    const result = await this.client.listProjectWorkPackages(project.id, {
      filters,
      pageSize: "2",
      offset: "1"
    });
    const matches = result._embedded.elements.filter(
      item => this.readText(item, FIELD.requirementId) === requirementId
    );
    if (matches.length > 1) {
      throw new RequirementConflictError(`Duplicate requirement ID: ${requirementId}`);
    }
    return matches[0] ?? null;
  }

  /**
   * The record behind a reference, for this caller.
   *
   * `principal` is required rather than optional on purpose: this is the one place every
   * lookup by id passes through, so it is where the caller's right to see the owning
   * project is settled. Made optional, a call site that forgot it would quietly skip the
   * check — a numeric id reaches any project, and per-record `canRead` alone would still
   * hand back a 公开 requirement out of a project this caller cannot see.
   */
  async resolve(
    reference: string | number,
    projectIdentifier: string | undefined,
    principal: Principal
  ): Promise<WorkPackage> {
    if (typeof reference === "number" || /^\d+$/.test(reference)) {
      const workPackage = await this.client.getWorkPackage(Number(reference));
      const projectLink = Array.isArray(workPackage._links.project) ? undefined : workPackage._links.project;
      if (projectLink?.href) {
        const actualProjectId = hrefId(projectLink.href);
        await this.visibleProject(actualProjectId, principal);
        if (projectIdentifier) {
          const expectedProject = await this.project(projectIdentifier);
          if (String(expectedProject.id) !== actualProjectId) {
            throw new RequirementValidationError(`Requirement not found: ${reference}`);
          }
        }
      }
      return workPackage;
    }
    const match = await this.findByRequirementId(reference, projectIdentifier, principal);
    if (!match) {
      throw new RequirementValidationError(`Requirement not found: ${reference}`);
    }
    return match;
  }
}
