import { describe, expect, it } from "vitest";

import { OpenProjectClient, OpenProjectHttpError, type OpenProjectApi } from "./openproject.js";
import {
  type CreateRequirementInput,
  RequirementConflictError,
  RequirementService,
  RequirementValidationError,
  searchSnippet
} from "./service.js";
import { signed } from "./signature.js";
import type {
  ActivityResource,
  Attachment,
  FieldMap,
  HalCollection,
  Principal,
  ProjectResource,
  Relation,
  UserResource,
  WorkPackage
} from "./types.js";

const option = (field: string, value: string) => `/api/v3/custom_options/${field}-${value}`;

const PROJECTS: ProjectResource[] = [
  { id: 1, identifier: "eva-project", name: "Eva-Project Requirements" },
  { id: 2, identifier: "mila-3", name: "Mila 3 Requirements" }
];

/** Reads one filter out of an API v3 filters parameter. */
const readFilter = (raw: string | undefined, key: string): { operator: string; values: string[] } | null => {
  if (!raw) return null;
  for (const filter of JSON.parse(raw) as Array<Record<string, { operator: string; values: string[] }>>) {
    const spec = filter[key];
    if (spec) return spec;
  }
  return null;
};


type FilterSpec = { operator: string; values: string[] };

const parseFilters = (raw?: string): Array<Record<string, FilterSpec>> =>
  raw ? (JSON.parse(raw) as Array<Record<string, FilterSpec>>) : [];

/** A list field arrives as a link, a text field as a plain property; absent is null. */
const fieldValue = (item: WorkPackage, key: string): string | null => {
  const link = item._links[key];
  if (link !== undefined) {
    const single = Array.isArray(link) ? link[0] : link;
    return single?.href?.split("/").at(-1) ?? null;
  }
  const raw = item[key];
  return raw === undefined || raw === null || raw === "" ? null : String(raw);
};

/**
 * OpenProject 17.8.0 filter semantics, measured rather than assumed. The one that matters:
 * `!` on a list custom field ALSO matches records carrying no value, which is what keeps
 * a requirement with no 可见性 inside its owner's stream.
 */
const filterMatches = (value: string | null, operator: string, values: string[]): boolean => {
  const listed = value !== null && values.includes(value);
  switch (operator) {
    case "=": return listed;
    case "!": return !listed;
    case "*": return value !== null;
    case "!*": return value === null;
    default: return true;
  }
};

/**
 * `~` as OpenProject 17.8.0 answers it: every white-space separated part of the value
 * somewhere in the field, whatever the case.
 */
const containsEvery = (text: string, value: string): boolean => {
  const haystack = text.toLowerCase();
  return value.trim().split(/\s+/).every(part => haystack.includes(part.toLowerCase()));
};

const sortableValue = (item: WorkPackage, field: string): string | number =>
  field === "id" ? item.id : String(item[field] ?? "");
const alice: Principal = { userId: "alice", displayName: "Alice", role: "user" };
const bob: Principal = { userId: "bob", displayName: "Bob", role: "user" };
const admin: Principal = { userId: "brian", displayName: "Brian", role: "admin" };

const fieldMap: FieldMap = {
  defaultProjectIdentifier: "eva-project",
  typeHref: "/api/v3/types/1",
  fields: {
    requirementId: { key: "cfId", kind: "text" },
    requesterType: { key: "cfRequesterType", kind: "list", options: { 人: option("requester", "human") } },
    requesterName: { key: "cfRequesterName", kind: "text" },
    requesterId: { key: "cfRequesterId", kind: "text" },
    recordedAt: { key: "cfRecordedAt", kind: "text" },
    sourceUpdatedAt: { key: "cfSourceUpdatedAt", kind: "text" },
    visibility: { key: "cfVisibility", kind: "list", options: { 公开: option("visibility", "public"), 私有: option("visibility", "private") } },
    ownerUserId: { key: "cfOwnerUserId", kind: "text" },
    modules: { key: "cfModules", kind: "list", multi: true, options: { Runtime: option("module", "runtime") } },
    responsibleAgent: { key: "cfResponsible", kind: "list", options: { Codex: option("responsible", "codex") } },
    claimedAgent: { key: "cfClaimedAgent", kind: "list", options: { Codex: option("claimed", "codex") } },
    claimedSession: { key: "cfClaimedSession", kind: "text" },
    claimLabel: { key: "cfClaimLabel", kind: "text" },
    claimedAt: { key: "cfClaimedAt", kind: "text" },
    claimScope: { key: "cfClaimScope", kind: "text" },
    intakeStatus: { key: "cfIntake", kind: "list", options: { 已受理: option("intake", "accepted") } },
    state: {
      key: "cfState",
      kind: "list",
      options: {
        待认领: option("state", "unclaimed"),
        进行中: option("state", "active"),
        已完成: option("state", "done")
      }
    },
    priority: { key: "cfPriority", kind: "text" },
    proposedAt: { key: "cfProposedAt", kind: "text" },
    proposedTimePrecision: { key: "cfPrecision", kind: "list", options: { date: option("precision", "date") } },
    sourceSessionId: { key: "cfSourceSession", kind: "text" },
    sourceMessageId: { key: "cfSourceMessage", kind: "text" },
    sourceLabel: { key: "cfSourceLabel", kind: "text" },
    requiredForParent: { key: "cfRequired", kind: "bool" },
    verificationStatus: {
      key: "cfVerification",
      kind: "list",
      options: {
        未验证: option("verification", "unverified"),
        已验证: option("verification", "verified")
      }
    },
    userAcceptance: {
      key: "cfAcceptance",
      kind: "list",
      options: {
        待确认: option("acceptance", "pending"),
        已验收: option("acceptance", "accepted"),
        不适用: option("acceptance", "na")
      }
    }
  },
  statusHrefs: {
    待认领: "/api/v3/statuses/1",
    进行中: "/api/v3/statuses/2",
    已完成: "/api/v3/statuses/3"
  },
  completionStates: ["已完成"]
};

// A field map from a deployment that knows about handoffs. `fieldMap` above stays
// handoff-unaware so the backward-compatible path keeps its own coverage.
const handoffAwareFieldMap: FieldMap = { ...fieldMap, handoffTypeHref: "/api/v3/types/9" };

function wp(overrides: Partial<WorkPackage> = {}): WorkPackage {
  return {
    id: 1,
    lockVersion: 3,
    subject: "Requirement",
    description: { format: "markdown", raw: "## 用户原文\n\n> text" },
    updatedAt: "2026-09-19T19:00:00+08:00",
    cfId: "MPR-REQ-001",
    cfClaimedSession: null,
    cfOwnerUserId: "alice",
    cfRequired: false,
    _links: {
      status: { href: "/api/v3/statuses/1", title: "New" },
      project: { href: "/api/v3/projects/1", title: "eva-project" },
      cfModules: [{ href: option("module", "runtime"), title: "Runtime" }],
      cfResponsible: { href: option("responsible", "codex"), title: "Codex" },
      cfClaimedAgent: { href: null },
      cfIntake: { href: option("intake", "accepted"), title: "已受理" },
      cfState: { href: option("state", "unclaimed"), title: "待认领" },
      cfRequesterType: { href: option("requester", "human"), title: "人" },
      cfVisibility: { href: option("visibility", "private"), title: "私有" }
    },
    ...overrides
  };
}

function collection<T>(elements: T[]): HalCollection<T> {
  return {
    total: elements.length,
    count: elements.length,
    pageSize: 200,
    offset: 1,
    _embedded: { elements }
  };
}

class FakeOpenProject implements OpenProjectApi {
  workPackages = new Map<number, WorkPackage>();
  children: WorkPackage[] = [];
  updateCalls: Array<{ id: number; payload: Record<string, unknown> }> = [];
  createCalls: Array<{ projectId: number; payload: Record<string, unknown> }> = [];
  listProjectIds: number[] = [];
  listParameters: Array<Record<string, string>> = [];
  /** The ids each list call handed back, in the same order as listParameters. */
  listReturned: number[][] = [];
  updateError: Error | null = null;
  createProjectCalls: Array<{ identifier: string; name: string }> = [];
  createdProjects: ProjectResource[] = [];
  relations: Relation[] = [];
  scopeByProject = false;

  constructor(initial: WorkPackage[]) {
    for (const item of initial) this.workPackages.set(item.id, item);
  }

  async getProject(identifier: string | number): Promise<ProjectResource> {
    const value = String(identifier);
    if (value === "eva-project" || value === "1") {
      return { id: 1, identifier: "eva-project", name: "Eva-Project Requirements" };
    }
    if (value === "mila-3" || value === "2") {
      return { id: 2, identifier: "mila-3", name: "Mila 3 Requirements" };
    }
    if (value === "archived-pool" || value === "3") {
      return { id: 3, identifier: "archived-pool", name: "Archived Pool", active: false };
    }
    const created = this.createdProjects.find(project => project.identifier === value || String(project.id) === value);
    if (created) return created;
    throw new OpenProjectHttpError(404, "not found", {});
  }

  /** login -> OpenProject user id. Every identity the tests use resolves by default. */
  users = new Map<string, number>([["alice", 11], ["bob", 12], ["brian", 13]]);
  /** user id -> projects they may see. Left null, everyone sees everything. */
  visibleProjects: Map<number, number[]> | null = null;

  async listUsers(parameters: Record<string, string>): Promise<HalCollection<UserResource>> {
    const login = readFilter(parameters.filters, "login")?.values[0];
    const id = login === undefined ? undefined : this.users.get(login);
    return collection(id === undefined || login === undefined ? [] : [{ id, login }]);
  }

  async listProjects(parameters: Record<string, string> = {}): Promise<HalCollection<ProjectResource>> {
    let projects: ProjectResource[] = [...PROJECTS, ...this.createdProjects];
    const visible = readFilter(parameters.filters, "visible")?.values[0];
    if (visible !== undefined && this.visibleProjects) {
      const allowed = this.visibleProjects.get(Number(visible)) ?? [];
      projects = projects.filter(project => allowed.includes(project.id));
    }
    const wanted = readFilter(parameters.filters, "id")?.values;
    if (wanted) projects = projects.filter(project => wanted.includes(String(project.id)));
    return collection(projects);
  }

  projectTypes: Array<{ id: number; name: string }> | null = null;

  async listProjectTypes() {
    if (this.projectTypes) return collection(this.projectTypes);
    return collection([
      { id: 1, name: "Task" },
      { id: 4, name: "Feature" },
      { id: 7, name: "Bug" },
      { id: 9, name: "交接" }
    ]);
  }

  async createProject(identifier: string, name: string): Promise<ProjectResource> {
    this.createProjectCalls.push({ identifier, name });
    const project = { id: 10, identifier, name, active: true, public: false };
    this.createdProjects.push(project);
    return project;
  }

  async listProjectRoles() { return collection([{ id: 4, name: "Member" }]); }
  private membership = { id: 1, _links: { project: { href: "" }, principal: { href: "" }, roles: [{ href: "" }] } };
  async createProjectMembership(projectId: number, userId: number, roleId: number) {
    this.membership = { id: 1, _links: { project: { href: `/api/v3/projects/${projectId}` },
      principal: { href: `/api/v3/users/${userId}` }, roles: [{ href: `/api/v3/roles/${roleId}` }] } };
    return this.membership;
  }
  async getMembership() { return this.membership; }

  async getWorkPackage(id: number): Promise<WorkPackage> {
    const item = this.workPackages.get(id);
    if (!item) throw new Error("not found");
    return item;
  }

  async listProjectWorkPackages(
    projectId: number,
    parameters: Record<string, string>
  ): Promise<HalCollection<WorkPackage>> {
    this.listProjectIds.push(projectId);
    this.listParameters.push(parameters);
    let source = [...this.workPackages.values()];
    // Off unless asked for: most tests keep every record in one project and list whichever.
    if (this.scopeByProject) {
      source = source.filter(item => {
        const link = item._links.project;
        return !Array.isArray(link) && link?.href === `/api/v3/projects/${projectId}`;
      });
    }
    // An `id` filter naming anything that is not a work package of the project is refused
    // whole, as OpenProject does (「Id过滤器有无效值」, measured on 17.8.0).
    const idFilter = parseFilters(parameters.filters).filter(filter => filter.id).at(-1)?.id;
    if (idFilter?.operator === "=" && idFilter.values.some(value => !source.some(item => String(item.id) === value))) {
      throw new OpenProjectHttpError(400, "Id过滤器有无效值。", {});
    }
    return this.answer(source, parameters);
  }

  /** Every call to the list across projects, in order. */
  globalListParameters: Array<Record<string, string>> = [];

  async listWorkPackages(parameters: Record<string, string>): Promise<HalCollection<WorkPackage>> {
    this.globalListParameters.push(parameters);
    return this.answer([...this.workPackages.values()], parameters);
  }

  /** Comments a record carries, as the `comment` filter reads them. */
  private commentText(item: WorkPackage): string {
    return this.comments.filter(comment => comment.workPackageId === item.id).map(comment => comment.text).join("\n");
  }

  private textOf(item: WorkPackage, key: string): string {
    if (key === "description") return item.description?.raw ?? "";
    if (key === "comment") return this.commentText(item);
    return fieldValue(item, key) ?? "";
  }

  private answer(records: WorkPackage[], parameters: Record<string, string>): HalCollection<WorkPackage> {
    let source = records;
    // OpenProject keeps one filter per name: a later one replaces an earlier one instead
    // of ANDing with it (measured on 17.8.0).
    const effective = new Map<string, FilterSpec>();
    for (const filter of parseFilters(parameters.filters)) {
      for (const [key, spec] of Object.entries(filter)) effective.set(key, spec);
    }
    for (const [key, spec] of effective) {
      // With `children` set, a parent query answers from that list instead (below).
      if (key === "parent" && this.children.length) continue;
      source = source.filter(item => spec.operator === "~"
        ? containsEvery(this.textOf(item, key), spec.values[0] ?? "")
        : filterMatches(fieldValue(item, key), spec.operator, spec.values));
    }

    if (this.children.length && parameters.filters?.includes("parent")) {
      const configuredParents = this.children.some(child => {
        const parent = child._links.parent;
        return !Array.isArray(parent) && Boolean(parent?.href);
      });
      if (configuredParents) {
        const filters = JSON.parse(parameters.filters) as Array<{ parent?: { values?: string[] } }>;
        const parentId = filters[0]?.parent?.values?.[0];
        source = this.children.filter(child => {
          const parent = child._links.parent;
          return !Array.isArray(parent) && parent?.href?.endsWith(`/${parentId}`);
        });
      } else {
        source = this.children;
      }
    }

    if (parameters.sortBy) {
      const keys = JSON.parse(parameters.sortBy) as Array<[string, string]>;
      source = [...source].sort((a, b) => {
        for (const [field, direction] of keys) {
          const left = sortableValue(a, field);
          const right = sortableValue(b, field);
          if (left < right) return direction === "asc" ? -1 : 1;
          if (left > right) return direction === "asc" ? 1 : -1;
        }
        return 0;
      });
    }

    const pageSize = Number(parameters.pageSize ?? 200);
    const offset = Number(parameters.offset ?? 1);
    const start = (offset - 1) * pageSize;
    this.listReturned.push(source.slice(start, start + pageSize).map(item => item.id));
    return {
      ...collection(source.slice(start, start + pageSize)),
      total: source.length,
      pageSize,
      offset
    };
  }

  async createWorkPackage(projectId: number, payload: Record<string, unknown>): Promise<WorkPackage> {
    this.createCalls.push({ projectId, payload });
    const created = wp({
      id: this.workPackages.size + 1,
      ...payload,
      _links: { ...wp()._links, ...((payload._links ?? {}) as WorkPackage["_links"]) }
    });
    this.workPackages.set(created.id, created);
    return created;
  }

  async updateWorkPackage(id: number, payload: Record<string, unknown>): Promise<WorkPackage> {
    this.calls.push("update");
    this.updateCalls.push({ id, payload });
    if (this.updateError) throw this.updateError;
    const current = await this.getWorkPackage(id);
    const links = { ...current._links, ...((payload._links ?? {}) as Record<string, never>) };
    const stateLink = links.cfState;
    if (!Array.isArray(stateLink) && stateLink?.href === option("state", "done")) {
      links.cfState = { ...stateLink, title: "已完成" };
    }
    const updated = { ...current, ...payload, _links: links, lockVersion: current.lockVersion + 1 } as WorkPackage;
    this.workPackages.set(id, updated);
    return updated;
  }

  async listRelations(_workPackageId: number): Promise<HalCollection<Relation>> {
    return collection(this.relations);
  }

  async createRelation(): Promise<Relation> {
    throw new Error("not used");
  }

  async listAttachments(): Promise<Attachment[]> {
    return [];
  }

  async uploadMarkdown(): Promise<Attachment> {
    throw new Error("not used");
  }

  uploadedFiles: { fileName: string; content: Uint8Array; contentType: string }[] = [];

  async uploadAttachment(_id: number, fileName: string, content: Uint8Array, contentType: string): Promise<Attachment> {
    this.uploadedFiles.push({ fileName, content, contentType });
    return { id: 10, fileName, contentType, fileSize: content.length, _links: {} };
  }

  async readAttachment(): Promise<string> {
    throw new Error("not used");
  }

  activities: ActivityResource[] = [];
  comments: Array<{ workPackageId: number; text: string }> = [];
  /** Order matters between these two; see journalNote. */
  calls: string[] = [];

  async listActivities(_workPackageId: number): Promise<HalCollection<ActivityResource>> {
    return collection(this.activities);
  }

  async createActivity(workPackageId: number, comment: string): Promise<ActivityResource> {
    this.calls.push("comment");
    this.comments.push({ workPackageId, text: comment });
    const activity: ActivityResource = { id: 1000 + this.comments.length, comment: { raw: comment } };
    this.activities.push(activity);
    return activity;
  }

  async getUser(id: number): Promise<UserResource> {
    const login = [...this.users].find(([, userId]) => userId === id)?.[0];
    if (login === undefined) throw new Error(`no user ${id}`);
    return { id, login, name: login[0]!.toUpperCase() + login.slice(1), status: "active" };
  }
}

function requirementInput(overrides: Partial<CreateRequirementInput> = {}): CreateRequirementInput {
  return {
    project: "eva-project",
    id: "MPR-REQ-NEW",
    title: "Requirement",
    rawText: "Original request",
    agentUnderstanding: "Agent understanding",
    scope: "Initial scope",
    acceptanceCriteria: "Initial acceptance",
    modules: ["Runtime"],
    responsibleAgent: "Codex",
    intakeStatus: "已受理",
    state: "待认领",
    priority: "Normal",
    requesterType: "人",
    visibility: "私有",
    proposedTimePrecision: "date",
    sourceLabel: "test",
    requestId: "request-1",
    ...overrides
  };
}

describe("project binding", () => {
  it("returns an existing caller-supplied project without creating another", async () => {
    const client = new FakeOpenProject([]);
    const service = new RequirementService(client, fieldMap);

    const result = await service.createProject({ project: "mila-3", name: "Ignored" }, alice);

    expect(result).toEqual({
      created: false,
      project: { id: 2, identifier: "mila-3", name: "Mila 3 Requirements" },
    types: [
      { id: 1, name: "Task" },
      { id: 4, name: "Feature" },
      { id: 7, name: "Bug" },
      { id: 9, name: "交接" }
    ]
    });
    expect(client.createProjectCalls).toHaveLength(0);
  });

  it("creates a missing project using the supplied identifier and display name", async () => {
    const client = new FakeOpenProject([]);
    const service = new RequirementService(client, fieldMap);

    const result = await service.createProject({ project: "project-one", name: "Project One" }, alice);

    expect(result).toEqual({
      created: true,
      project: { id: 10, identifier: "project-one", name: "Project One" },
    types: [
      { id: 1, name: "Task" },
      { id: 4, name: "Feature" },
      { id: 7, name: "Bug" },
      { id: 9, name: "交接" }
    ]
    });
    expect(client.createProjectCalls).toEqual([{ identifier: "project-one", name: "Project One" }]);
  });

  it("rejects identifiers that would be unstable or ambiguous", async () => {
    const service = new RequirementService(new FakeOpenProject([]), fieldMap);

    await expect(service.createProject({ project: "Project One" }, alice)).rejects.toThrow(/project must start/);
  });

  // A project whose types never arrived used to be handed back as if it were fine.
  // The cost landed somewhere else entirely -- a Bug that could not be filed, a list
  // request answering 400 -- with nothing at that point pointing back to here.
  const poolFieldMap: FieldMap = {
    ...handoffAwareFieldMap,
    requirementTypeHrefs: ["/api/v3/types/1", "/api/v3/types/4", "/api/v3/types/7"]
  };

  it("refuses a new project that cannot hold every type the pool files under", async () => {
    const client = new FakeOpenProject([]);
    client.projectTypes = [{ id: 1, name: "Task" }, { id: 9, name: "交接" }];
    const service = new RequirementService(client, poolFieldMap);

    await expect(service.createProject({ project: "project-one" }, alice))
      .rejects.toThrow(/missing type 4, 7.*requirements cannot be filed/s);
  });

  it("refuses a project with no type a handoff could be written as", async () => {
    const client = new FakeOpenProject([]);
    client.projectTypes = [{ id: 1, name: "Task" }, { id: 4, name: "Feature" }, { id: 7, name: "Bug" }];
    const service = new RequirementService(client, poolFieldMap);

    await expect(service.createProject({ project: "project-one" }, alice))
      .rejects.toThrow(/missing type 9.*handoffs cannot be written/s);
  });

  it("says where the types come from, because they cannot be set through this API", async () => {
    const client = new FakeOpenProject([]);
    client.projectTypes = [{ id: 1, name: "Task" }];
    const service = new RequirementService(client, poolFieldMap);

    await expect(service.createProject({ project: "project-one" }, alice))
      .rejects.toThrow(/Type#is_default.*openproject_bootstrap\.rb/s);
  });

  it("checks a project that already existed, instead of trusting it because it is there", async () => {
    const client = new FakeOpenProject([]);
    client.projectTypes = [{ id: 1, name: "Task" }];
    const service = new RequirementService(client, poolFieldMap);

    await expect(service.createProject({ project: "mila-3" }, alice)).rejects.toThrow(/missing type/);
    expect(client.createProjectCalls).toHaveLength(0);
  });
});

describe("projects offered as pools", () => {
  // Leaving `filters` off does not mean "no filtering" here either: OpenProject then
  // hands back archived projects too. An archived one answers 403 for its types, so it
  // is offered in the picker and only admits it is unusable once someone has clicked it.
  it("asks for active projects only, for an admin as much as for anyone else", async () => {
    const client = new FakeOpenProject([]);
    const asked: Array<Record<string, string>> = [];
    const original = client.listProjects.bind(client);
    client.listProjects = async (parameters = {}) => { asked.push(parameters); return original(parameters); };
    const service = new RequirementService(client, fieldMap);

    await service.listProjects(admin);
    await service.listProjects(alice);

    expect(asked).toHaveLength(2);
    for (const parameters of asked) {
      expect(readFilter(parameters.filters, "active")).toEqual({ operator: "=", values: ["t"] });
    }
  });

  it("still narrows to what a non-admin may see", async () => {
    const client = new FakeOpenProject([]);
    const asked: Array<Record<string, string>> = [];
    const original = client.listProjects.bind(client);
    client.listProjects = async (parameters = {}) => { asked.push(parameters); return original(parameters); };
    const service = new RequirementService(client, fieldMap);

    await service.listProjects(alice);

    expect(readFilter(asked[0]?.filters, "visible")).toEqual({ operator: "=", values: ["11"] });
  });

  // The status code and the URL read like a permission problem. The plain fact is that
  // the project was put away.
  it("says an archived project is archived rather than letting the 403 speak for it", async () => {
    const service = new RequirementService(new FakeOpenProject([]), fieldMap);

    await expect(service.types("archived-pool", admin)).rejects.toThrow(/archived/);
  });
});

describe("claiming", () => {
  it("returns the existing result for a duplicate claim from the same session", async () => {
    const client = new FakeOpenProject([wp({ cfClaimedSession: "session-a" })]);
    const service = new RequirementService(client, fieldMap);

    const result = await service.claim({
      reference: 1,
      agent: "Codex",
      sessionId: "session-a",
      label: "same",
      scope: "same",
      claimedAt: "2026-09-19T19:00:00+08:00"
    }, alice);

    expect(result.replayed).toBe(true);
    expect(client.updateCalls).toHaveLength(0);
  });

  it("rejects a claim held by another session", async () => {
    const client = new FakeOpenProject([wp({ cfClaimedSession: "session-b" })]);
    const service = new RequirementService(client, fieldMap);

    await expect(service.claim({
      reference: 1,
      agent: "Codex",
      sessionId: "session-a",
      label: "attempt",
      scope: "attempt",
      claimedAt: "2026-09-19T19:00:00+08:00"
    }, alice)).rejects.toThrow(RequirementConflictError);
    expect(client.updateCalls).toHaveLength(0);
  });

  it("surfaces an OpenProject lock conflict without retrying", async () => {
    const client = new FakeOpenProject([wp()]);
    client.updateError = new OpenProjectHttpError(409, "conflict", {});
    const service = new RequirementService(client, fieldMap);

    await expect(service.claim({
      reference: 1,
      agent: "Codex",
      sessionId: "session-a",
      label: "claim",
      scope: "scope",
      claimedAt: "2026-09-19T19:00:00+08:00"
    }, alice)).rejects.toThrow(/lockVersion conflict/);
    expect(client.updateCalls).toHaveLength(1);
  });
});

describe("requirement types", () => {
  it("discovers enabled types and creates a Bug with its classification", async () => {
    const client = new FakeOpenProject([]);
    const service = new RequirementService(client, handoffAwareFieldMap);
    expect((await service.types("eva-project", alice)).types.map(type => type.name)).toEqual(["Task", "Feature", "Bug"]);
    const result = await service.create(requirementInput({ typeId: 7 }), alice);
    expect(result.item.typeId).toBe(7);
    expect(client.createCalls[0]!.payload._links).toMatchObject({ type: { href: "/api/v3/types/7" } });
  });

  it("allows a type-only cross-session update with version checks and preserved user text", async () => {
    const client = new FakeOpenProject([wp({ cfClaimedSession: "previous-session" })]);
    const service = new RequirementService(client, fieldMap);
    const input = { project: "eva-project", reference: 1, typeId: 4, sessionId: "new-session", note: "Classify as feature", changedAt: "2026-09-20T04:00:00+08:00", expectedLockVersion: 3 };
    const result = await service.updateContent(input, alice);
    expect(result.typeId).toBe(4);
    expect((await client.getWorkPackage(1)).description?.raw).toContain("> text");
    await expect(service.updateContent(input, alice)).rejects.toThrow(/Stale lockVersion/);
    expect(client.updateCalls).toHaveLength(1);
  });

  it("rejects disabled types without writes and keeps the old default for legacy callers", async () => {
    const client = new FakeOpenProject([]);
    const service = new RequirementService(client, fieldMap);
    await expect(service.create(requirementInput({ typeId: 999 }), alice)).rejects.toThrow(/not enabled/);
    expect(client.createCalls).toHaveLength(0);
    expect((await service.create(requirementInput(), alice)).item.typeId).toBe(1);
  });
});

describe("attachment upload", () => {
  it.each(["screenshot.png", "document.pdf", "report.xlsx", "archive.zip", "file.custom"])("preserves binary bytes for %s", async (fileName) => {
    const client = new FakeOpenProject([wp()]);
    const service = new RequirementService(client, fieldMap);
    const bytes = Buffer.from([0, 255, 128, 1, 13, 10]);
    const result = await service.uploadAttachment({ project: "eva-project", reference: 1, fileName, content: bytes.toString("base64"), encoding: "base64" }, alice);
    expect(result.fileSize).toBe(bytes.length);
    expect(client.uploadedFiles[0]!.content).toEqual(bytes);
  });

  it("preserves UTF-8 text and MIME type", async () => {
    const client = new FakeOpenProject([wp()]);
    const service = new RequirementService(client, fieldMap);
    await service.uploadAttachment({ project: "eva-project", reference: 1, fileName: "说明.txt", content: "需求说明", encoding: "utf8", contentType: "text/plain" }, alice);
    expect(client.uploadedFiles[0]).toMatchObject({ content: Buffer.from("需求说明"), contentType: "text/plain" });
  });

  it("rejects malformed, oversized and unauthorized uploads before sending files", async () => {
    const client = new FakeOpenProject([wp()]);
    const service = new RequirementService(client, fieldMap);
    const input = { project: "eva-project", reference: 1, fileName: "image.png", content: "AA==", encoding: "base64" as const };
    await expect(service.uploadAttachment({ ...input, content: "invalid!" }, alice)).rejects.toThrow(/base64/);
    await expect(service.uploadAttachment({ ...input, content: Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64") }, alice)).rejects.toThrow(/20 MiB/);
    await expect(service.uploadAttachment({ ...input, fileName: "../image.png" }, alice)).rejects.toThrow(/file name/);
    await expect(service.uploadAttachment(input, bob)).rejects.toThrow(/not found/);
    expect(client.uploadedFiles).toHaveLength(0);
  });

  it("sends binary files without changing their bytes or MIME type", async () => {
    const bytes = new Uint8Array([0, 255, 128, 137, 80, 78, 71]);
    const fetchFn: typeof fetch = async (_input, init) => {
      const file = (init!.body as FormData).get("file") as File;
      expect(file.name).toBe("image.png");
      expect(file.type).toBe("image/png");
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
      return new Response(JSON.stringify({ id: 1, fileName: file.name, _links: {} }), { status: 200 });
    };
    await new OpenProjectClient("http://openproject.local", "token", fetchFn).uploadAttachment(1, "image.png", bytes, "image/png");
  });

  it("sends metadata as a string field instead of a file part", async () => {
    let received: FormData | null = null;
    const fetchFn: typeof fetch = async (_input, init) => {
      received = init?.body as FormData;
      return new Response(JSON.stringify({
        id: 1,
        fileName: "requirement.md",
        _links: {}
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new OpenProjectClient("http://openproject.local", "token", fetchFn);

    await client.uploadMarkdown(1, "requirement.md", "# Requirement", "source");

    expect(received).toBeInstanceOf(FormData);
    expect(received?.get("metadata")).toBe(JSON.stringify({ fileName: "requirement.md", description: "source" }));
    expect(received?.get("file")).toBeInstanceOf(Blob);
  });
});

describe("project and requester scoping", () => {
  it("queries only the explicitly selected project", async () => {
    const client = new FakeOpenProject([wp()]);
    const service = new RequirementService(client, fieldMap);

    await service.list({ project: "mila-3" }, alice);

    // One request per visibility stream, every one of them against the chosen project.
    expect(new Set(client.listProjectIds)).toEqual(new Set([2]));
  });

  it("returns project and requester separately from source session", async () => {
    const client = new FakeOpenProject([wp({
      cfRequesterName: "Brian",
      cfRequesterId: "brian",
      cfSourceSession: "session-source"
    })]);
    const service = new RequirementService(client, fieldMap);

    const detail = await service.get("MPR-REQ-001", "eva-project", alice);

    expect(detail.summary).toMatchObject({
      project: "eva-project",
      requesterType: "人",
      requesterName: "Brian",
      requesterId: "brian"
    });
    expect(detail.sourceSessionId).toBe("session-source");
  });

  it("hands back the intake, verification and acceptance the record carries", async () => {
    const client = new FakeOpenProject([wp({
      _links: {
        ...wp()._links,
        cfVerification: { href: option("verification", "verified"), title: "已验证" },
        cfAcceptance: { href: option("acceptance", "accepted"), title: "已验收" }
      }
    })]);
    const service = new RequirementService(client, fieldMap);

    const detail = await service.get("MPR-REQ-001", "eva-project", alice);

    // All three are written on create or on completion, and the detail left every one of
    // them out, so the page had nothing to show no matter how it asked.
    expect(detail).toMatchObject({
      intakeStatus: "已受理",
      verificationStatus: "已验证",
      userAcceptance: "已验收"
    });
  });

  it("reports an unset verification or acceptance as null rather than dropping the key", async () => {
    const service = new RequirementService(new FakeOpenProject([wp()]), fieldMap);

    const detail = await service.get("MPR-REQ-001", "eva-project", alice);

    expect(detail.verificationStatus).toBeNull();
    expect(detail.userAcceptance).toBeNull();
  });

  it("rejects an unknown project instead of searching another project", async () => {
    const service = new RequirementService(new FakeOpenProject([wp()]), fieldMap);
    await expect(service.get("MPR-REQ-001", "missing-project", alice))
      .rejects.toThrow(/Project not found/);
  });
});

describe("per-requirement visibility", () => {
  const publicRequirement = wp({
    id: 2,
    cfId: "MPR-REQ-002",
    subject: "Public requirement",
    _links: {
      ...wp()._links,
      cfVisibility: { href: option("visibility", "public"), title: "公开" }
    }
  });

  it("lets another user list only public requirements in the same project", async () => {
    const service = new RequirementService(new FakeOpenProject([wp(), publicRequirement]), fieldMap);

    const result = await service.list({ project: "eva-project" }, bob);

    expect(result.total).toBe(1);
    expect(result.items.map(item => item.id)).toEqual(["MPR-REQ-002"]);
  });

  it("lets the owner see both public and private requirements", async () => {
    const service = new RequirementService(new FakeOpenProject([wp(), publicRequirement]), fieldMap);

    const result = await service.list({ project: "eva-project" }, alice);

    expect(result.total).toBe(2);
  });

  it("hides a private requirement from direct lookup by another user", async () => {
    const service = new RequirementService(new FakeOpenProject([wp()]), fieldMap);

    await expect(service.get("MPR-REQ-001", "eva-project", bob))
      .rejects.toThrow("Requirement not found");
  });

  it("allows an administrator to read a private requirement", async () => {
    const service = new RequirementService(new FakeOpenProject([wp()]), fieldMap);

    const detail = await service.get("MPR-REQ-001", "eva-project", admin);

    expect(detail.summary).toMatchObject({ id: "MPR-REQ-001", visibility: "私有" });
  });

  it("binds a new requirement to the authenticated user", async () => {
    const client = new FakeOpenProject([]);
    const service = new RequirementService(client, fieldMap);

    await service.create({
      project: "eva-project",
      id: "MPR-REQ-NEW",
      title: "Public request",
      rawText: "request",
      agentUnderstanding: "understanding",
      modules: ["Runtime"],
      responsibleAgent: "Codex",
      intakeStatus: "已受理",
      state: "待认领",
      priority: "normal",
      requesterType: "人",
      visibility: "公开",
      proposedTimePrecision: "date",
      sourceLabel: "test",
      requestId: "request-1",
      verificationStatus: "已验证",
      userAcceptance: "不适用"
    }, alice);

    expect(client.createCalls[0]?.payload).toMatchObject({
      cfOwnerUserId: "alice",
      cfRequesterId: "alice",
      cfRequesterName: "Alice"
    });
    expect(client.createCalls[0]?.payload._links).toMatchObject({
      cfVisibility: { href: option("visibility", "public") }
    });
  });

  it("rejects requester identity spoofing by a normal user", async () => {
    const service = new RequirementService(new FakeOpenProject([]), fieldMap);

    await expect(service.create({
      project: "eva-project",
      id: "MPR-REQ-SPOOF",
      title: "Spoof",
      rawText: "request",
      agentUnderstanding: "understanding",
      modules: ["Runtime"],
      responsibleAgent: "Codex",
      intakeStatus: "已受理",
      state: "待认领",
      priority: "normal",
      requesterType: "人",
      requesterId: "bob",
      visibility: "私有",
      proposedTimePrecision: "date",
      sourceLabel: "test",
      requestId: "request-2"
    }, alice)).rejects.toThrow(/authenticated user/);
  });
});

describe("parent hierarchy", () => {
  it("binds a child to a parent in the selected project", async () => {
    const parent = wp({ id: 1, cfId: "MPR-REQ-PARENT" });
    const child = wp({ id: 2, cfId: "MPR-REQ-CHILD" });
    const client = new FakeOpenProject([parent, child]);
    const service = new RequirementService(client, fieldMap);

    await service.setParent({
      project: "eva-project",
      child: 2,
      parent: 1,
      requiredForParent: true
    }, alice);

    expect(client.updateCalls[0]?.payload).toMatchObject({
      _links: { parent: { href: "/api/v3/work_packages/1" } },
      cfRequired: true
    });
  });

  it("clears an existing parent", async () => {
    const child = wp({
      id: 2,
      cfId: "MPR-REQ-CHILD",
      cfRequired: true,
      _links: {
        ...wp()._links,
        parent: { href: "/api/v3/work_packages/1", title: "MPR-REQ-PARENT" }
      }
    });
    const client = new FakeOpenProject([child]);
    const service = new RequirementService(client, fieldMap);

    await service.setParent({
      project: "eva-project",
      child: 2,
      parent: null,
      requiredForParent: false
    }, alice);

    expect(client.updateCalls[0]?.payload).toMatchObject({
      _links: { parent: { href: null } },
      cfRequired: false
    });
  });

  it("requires ownership of both child and parent", async () => {
    const child = wp({ id: 1, cfId: "MPR-REQ-CHILD" });
    const parent = wp({ id: 2, cfId: "MPR-REQ-PARENT", cfOwnerUserId: "bob" });
    const client = new FakeOpenProject([child, parent]);
    const service = new RequirementService(client, fieldMap);

    await expect(service.setParent({
      project: "eva-project",
      child: 1,
      parent: 2,
      requiredForParent: true
    }, alice)).rejects.toThrow("Requirement not found");
    expect(client.updateCalls).toHaveLength(0);
  });

  it("rejects a parent from another project", async () => {
    const child = wp({ id: 1, cfId: "MPR-REQ-CHILD" });
    const otherProjectParent = wp({
      id: 2,
      cfId: "MILA-REQ-PARENT",
      _links: {
        ...wp()._links,
        project: { href: "/api/v3/projects/2", title: "mila-3" }
      }
    });
    const client = new FakeOpenProject([child, otherProjectParent]);
    const service = new RequirementService(client, fieldMap);

    await expect(service.setParent({
      project: "eva-project",
      child: 1,
      parent: 2,
      requiredForParent: true
    }, alice)).rejects.toThrow("Requirement not found: 2");
    expect(client.updateCalls).toHaveLength(0);
  });

  it("rejects a hierarchy cycle", async () => {
    const child = wp({ id: 1, cfId: "MPR-REQ-A" });
    const parent = wp({
      id: 2,
      cfId: "MPR-REQ-B",
      _links: {
        ...wp()._links,
        parent: { href: "/api/v3/work_packages/1", title: "MPR-REQ-A" }
      }
    });
    const client = new FakeOpenProject([child, parent]);
    const service = new RequirementService(client, fieldMap);

    await expect(service.setParent({
      project: "eva-project",
      child: 1,
      parent: 2,
      requiredForParent: true
    }, alice)).rejects.toThrow(/create a cycle/);
    expect(client.updateCalls).toHaveLength(0);
  });

  it("returns only visible direct children from the parent detail", async () => {
    const parent = wp({
      id: 1,
      cfId: "MPR-REQ-PARENT",
      _links: {
        ...wp()._links,
        cfVisibility: { href: option("visibility", "public"), title: "公开" }
      }
    });
    const client = new FakeOpenProject([parent]);
    client.children = [
      wp({
        id: 2,
        cfId: "MPR-REQ-PUBLIC-CHILD",
        _links: {
          ...wp()._links,
          cfVisibility: { href: option("visibility", "public"), title: "公开" }
        }
      }),
      wp({ id: 3, cfId: "MPR-REQ-PRIVATE-CHILD" })
    ];
    const service = new RequirementService(client, fieldMap);

    const detail = await service.get(1, "eva-project", bob);

    expect(detail.children).toEqual([
      expect.objectContaining({ id: "MPR-REQ-PUBLIC-CHILD", workPackageId: 2 })
    ]);
  });
});

describe("requirement content and tree", () => {
  it("updates editable content without replacing the original user text", async () => {
    const original = wp({
      description: {
        format: "markdown",
        raw: [
          "## 用户原文",
          "",
          "> Keep this exact request",
          "",
          "## Agent 理解",
          "",
          "Old understanding",
          "",
          "## 变更记录",
          "",
          "- Created"
        ].join("\n")
      }
    });
    const client = new FakeOpenProject([original]);
    const service = new RequirementService(client, fieldMap);

    const result = await service.updateContent({
      project: "eva-project",
      reference: 1,
      title: "Updated title",
      agentUnderstanding: "Updated understanding",
      scope: "Runtime only",
      acceptanceCriteria: "All checks pass",
      note: "Clarified by requester",
      changedAt: "2026-09-19T20:00:00+08:00"
    }, alice);

    expect(result.title).toBe("Updated title");
    const description = String((client.updateCalls[0]?.payload.description as { raw?: string }).raw);
    expect(description).toContain("> Keep this exact request");
    expect(description).toContain("## 范围\n\nRuntime only");
    expect(description).toContain("## 验收条件\n\nAll checks pass");
    // The reason is journalled rather than appended, so the body does not grow by a line
    // every time somebody edits a section.
    expect(description).not.toContain("Clarified by requester");
    expect(client.comments).toEqual([
      { workPackageId: 1, text: "- 2026-09-19T20:00:00+08:00：更新需求正文。Clarified by requester" }
    ]);
  });

  it("returns a bounded nested tree with claim information", async () => {
    const parent = wp({ id: 1, cfId: "MPR-REQ-PARENT" });
    const child = wp({
      id: 2,
      cfId: "MPR-REQ-CHILD",
      cfClaimedSession: "session-child",
      _links: {
        ...wp()._links,
        parent: { href: "/api/v3/work_packages/1", title: "MPR-REQ-PARENT" }
      }
    });
    const grandchild = wp({
      id: 3,
      cfId: "MPR-REQ-GRANDCHILD",
      _links: {
        ...wp()._links,
        parent: { href: "/api/v3/work_packages/2", title: "MPR-REQ-CHILD" }
      }
    });
    const client = new FakeOpenProject([parent, child, grandchild]);
    client.children = [child, grandchild];
    const service = new RequirementService(client, fieldMap);

    const tree = await service.tree({ project: "eva-project", reference: 1, depth: 2 }, alice);
    const root = tree.root as Record<string, unknown>;
    const children = root.children as Array<Record<string, unknown>>;
    const grandchildren = children[0]?.children as Array<Record<string, unknown>>;

    expect(root.id).toBe("MPR-REQ-PARENT");
    expect(children[0]).toMatchObject({ id: "MPR-REQ-CHILD", claim: { session: "session-child" } });
    expect(grandchildren[0]).toMatchObject({ id: "MPR-REQ-GRANDCHILD" });
  });

  it("creates and binds multiple children beneath an existing parent", async () => {
    const parent = wp({ id: 1, cfId: "MPR-REQ-PARENT" });
    const client = new FakeOpenProject([parent]);
    const service = new RequirementService(client, fieldMap);
    const first = requirementInput({ id: "MPR-REQ-CHILD-1", requestId: "batch-1" });
    const second = requirementInput({ id: "MPR-REQ-CHILD-2", requestId: "batch-2" });
    const { project: _firstProject, requiredForParent: _firstRequired, ...firstFields } = first;
    const { project: _secondProject, requiredForParent: _secondRequired, ...secondFields } = second;

    const result = await service.createChildren({
      project: "eva-project",
      parent: 1,
      children: [
        { ...firstFields, requiredForParent: true },
        { ...secondFields, requiredForParent: false }
      ]
    }, alice);

    expect(result.results).toEqual([
      expect.objectContaining({ id: "MPR-REQ-CHILD-1", ok: true, created: true }),
      expect.objectContaining({ id: "MPR-REQ-CHILD-2", ok: true, created: true })
    ]);
    expect(client.updateCalls).toHaveLength(2);
    expect(client.updateCalls.map(call => call.payload._links)).toEqual([
      { parent: { href: "/api/v3/work_packages/1" } },
      { parent: { href: "/api/v3/work_packages/1" } }
    ]);
  });

  it("returns compact dependencies and completion blockers in detail", async () => {
    const parent = wp({ id: 1, cfId: "MPR-REQ-PARENT" });
    const blocker = wp({
      id: 2,
      cfId: "MPR-REQ-BLOCKER",
      _links: {
        ...wp()._links,
        cfVisibility: { href: option("visibility", "public"), title: "公开" }
      }
    });
    const client = new FakeOpenProject([parent, blocker]);
    client.relations = [{
      id: 9,
      type: "blocks",
      _links: {
        from: { href: "/api/v3/work_packages/2" },
        to: { href: "/api/v3/work_packages/1" }
      }
    }];
    const service = new RequirementService(client, fieldMap);

    const detail = await service.get(1, "eva-project", alice);

    expect(detail.dependencies).toMatchObject({
      blockedBy: [expect.objectContaining({ id: "MPR-REQ-BLOCKER", state: "待认领" })]
    });
    expect(detail.completion).toMatchObject({
      ready: false,
      blockingDependencies: ["MPR-REQ-BLOCKER"]
    });
  });
});

describe("cross-session updates", () => {
  it.each([alice, admin])("allows $userId to continue state and content updates without replacing the claim", async (principal) => {
    const client = new FakeOpenProject([wp({ cfClaimedSession: "session-a" })]);
    const service = new RequirementService(client, fieldMap);
    await service.updateState({ project: "eva-project", reference: 1, sessionId: "session-b", state: "进行中", note: "继续处理", changedAt: "2026-09-20T10:00:00+08:00", expectedLockVersion: 3 }, principal);
    await service.updateContent({ project: "eva-project", reference: 1, sessionId: "session-b", title: "Continued requirement", note: "补充说明", changedAt: "2026-09-20T10:01:00+08:00", expectedLockVersion: 4 }, principal);
    const result = await client.getWorkPackage(1);
    expect(result.subject).toBe("Continued requirement");
    expect(result.cfClaimedSession).toBe("session-a");
    expect(result.lockVersion).toBe(5);
    await expect(service.updateState({ project: "eva-project", reference: 1, sessionId: "session-b", state: "进行中", note: "stale", changedAt: "2026-09-20T10:02:00+08:00", expectedLockVersion: 3 }, principal)).rejects.toThrow(/Stale lockVersion/);
    expect(client.updateCalls).toHaveLength(2);
  });

  it("does not grant another public reader cross-session write access", async () => {
    const item = wp({ cfClaimedSession: "session-a" });
    item._links.cfVisibility = { href: option("visibility", "public"), title: "公开" };
    const client = new FakeOpenProject([item]);
    const service = new RequirementService(client, fieldMap);
    await expect(service.updateState({ project: "eva-project", reference: 1, sessionId: "session-b", state: "进行中", note: "update", changedAt: "2026-09-20T10:00:00+08:00" }, bob)).rejects.toThrow(RequirementValidationError);
    expect(client.updateCalls).toHaveLength(0);
  });
});

describe("finishing a requirement by hand", () => {
  const finish = (service: RequirementService, principal: Principal, options?: { byHand?: boolean }) =>
    service.updateState({
      project: "eva-project", reference: 1, state: "已完成", note: "在网页上修改",
      changedAt: "2026-09-23T09:00:00.000Z", expectedLockVersion: 3
    }, principal, options);

  it("saves 已完成 from the pool page without evidence, dated and accepted", async () => {
    const client = new FakeOpenProject([wp()]);
    const service = new RequirementService(client, fieldMap);

    const result = await finish(service, { ...alice, via: "网页" }, { byHand: true });

    expect(result.state).toBe("已完成");
    const payload = client.updateCalls[0]!.payload;
    expect(JSON.stringify(payload._links)).toContain(option("acceptance", "accepted"));
    // Dated where the home page reads when a completion happened.
    const raw = String((payload.description as { raw: string }).raw);
    expect(raw).toContain("## 交付证据\n\n完成时间：2026-09-23T09:00:00.000Z");
    expect(raw).toContain("alice 在网页上手动改为「已完成」，未附交付证据。");
    expect(client.comments[0]?.text).toContain("状态更新为「已完成」，未附交付证据。在网页上修改");
  });

  it("still refuses an agent a completion without evidence", async () => {
    const client = new FakeOpenProject([wp()]);
    const service = new RequirementService(client, fieldMap);

    await expect(finish(service, { ...alice, via: "Claude" })).rejects.toThrow(/requirements_complete/);
    expect(client.updateCalls).toHaveLength(0);
  });
});

describe("an agent claims a requirement before working on it", () => {
  const viaCodex: Principal = { ...alice, via: "Codex" };
  const move = (service: RequirementService, state: string, principal: Principal, options?: { byHand?: boolean }) =>
    service.updateState({
      project: "eva-project", reference: 1, state, note: "开工", changedAt: "2026-09-23T14:00:00Z"
    }, principal, options);

  it.each(["进行中", "已实现待提交", "待验证/验收"])("refuses an agent moving an unclaimed requirement to %s", async state => {
    const client = new FakeOpenProject([wp()]);
    const service = new RequirementService(client, fieldMap);

    await expect(move(service, state, viaCodex)).rejects.toThrow(/requirements_claim/);
    expect(client.updateCalls).toHaveLength(0);
  });

  it("lets a person on the pool page change it without a claim", async () => {
    const client = new FakeOpenProject([wp()]);
    const service = new RequirementService(client, fieldMap);

    await move(service, "进行中", { ...alice, via: "网页" }, { byHand: true });

    expect(client.updateCalls).toHaveLength(1);
  });

  it("refuses an agent completing an unclaimed requirement, and lets the page complete it", async () => {
    const client = new FakeOpenProject([wp()]);
    const service = new RequirementService(client, fieldMap);
    const complete = (principal: Principal, options?: { byHand?: boolean }) => service.complete({
      project: "eva-project", reference: 1, sessionId: "session-b", completedAt: "2026-09-23T14:00:00Z",
      evidence: [{
        repository: "Eva-Project", sha: "a".repeat(40), paths: ["services/mcp/src/service.ts"],
        verification: "npm test passed", acceptanceStatus: "不适用" as const, acceptanceSource: "infrastructure"
      }]
    }, principal, options);

    await expect(complete(viaCodex)).rejects.toThrow(/requirements_claim/);
    expect(client.updateCalls).toHaveLength(0);
    expect((await complete({ ...alice, via: "网页" }, { byHand: true })).state).toBe("已完成");
  });

  it("does not let a new requirement start as work in progress", async () => {
    const client = new FakeOpenProject([]);
    const service = new RequirementService(client, fieldMap);

    await expect(service.create(requirementInput({ state: "进行中" }), viaCodex)).rejects.toThrow(/requirements_claim/);
    expect(client.createCalls).toHaveLength(0);
  });
});

describe("a new requirement can be created under its parent", () => {
  it("binds it in the create itself when a parent is given", async () => {
    const client = new FakeOpenProject([wp({ id: 1, cfId: "MPR-REQ-PARENT" })]);
    const service = new RequirementService(client, fieldMap);

    const created = await service.create(requirementInput({ id: "MPR-REQ-CHILD", parent: "MPR-REQ-PARENT" }), alice);

    expect(created.item.parentWorkPackageId).toBe(1);
    // One write: nothing is left for a second call to forget.
    expect(client.createCalls).toHaveLength(1);
    expect(client.updateCalls).toHaveLength(0);
  });

  it("leaves a requirement without a parent at the top level", async () => {
    const service = new RequirementService(new FakeOpenProject([]), fieldMap);

    const created = await service.create(requirementInput(), alice);

    expect(created.item.parentWorkPackageId).toBeNull();
  });
});

describe("completion", () => {
  const validEvidence = [{
    repository: "git@github.com:briantant3/Eva-Project.git",
    sha: "a".repeat(40),
    paths: ["services/mcp/src/service.ts"],
    verification: "npm test passed",
    acceptanceStatus: "不适用" as const,
    acceptanceSource: "No product acceptance applies to this infrastructure change"
  }];

  it("rejects abbreviated commit hashes", async () => {
    const client = new FakeOpenProject([wp({ cfClaimedSession: "session-a" })]);
    const service = new RequirementService(client, fieldMap);

    await expect(service.complete({
      reference: 1,
      sessionId: "session-a",
      completedAt: "2026-09-19T19:00:00+08:00",
      evidence: [{ ...validEvidence[0]!, sha: "abc123" }]
    }, alice)).rejects.toThrow(RequirementValidationError);
    expect(client.updateCalls).toHaveLength(0);
  });

  it("blocks completion while a required child is incomplete", async () => {
    const client = new FakeOpenProject([wp({ cfClaimedSession: "session-a" })]);
    client.children = [wp({
      id: 2,
      cfId: "MPR-REQ-002",
      cfRequired: true,
      _links: {
        ...wp()._links,
        cfState: { href: option("state", "active"), title: "进行中" }
      }
    })];
    const service = new RequirementService(client, fieldMap);

    await expect(service.complete({
      reference: 1,
      sessionId: "session-a",
      completedAt: "2026-09-19T19:00:00+08:00",
      evidence: validEvidence
    }, alice)).rejects.toThrow(/Required children are incomplete/);
    expect(client.updateCalls).toHaveLength(0);
  });

  it("checks required children beyond the first OpenProject page", async () => {
    const client = new FakeOpenProject([wp({ cfClaimedSession: "session-a" })]);
    client.children = Array.from({ length: 201 }, (_, index) => wp({
      id: index + 2,
      cfId: `MPR-REQ-${index + 2}`,
      cfRequired: index === 200,
      _links: {
        ...wp()._links,
        cfState: {
          href: option("state", index === 200 ? "active" : "done"),
          title: index === 200 ? "进行中" : "已完成"
        }
      }
    }));
    const service = new RequirementService(client, fieldMap);

    await expect(service.complete({
      reference: 1,
      sessionId: "session-a",
      completedAt: "2026-09-19T19:00:00+08:00",
      evidence: validEvidence
    }, alice)).rejects.toThrow(/MPR-REQ-202/);
    expect(client.updateCalls).toHaveLength(0);
  });

  it("records evidence and closes only after checks pass", async () => {
    const client = new FakeOpenProject([wp({ cfClaimedSession: "session-a" })]);
    const service = new RequirementService(client, fieldMap);

    const result = await service.complete({
      reference: 1,
      sessionId: "session-b",
      completedAt: "2026-09-19T19:00:00+08:00",
      evidence: validEvidence
    }, alice);

    expect(result.state).toBe("已完成");
    expect(client.updateCalls).toHaveLength(1);
    expect(JSON.stringify(client.updateCalls[0]!.payload)).toContain("a".repeat(40));
  });
});

describe("handoffs are excluded from the requirement side", () => {
  const withHandoffType = handoffAwareFieldMap;
  const typed = (id: number, typeId: number, requirementId: string) =>
    wp({
      id,
      cfId: requirementId,
      cfOwnerUserId: "alice",
      _links: { ...wp()._links, type: { href: `/api/v3/types/${typeId}`, title: typeId === 9 ? "交接" : "Task" } }
    });

  it("leaves handoffs out of the requirement list", async () => {
    const client = new FakeOpenProject([typed(1, 1, "MPR-REQ-001"), typed(2, 9, "MPR-HO-001")]);
    const service = new RequirementService(client, withHandoffType);

    const result = await service.list({ project: "eva-project" }, alice);

    expect(result.items.map(item => item.id)).toEqual(["MPR-REQ-001"]);
  });

  it("refuses to list the handoff type through the requirement tool", async () => {
    const service = new RequirementService(new FakeOpenProject([]), withHandoffType);

    await expect(service.list({ project: "eva-project", typeId: 9 }, alice))
      .rejects.toThrow(/handoff/i);
  });

  it("still returns requirements when an ordinary type is requested", async () => {
    const client = new FakeOpenProject([typed(1, 1, "MPR-REQ-001"), typed(2, 9, "MPR-HO-001")]);
    const service = new RequirementService(client, withHandoffType);

    const result = await service.list({ project: "eva-project", typeId: 1 }, alice);

    expect(result.items.map(item => item.id)).toEqual(["MPR-REQ-001"]);
  });

  it("refuses to read a handoff through requirements_get", async () => {
    const client = new FakeOpenProject([typed(2, 9, "MPR-HO-001")]);
    const service = new RequirementService(client, withHandoffType);

    await expect(service.get(2, "eva-project", alice)).rejects.toThrow(/handoff/i);
  });

  it("refuses to read a handoff through requirements_tree", async () => {
    const client = new FakeOpenProject([typed(2, 9, "MPR-HO-001")]);
    const service = new RequirementService(client, withHandoffType);

    await expect(service.tree({ project: "eva-project", reference: 2, depth: 1 }, alice))
      .rejects.toThrow(/handoff/i);
  });

  it("keeps the handoff type out of the selectable requirement types", async () => {
    const service = new RequirementService(new FakeOpenProject([]), withHandoffType);

    const result = await service.types("eva-project", alice);

    expect(result.types.map(type => type.name)).toEqual(["Task", "Feature", "Bug"]);
  });

  it("changes nothing for a field map written before handoffs existed", async () => {
    const client = new FakeOpenProject([typed(1, 1, "MPR-REQ-001"), typed(2, 9, "MPR-HO-001")]);
    const service = new RequirementService(client, fieldMap);

    const result = await service.list({ project: "eva-project" }, alice);

    expect(result.items.map(item => item.id)).toEqual(["MPR-REQ-001", "MPR-HO-001"]);
    expect((await service.types("eva-project", alice)).types).toHaveLength(4);
  });
});

describe("claim takeover", () => {
  const claimed = () => wp({ cfClaimedSession: "dead-session", cfOwnerUserId: "alice" });

  it("still refuses a foreign release when takeover is not requested", async () => {
    const service = new RequirementService(new FakeOpenProject([claimed()]), fieldMap);

    await expect(service.release({
      project: "eva-project", reference: 1, sessionId: "new-session",
      reason: "上一任已失联", releasedAt: "2026-09-21T22:00:00+08:00"
    }, alice)).rejects.toThrow(/dead-session/);
  });

  it("lets the owner take over a claim left by a session that is gone", async () => {
    const client = new FakeOpenProject([claimed()]);
    const service = new RequirementService(client, fieldMap);

    const result = await service.release({
      project: "eva-project", reference: 1, sessionId: "new-session",
      reason: "上一任已失联", releasedAt: "2026-09-21T22:00:00+08:00", takeover: true
    }, alice);

    expect(result.claimedSession).toBeNull();
    const payload = client.updateCalls[0]!.payload;
    expect(payload.cfClaimedSession).toBeNull();
    expect((payload._links as Record<string, unknown>).cfState)
      .toEqual({ href: option("state", "unclaimed") });
  });

  it("records who took over and from which session", async () => {
    const client = new FakeOpenProject([claimed()]);
    const service = new RequirementService(client, fieldMap);

    await service.release({
      project: "eva-project", reference: 1, sessionId: "new-session",
      reason: "上一任已失联", releasedAt: "2026-09-21T22:00:00+08:00", takeover: true
    }, alice);

    expect(client.updateCalls[0]!.payload.description).toBeUndefined();
    const record = client.comments[0]!.text;
    expect(record).toContain("接管释放认领");
    expect(record).toContain("dead-session");
    expect(record).toContain("alice");
  });

  it("refuses a takeover by someone who does not own the requirement", async () => {
    const service = new RequirementService(new FakeOpenProject([claimed()]), fieldMap);

    await expect(service.release({
      project: "eva-project", reference: 1, sessionId: "new-session",
      reason: "想接管", releasedAt: "2026-09-21T22:00:00+08:00", takeover: true
    }, bob)).rejects.toThrow(/not found/);
  });

  it("leaves an ordinary same-session release unchanged", async () => {
    const client = new FakeOpenProject([claimed()]);
    const service = new RequirementService(client, fieldMap);

    await service.release({
      project: "eva-project", reference: 1, sessionId: "dead-session",
      reason: "交还", releasedAt: "2026-09-21T22:00:00+08:00"
    }, alice);

    expect(client.updateCalls[0]!.payload.description).toBeUndefined();
    expect(client.comments[0]!.text).toContain("释放认领。交还");
    expect(client.comments[0]!.text).not.toContain("接管");
  });
});


describe("what a caller is allowed to see is decided by the query, not by a scan", () => {
  // 可见性 x owner, every combination including the record that carries no 可见性 at all.
  const record = (id: number, visibility: "公开" | "私有" | null, owner: string): WorkPackage => wp({
    id,
    cfId: `R${id}`,
    cfOwnerUserId: owner,
    updatedAt: `2026-09-${10 + id}T00:00:00+08:00`,
    _links: {
      ...wp()._links,
      cfVisibility: visibility === null
        ? { href: null }
        : { href: option("visibility", visibility === "公开" ? "public" : "private"), title: visibility }
    }
  });

  const everything = () => [
    record(1, "公开", "alice"),
    record(2, "私有", "alice"),
    record(3, null, "alice"),
    record(4, "公开", "bob"),
    record(5, "私有", "bob"),
    record(6, null, "bob")
  ];

  const ids = (result: { items: Array<{ id: string }> }) => result.items.map(item => item.id);

  it("returns exactly what canRead allows, the 可见性-less record included", async () => {
    const service = new RequirementService(new FakeOpenProject(everything()), fieldMap);

    const result = await service.list({ project: "eva-project", pageSize: 50 }, alice);

    // 公开 from anyone, plus everything alice owns whatever its 可见性. Never bob's.
    expect(new Set(ids(result))).toEqual(new Set(["R1", "R2", "R3", "R4"]));
    expect(result.total).toBe(4);
  });

  it("does not read the whole project to answer one page", async () => {
    const client = new FakeOpenProject(everything());
    const service = new RequirementService(client, fieldMap);

    await service.list({ project: "eva-project", pageSize: 2 }, alice);

    // Each stream is asked for the page it needs, not for the project.
    for (const parameters of client.listParameters) {
      expect(Number(parameters.pageSize)).toBeLessThanOrEqual(2);
    }
  });

  it("asks one query when the caller is an admin", async () => {
    const client = new FakeOpenProject(everything());
    const service = new RequirementService(client, fieldMap);

    const result = await service.list({ project: "eva-project", pageSize: 50 }, admin);

    expect(client.listProjectIds).toHaveLength(1);
    expect(result.total).toBe(6);
  });

  it("pages across the merge without repeating or skipping a record", async () => {
    const service = new RequirementService(new FakeOpenProject(everything()), fieldMap);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof service.list>> = await service.list(
        { project: "eva-project", pageSize: 2, ...(cursor ? { cursor } : {}) }, alice
      );
      seen.push(...ids(page));
      cursor = page.nextCursor;
    } while (cursor);

    // Newest first, and each record exactly once.
    expect(seen).toEqual(["R4", "R3", "R2", "R1"]);
  });

  it("lets a caller filter narrow the result but never widen it", async () => {
    const service = new RequirementService(new FakeOpenProject(everything()), fieldMap);

    const result = await service.list({
      project: "eva-project",
      pageSize: 50,
      filters: [{ cfOwnerUserId: { operator: "=", values: ["bob"] } }]
    }, alice);

    // Asking for bob's requirements yields only the one he made public.
    expect(ids(result)).toEqual(["R4"]);
  });

  it("keeps what a reader picks in the 可见性 and 需求提交人 columns (#207)", async () => {
    const service = new RequirementService(new FakeOpenProject(everything()), fieldMap);
    const pick = async (select: Record<string, string[]>, principal: Principal = alice) => {
      const result = await service.list({ project: "eva-project", pageSize: 50, sortBy: "id:asc", select }, principal);
      expect(result.total).toBe(result.items.length);
      return ids(result);
    };

    expect(await pick({ visibility: ["私有"] })).toEqual(["R2"]);
    expect(await pick({ visibility: ["公开"] })).toEqual(["R1", "R4"]);
    expect(await pick({ ownerUserId: ["bob"] })).toEqual(["R4"]);
    expect(await pick({ ownerUserId: ["alice"] })).toEqual(["R1", "R2", "R3"]);
    expect(await pick({ visibility: ["私有"], ownerUserId: ["alice"] })).toEqual(["R2"]);
    expect(await pick({ visibility: ["私有"], ownerUserId: ["bob"] })).toEqual([]);
    expect(await pick({ visibility: ["私有"] }, admin)).toEqual(["R2", "R5"]);
  });

  it("keeps those picks on the pool page's tree as well", async () => {
    const service = new RequirementService(new FakeOpenProject(everything()), fieldMap);

    const result = await service.listTree(
      { project: "eva-project", pageSize: 50, sortBy: "id:asc", select: { visibility: ["私有"] } }, alice
    );

    expect(ids(result)).toEqual(["R2"]);
    expect(result.total).toBe(1);
  });

  it("refuses a sort key it cannot compare while merging", async () => {
    const service = new RequirementService(new FakeOpenProject(everything()), fieldMap);

    await expect(service.list({ project: "eva-project", sortBy: "cfState:asc" }, alice))
      .rejects.toThrow(/Cannot sort by cfState/);
    await expect(service.list({ project: "eva-project", sortBy: "updatedAt:sideways" }, alice))
      .rejects.toThrow(/asc or desc/);
  });

  it("refuses to page deeper than the merge can hold", async () => {
    const service = new RequirementService(new FakeOpenProject(everything()), fieldMap);

    await expect(service.list({ project: "eva-project", pageSize: 50, cursor: "500" }, alice))
      .rejects.toThrow(/Cannot page beyond/);
  });
});

describe("the pool page pages the tree's rows, children counted (#258)", () => {
  // Public and alice's unless said otherwise.
  const record = (id: number, options: {
    parent?: number;
    finished?: boolean;
    visibility?: "公开" | "私有";
    owner?: string;
  } = {}): WorkPackage => wp({
    id,
    cfId: `R${id}`,
    cfOwnerUserId: options.owner ?? "alice",
    _links: {
      ...wp()._links,
      cfVisibility: options.visibility === "私有"
        ? { href: option("visibility", "private"), title: "私有" }
        : { href: option("visibility", "public"), title: "公开" },
      ...(options.finished ? { cfState: { href: option("state", "done"), title: "已完成" } } : {}),
      ...(options.parent ? { parent: { href: `/api/v3/work_packages/${options.parent}`, title: `R${options.parent}` } } : {})
    }
  });

  // 1, 2, 3 and 5 stand alone. 6 was filed under 1 after all of them, and 7 sits under 4,
  // which is under 1. 9 hangs under 20, which is finished and so hidden by default.
  const pool = () => [
    record(1), record(2), record(3), record(4, { parent: 1 }), record(5),
    record(6, { parent: 1 }), record(7, { parent: 4 }), record(8, { parent: 3 }),
    record(9, { parent: 20 }), record(20, { finished: true })
  ];

  const ids = (result: { items: Array<{ id: string | null }> }) => result.items.map(item => item.id);
  const rows = (result: { items: Array<{ id: string | null; depth: number }> }) =>
    result.items.map(item => [item.id, item.depth]);

  const pageOf = (client: FakeOpenProject, cursor?: string) =>
    new RequirementService(client, fieldMap).listTree({
      project: "eva-project",
      pageSize: 2,
      sortBy: "id:asc",
      excludeStates: ["已完成"],
      ...(cursor ? { cursor } : {})
    }, alice);

  it("lays a child out under its parent, however much later it was filed, each row once", async () => {
    const client = new FakeOpenProject(pool());

    const seen: Array<Array<string | number | null>> = [];
    for (let cursor: string | null = "1"; cursor;) {
      const page = await pageOf(client, cursor);
      seen.push(...rows(page));
      cursor = page.nextCursor;
    }

    // 4 and 6 under 1, 7 under 4, 8 under 3; 9's parent 20 is finished, so filtered out.
    expect(seen).toEqual([
      ["R1", 0], ["R4", 1], ["R7", 2], ["R6", 1], ["R2", 0], ["R3", 0], ["R8", 1], ["R5", 0], ["R9", 0]
    ]);
  });

  it("counts children in the pages and carries a cut family on to the next one", async () => {
    const client = new FakeOpenProject(pool());

    const first = await pageOf(client);
    expect(rows(first)).toEqual([["R1", 0], ["R4", 1]]);
    // Nine rows two to a page: five pages.
    expect([first.total, first.nextCursor]).toEqual([9, "2"]);
    // 1's family runs over, and 7 and 6 open the next page as deep as they sit.
    expect(rows(await pageOf(client, "2"))).toEqual([["R7", 2], ["R6", 1]]);
    expect((await pageOf(client, "5")).nextCursor).toBeNull();
  });

  it("leaves a requirement whose parent is filtered out at the top level, naming the parent", async () => {
    const last = await pageOf(new FakeOpenProject(pool()), "5");

    expect(last.items.map(item => [item.id, item.depth, item.parentWorkPackageId, item.parentTitle]))
      .toEqual([["R9", 0, 20, "R20"]]);
  });

  it("keeps to what each reader may see, in the rows and in the counts", async () => {
    const client = new FakeOpenProject([
      record(1),
      record(2, { parent: 1, visibility: "私有", owner: "bob" }),
      record(3, { visibility: "私有" }),
      record(4, { parent: 3, owner: "bob" })
    ]);
    const service = new RequirementService(client, fieldMap);
    const view = (principal: Principal) =>
      service.listTree({ project: "eva-project", pageSize: 50, sortBy: "id:asc" }, principal);

    // bob's private 2 is not alice's to see, and 4 nests under her private 3.
    const forAlice = await view(alice);
    expect(rows(forAlice)).toEqual([["R1", 0], ["R3", 0], ["R4", 1]]);
    expect(forAlice.total).toBe(3);

    // For bob it is the other way round: 3 is out of sight, so 4 stands alone.
    const forBob = await view(bob);
    expect(rows(forBob)).toEqual([["R1", 0], ["R2", 1], ["R4", 0]]);
    expect(forBob.total).toBe(3);
  });

  it("reads whole records only for children and for this page's own rows", async () => {
    const client = new FakeOpenProject(pool());

    await pageOf(client, "3");

    // The whole match travels as ids; a request without `select` reads whole records. The
    // children 4, 6, 7 and 8 have to say where they sit; of the rest only page 3's 2 and 3.
    const whole = client.listParameters.flatMap((parameters, call) =>
      parameters.select ? [] : client.listReturned[call] ?? []);
    expect([...new Set(whole)].sort((a, b) => a - b)).toEqual([2, 3, 4, 6, 7, 8]);
  });

  it("finds a child whose parent lies beyond the first chunk of ids", async () => {
    // 255 is filed under 3, and 7 under 230: one parent in each chunk of the match.
    const client = new FakeOpenProject(Array.from({ length: 260 }, (_, index) => {
      const id = index + 1;
      return record(id, id === 255 ? { parent: 3 } : id === 7 ? { parent: 230 } : {});
    }));
    const service = new RequirementService(client, fieldMap);
    const page = (cursor: string) =>
      service.listTree({ project: "eva-project", pageSize: 50, sortBy: "id:asc", cursor }, admin);

    const first = await page("1");
    expect(first.total).toBe(260);
    expect(rows(first).slice(0, 5)).toEqual([["R1", 0], ["R2", 0], ["R3", 0], ["R255", 1], ["R4", 0]]);
    expect(ids(first)).not.toContain("R7");

    // 230 is the 230th row, on page 5, and 7 follows it.
    const fifth = rows(await page("5"));
    const at = fifth.findIndex(([id]) => id === "R230");
    expect(fifth.slice(at, at + 2)).toEqual([["R230", 0], ["R7", 1]]);
    expect((await page("6")).nextCursor).toBeNull();
  });
});

describe("looking requirements up by id (#371)", () => {
  // 1 and 2 are this project's; 36 is another project's; 3 is no work package at all.
  const record = (id: number, project = 1): WorkPackage => wp({
    id,
    cfId: `R${id}`,
    _links: {
      ...wp()._links,
      project: { href: `/api/v3/projects/${project}`, title: project === 1 ? "eva-project" : "mila-3" },
      cfVisibility: { href: option("visibility", "public"), title: "公开" }
    }
  });
  const service = () => {
    const client = new FakeOpenProject([record(1), record(2), record(36, 2)]);
    client.scopeByProject = true;
    return new RequirementService(client, fieldMap);
  };
  const ids = (result: { items: Array<{ id: string | null }> }) => result.items.map(item => item.id);

  it("finds nothing, and says nothing is wrong, for an id that is not in the project", async () => {
    // 3 and 36 are what typing 367 passes through on the way.
    for (const typed of [["3"], ["36"], ["3", "36"]]) {
      const tree = await service().listTree({ project: "eva-project", pageSize: 50, sortBy: "id:asc", ids: typed }, admin);
      expect([ids(tree), tree.total, tree.nextCursor]).toEqual([[], 0, null]);
      const flat = await service().list({ project: "eva-project", pageSize: 50, ids: typed }, admin);
      expect([ids(flat), flat.total]).toEqual([[], 0]);
    }
  });

  it("keeps the ids that are in the project when others are not", async () => {
    const tree = await service().listTree(
      { project: "eva-project", pageSize: 50, sortBy: "id:asc", ids: ["2", "3", "36", "1"] }, admin);
    expect([ids(tree), tree.total]).toEqual([["R1", "R2"], 2]);
    const flat = await service().list({ project: "eva-project", pageSize: 50, sortBy: "id:asc", ids: ["36", "2"] }, admin);
    expect(ids(flat)).toEqual(["R2"]);
  });
});

describe("paging past the 200th requirement (#206)", () => {
  // Public, so a reader gets them through the 公开 stream and an admin through the only one.
  const pool = (count: number) => Array.from({ length: count }, (_, index) => wp({
    id: index + 1,
    cfId: `R${index + 1}`,
    _links: { ...wp()._links, cfVisibility: { href: option("visibility", "public"), title: "公开" } }
  }));
  const ids = (result: { items: Array<{ id: string | null }> }) => result.items.map(item => item.id);
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => `R${from + index}`);

  it.each([["an admin", admin], ["a reader", alice]] as const)("hands %s the page asked for", async (_, principal) => {
    const service = new RequirementService(new FakeOpenProject(pool(260)), fieldMap);

    const page = await service.list({ project: "eva-project", pageSize: 50, cursor: "5", sortBy: "id:asc" }, principal);

    expect(ids(page)).toEqual(range(201, 250));
  });

  it("walks every page, each requirement once", async () => {
    const service = new RequirementService(new FakeOpenProject(pool(260)), fieldMap);

    const seen: Array<string | null> = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof service.list>> = await service.list(
        { project: "eva-project", pageSize: 50, sortBy: "id:asc", ...(cursor ? { cursor } : {}) }, alice
      );
      seen.push(...ids(page));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(range(1, 260));
  });

  it.each([["an admin", admin], ["a reader", alice]] as const)(
    "scans between 400 and 500 candidates for %s without losing one",
    async (_, principal) => {
      const service = new RequirementService(new FakeOpenProject(pool(450)), fieldMap);

      const page = await service.list(
        { project: "eva-project", ready: true, pageSize: 50, cursor: "9", sortBy: "id:asc" }, principal
      );

      expect(page.total).toBe(450);
      expect(ids(page)).toEqual(range(401, 450));
    }
  );
});

describe("which projects a caller may reach is OpenProject's judgement", () => {
  // alice is OpenProject user 11 and may see project 1 only; project 2 is not hers.
  const restricted = (packages: WorkPackage[] = []) => {
    const client = new FakeOpenProject(packages);
    client.visibleProjects = new Map([[11, [1]], [12, [1, 2]]]);
    return client;
  };

  it("lists only the projects the caller can see", async () => {
    const service = new RequirementService(restricted(), fieldMap);

    const mine = await service.listProjects(alice);
    const both = await service.listProjects(bob);

    expect(mine.items.map(project => project.identifier)).toEqual(["eva-project"]);
    expect(both.items.map(project => project.identifier)).toEqual(["eva-project", "mila-3"]);
  });

  it("lists every project for an admin without asking OpenProject to narrow it", async () => {
    const service = new RequirementService(restricted(), fieldMap);

    const result = await service.listProjects(admin);

    expect(result.items.map(project => project.identifier)).toEqual(["eva-project", "mila-3"]);
  });

  it("refuses a project the caller cannot see, by identifier", async () => {
    const service = new RequirementService(restricted(), fieldMap);

    await expect(service.list({ project: "mila-3" }, alice)).rejects.toThrow(/Project not found: mila-3/);
    await expect(service.list({ project: "eva-project" }, alice)).resolves.toBeDefined();
  });

  it("refuses it by numeric id too, so a public record cannot leak out of a hidden project", async () => {
    const elsewhere = wp({
      id: 7,
      cfId: "R7",
      cfOwnerUserId: "bob",
      _links: {
        ...wp()._links,
        project: { href: "/api/v3/projects/2", title: "mila-3" },
        cfVisibility: { href: option("visibility", "public"), title: "公开" }
      }
    });
    const service = new RequirementService(restricted([elsewhere]), fieldMap);

    // canRead alone would allow it: the record is 公开. The project is what stops it.
    await expect(service.get(7, "mila-3", alice)).rejects.toThrow(/Project not found/);
    await expect(service.get(7, "mila-3", bob)).resolves.toBeDefined();
  });

  it("says what to do when an identity has no OpenProject account behind it", async () => {
    const service = new RequirementService(restricted(), fieldMap);
    const ghost: Principal = { userId: "ghost", displayName: "Ghost", role: "user" };

    await expect(service.listProjects(ghost)).rejects.toThrow(/No OpenProject account matches ghost/);
    await expect(service.listProjects(ghost)).rejects.toThrow(/openProjectLogin/);
  });

  it("follows openProjectLogin when the two names differ", async () => {
    const client = restricted();
    client.users = new Map([["op-alice", 11]]);
    const service = new RequirementService(client, fieldMap);

    const result = await service.listProjects({ ...alice, openProjectLogin: "op-alice" });

    expect(result.items.map(project => project.identifier)).toEqual(["eva-project"]);
  });

  it("does not fall back to userId after an explicit unlink", async () => {
    const service = new RequirementService(restricted(), fieldMap);
    const unlinked = { ...alice, openProjectLogin: null };
    await expect(service.listProjects(unlinked)).rejects.toThrow(/OpenProject account/);
    await expect(service.list({ project: "eva-project" }, unlinked)).rejects.toThrow(/OpenProject account/);
  });
});


describe("long text custom fields", () => {
  it("sends 认领范围 as { raw } and reads it back, instead of losing it", async () => {
    const client = new FakeOpenProject([wp({ cfClaimedSession: null })]);
    const service = new RequirementService(client, fieldMap);

    await service.claim({
      project: "eva-project",
      reference: "MPR-REQ-001",
      agent: "Codex",
      sessionId: "session-1",
      label: "Brian",
      scope: "把详情就地编辑做完",
      claimedAt: "2026-09-22T10:00:00+08:00"
    }, alice);

    // A bare string here is accepted by OpenProject and then silently dropped, which is
    // how every claim so far ended up with an empty 认领范围.
    const payload = client.updateCalls.at(-1)?.payload as Record<string, unknown>;
    expect(payload.cfClaimScope).toEqual({ raw: "把详情就地编辑做完" });

    const detail = await service.get("MPR-REQ-001", "eva-project", alice);
    expect((detail.claim as Record<string, unknown>).scope).toBe("把详情就地编辑做完");
  });
});

describe("reading the history back", () => {
  // 变更记录 lives here now, so a caller has to be able to ask for part of it.
  const streamed = () => {
    const client = new FakeOpenProject([wp()]);
    client.activities = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      createdAt: `2026-09-22T0${index % 10}:00:00.000Z`,
      // Every other entry is a bare field change carrying no reason.
      ...(index % 2 === 0 ? { comment: { raw: `理由 ${index + 1}` } } : {}),
      details: [{ raw: `字段 ${index + 1} 变了` }]
    }));
    return client;
  };

  it("hands the page the whole stream when nothing is asked for", async () => {
    const client = streamed();
    const service = new RequirementService(client, fieldMap);

    const result = await service.activities(1, "eva-project", alice);

    expect(result.total).toBe(12);
    expect(result.returned).toBe(12);
  });

  it("takes the window from the newest end but reads forwards inside it", async () => {
    const service = new RequirementService(streamed(), fieldMap);

    const result = await service.activities(1, "eva-project", alice, { limit: 3 });

    expect(result.total).toBe(12);
    expect(result.returned).toBe(3);
    // The three most recent, still oldest-first, so a history never reads backwards.
    expect(result.items.map(item => item.id)).toEqual([10, 11, 12]);
  });

  it("pages further back with offset", async () => {
    const service = new RequirementService(streamed(), fieldMap);

    const result = await service.activities(1, "eva-project", alice, { limit: 3, offset: 3 });

    expect(result.items.map(item => item.id)).toEqual([7, 8, 9]);
  });

  it("gives just the reasons when asked, and counts only those", async () => {
    const service = new RequirementService(streamed(), fieldMap);

    const result = await service.activities(1, "eva-project", alice, { notesOnly: true, limit: 2 });

    // total reports what matched the filter, not the whole stream, or paging past the
    // end of the filtered list would look like there is more to read.
    expect(result.total).toBe(6);
    expect(result.items.map(item => item.comment)).toEqual(["理由 9", "理由 11"]);
  });

  it("does not fall over when the window runs past the start", async () => {
    const service = new RequirementService(streamed(), fieldMap);

    const result = await service.activities(1, "eva-project", alice, { limit: 5, offset: 10 });

    expect(result.items.map(item => item.id)).toEqual([1, 2]);
  });
});

describe("activities", () => {
  it("carries the actor's id, so the page can ask OpenProject for their avatar", async () => {
    const client = new FakeOpenProject([wp()]);
    client.activities = [
      {
        id: 91,
        createdAt: "2026-09-22T06:52:18.928Z",
        comment: { raw: "在这页直接留言。" },
        details: [{ raw: "需求状态 设置为 进行中" }, { raw: "" }],
        _links: { user: { href: "/api/v3/users/13" } }
      },
      // OpenProject writes the creating entry with no user link at all.
      { id: 80, createdAt: "2026-09-22T06:07:51.900Z", details: [{ raw: "类型 设置为 Feature" }] }
    ];
    const service = new RequirementService(client, fieldMap);

    const result = await service.activities(1, "eva-project", admin);

    expect(result.items).toEqual([
      {
        id: 91,
        createdAt: "2026-09-22T06:52:18.928Z",
        user: "Brian",
        userId: 13,
        agent: null,
        comment: "在这页直接留言。",
        details: ["需求状态 设置为 进行中"]
      },
      {
        id: 80,
        createdAt: "2026-09-22T06:07:51.900Z",
        user: null,
        userId: null,
        agent: null,
        comment: "",
        details: ["类型 设置为 Feature"]
      }
    ]);
  });

  // Brian corrected his account's name in OpenProject on 2026-09-23, and the history kept
  // the old one because the running service had it cached for its whole life.
  const writtenByOneAccount = () => {
    const client = new FakeOpenProject([wp()]);
    const account = { name: "Brian Brian Tan", lookups: 0 };
    client.getUser = async id => {
      account.lookups += 1;
      return { id, login: "admin", name: account.name };
    };
    client.activities = [91, 92, 93].map(id => ({ id, comment: { raw: `第 ${id} 条` }, _links: { user: { href: "/api/v3/users/4" } } }));
    return { client, account };
  };

  it("shows a name corrected in OpenProject on the very next read", async () => {
    const { client, account } = writtenByOneAccount();
    const service = new RequirementService(client, fieldMap);

    expect((await service.activities(1, "eva-project", admin)).items[0]?.user).toBe("Brian Brian Tan");
    account.name = "Brian Tan";
    expect((await service.activities(1, "eva-project", admin)).items.map(item => item.user))
      .toEqual(["Brian Tan", "Brian Tan", "Brian Tan"]);
  });

  it("looks each author up once per read, not once per entry", async () => {
    const { client, account } = writtenByOneAccount();
    const service = new RequirementService(client, fieldMap);

    await service.activities(1, "eva-project", admin);

    expect(account.lookups).toBe(1);
  });
});

describe("a requirement body is a record, not a development log", () => {
  const logged = () => wp({
    cfClaimedSession: "session-a",
    description: {
      format: "markdown",
      raw: [
        "## 用户原文", "", "> 原始请求", "",
        "## Agent 理解", "", "理解", "",
        "## 变更记录", "", "- 第一条",
        "", "## 讨论", "", "中间夹着别的二级标题",
        "", "## 变更记录", "", "- 第二条",
        "", "## 变更记录", "", "- 第三条"
      ].join("\n")
    }
  });

  it("does not grow the body by one character across ten state updates", async () => {
    const client = new FakeOpenProject([logged()]);
    const service = new RequirementService(client, fieldMap);
    const before = client.workPackages.get(1)!.description!.raw;

    for (let round = 0; round < 10; round += 1) {
      await service.updateState({
        project: "eva-project",
        reference: 1,
        state: round % 2 === 0 ? "进行中" : "待认领",
        note: `第 ${round + 1} 轮`,
        changedAt: "2026-09-22T20:00:00+08:00"
      }, alice);
    }

    // The growth this replaces was unbounded: one 二级标题 plus a line per call, paid for
    // by every reader of the record from then on.
    expect(client.workPackages.get(1)!.description!.raw).toBe(before);
    expect(client.updateCalls.every(call => call.payload.description === undefined)).toBe(true);
    // Every reason is still recorded -- on the journal, which is what the 历史 tab reads.
    expect(client.comments).toHaveLength(10);
    expect(client.comments[0]!.text).toBe("- 2026-09-22T20:00:00+08:00：状态更新为「进行中」。第 1 轮");
    expect(client.comments[9]!.text).toContain("第 10 轮");
  });

  it("writes the note before the change, so the two land on one journal entry", async () => {
    const client = new FakeOpenProject([logged()]);
    const service = new RequirementService(client, fieldMap);

    await service.updateState({
      project: "eva-project", reference: 1, state: "进行中",
      note: "开工", changedAt: "2026-09-22T20:00:00+08:00"
    }, alice);

    // ⛔ Not an arbitrary order. OpenProject lets an entry carrying notes absorb the
    // notes-free entry after it, never the reverse, so a note written second is paired
    // with the NEXT change — measured on 17.8.0 as a history captioned 「进行中」 beside
    // details saying 进行中 → 待认领. Reversing these two lines silently reintroduces it.
    expect(client.calls).toEqual(["comment", "update"]);
  });

  it("gives back every run of a heading that appears more than once", async () => {
    const service = new RequirementService(new FakeOpenProject([logged()]), fieldMap);

    const detail = await service.get(1, "eva-project", alice, ["变更记录"]);

    // Reading the first match returned 「- 第一条」 and silently dropped the rest.
    const sections = detail.sections as Record<string, string>;
    expect(sections["变更记录"]).toBe("- 第一条\n\n- 第二条\n\n- 第三条");
  });

  it("reads only the sections asked for, and names what else is there", async () => {
    const service = new RequirementService(new FakeOpenProject([logged()]), fieldMap);

    const detail = await service.get(1, "eva-project", alice, ["用户原文"]);

    expect(detail.sections).toEqual({ "用户原文": "> 原始请求" });
    // The body itself is left out -- that is the whole point of asking for a section.
    expect(detail.description).toBeUndefined();
    expect(detail.agentUnderstanding).toBeUndefined();
    // Each heading named once, in document order, so a caller can choose without
    // reading everything first.
    expect(detail.sectionNames).toEqual(["用户原文", "Agent 理解", "变更记录", "讨论"]);
  });

  it("reads the whole record when no section is named, exactly as before", async () => {
    const service = new RequirementService(new FakeOpenProject([logged()]), fieldMap);

    const detail = await service.get(1, "eva-project", alice);

    expect(detail.description).toBe(logged().description!.raw);
    expect(detail.agentUnderstanding).toBe("理解");
    expect(detail.sections).toBeUndefined();
  });

  it("asking for a section the body does not carry leaves it out rather than inventing it", async () => {
    const service = new RequirementService(new FakeOpenProject([logged()]), fieldMap);

    const detail = await service.get(1, "eva-project", alice, ["用户原文", "交付证据"]);

    expect(detail.sections).toEqual({ "用户原文": "> 原始请求" });
  });
});

describe("delivery evidence stays a section, and completing reaches the history", () => {
  const evidence = (sha: string) => [{
    repository: "git@github.com:briantant3/Eva-Project.git",
    sha,
    paths: ["services/mcp/src/service.ts"],
    verification: "npm test passed",
    acceptanceStatus: "不适用" as const,
    acceptanceSource: "基础设施改动，无产品验收"
  }];

  const templated = (deliverable = "尚无。") => wp({
    cfClaimedSession: "session-a",
    description: {
      format: "markdown",
      raw: ["## 用户原文", "", "> 请求", "", "## 交付证据", "", deliverable,
            "", "## 变更记录", "", "- 登记请求：req-1"].join("\n")
    }
  });

  const headings = (raw: string) => raw.split("\n").filter(line => line.startsWith("## "));

  it("fills the section the template already reserves instead of pasting a new heading", async () => {
    const client = new FakeOpenProject([templated()]);
    const service = new RequirementService(client, fieldMap);

    await service.complete({
      reference: 1, sessionId: "session-a",
      completedAt: "2026-09-22T20:00:00+08:00", evidence: evidence("a".repeat(40))
    }, alice);

    const raw = String((client.updateCalls[0]!.payload.description as { raw: string }).raw);
    expect(headings(raw)).toEqual(["## 用户原文", "## 交付证据", "## 变更记录"]);
    expect(raw).toContain("a".repeat(40));
    // The placeholder is replaced, not kept above the real evidence.
    expect(raw).not.toContain("尚无。");
  });

  it("keeps earlier evidence when a reopened requirement is completed again", async () => {
    const client = new FakeOpenProject([templated()]);
    const service = new RequirementService(client, fieldMap);

    await service.complete({
      reference: 1, sessionId: "session-a",
      completedAt: "2026-09-22T20:00:00+08:00", evidence: evidence("a".repeat(40))
    }, alice);
    await service.complete({
      reference: 1, sessionId: "session-a",
      completedAt: "2026-09-23T20:00:00+08:00", evidence: evidence("b".repeat(40))
    }, alice);

    const raw = String((client.updateCalls[1]!.payload.description as { raw: string }).raw);
    expect(raw).toContain("a".repeat(40));
    expect(raw).toContain("b".repeat(40));
    // Still one section, where the old code grew a second and a third.
    expect(headings(raw).filter(h => h === "## 交付证据")).toHaveLength(1);
  });

  it("collapses 交付证据 sections a previous version already duplicated", async () => {
    const client = new FakeOpenProject([wp({
      cfClaimedSession: "session-a",
      description: {
        format: "markdown",
        raw: ["## 用户原文", "", "> 请求",
              "", "## 交付证据", "", "第一次完成",
              "", "## 交付证据", "", "第二次完成"].join("\n")
      }
    })]);
    const service = new RequirementService(client, fieldMap);

    await service.complete({
      reference: 1, sessionId: "session-a",
      completedAt: "2026-09-22T20:00:00+08:00", evidence: evidence("c".repeat(40))
    }, alice);

    const raw = String((client.updateCalls[0]!.payload.description as { raw: string }).raw);
    expect(headings(raw).filter(h => h === "## 交付证据")).toHaveLength(1);
    // Healed rather than truncated: both old runs survive under the one heading.
    expect(raw).toContain("第一次完成");
    expect(raw).toContain("第二次完成");
    expect(raw).toContain("c".repeat(40));
  });

  it("records the completion in the history, pointing at the evidence", async () => {
    const client = new FakeOpenProject([templated()]);
    const service = new RequirementService(client, fieldMap);

    await service.complete({
      reference: 1, sessionId: "session-a",
      completedAt: "2026-09-22T20:00:00+08:00", evidence: evidence("a".repeat(40))
    }, alice);

    // Completing left no trace in the history at all, which is why the 历史 tab read as
    // nothing but bare state changes.
    expect(client.comments).toEqual([
      { workPackageId: 1, text: "- 2026-09-22T20:00:00+08:00：完成。交付证据 1 条，提交 aaaaaaaaaaaa" }
    ]);
    expect(client.calls).toEqual(["comment", "update"]);
  });
});

describe("recording something no field carries", () => {
  it("adds the text to the history verbatim", async () => {
    const client = new FakeOpenProject([wp()]);
    const service = new RequirementService(client, fieldMap);

    await service.comment({
      project: "eva-project", reference: 1,
      text: "范围缩窄为只做显示：手工维护留在原生工作包页面。"
    }, alice);

    // The history stamps time and author, so the text is not asked to restate them.
    expect(client.comments).toEqual([
      { workPackageId: 1, text: "范围缩窄为只做显示：手工维护留在原生工作包页面。" }
    ]);
    // Nothing on the record changed.
    expect(client.updateCalls).toHaveLength(0);
  });

  it("refuses an empty note rather than writing a blank entry", async () => {
    const client = new FakeOpenProject([wp()]);
    const service = new RequirementService(client, fieldMap);

    await expect(service.comment({ project: "eva-project", reference: 1, text: "   " }, alice))
      .rejects.toThrow(RequirementValidationError);
    expect(client.comments).toHaveLength(0);
  });

  it("refuses a requirement the caller cannot read", async () => {
    const client = new FakeOpenProject([wp({ cfOwnerUserId: "alice" })]);
    const service = new RequirementService(client, fieldMap);

    await expect(service.comment({ project: "eva-project", reference: 1, text: "路过" }, bob))
      .rejects.toThrow();
    expect(client.comments).toHaveLength(0);
  });
});

describe("listing a project that does not have the 交接 type", () => {
  const typeFilters = (client: FakeOpenProject) => client.listParameters
    .flatMap(p => JSON.parse(p.filters ?? "[]") as Array<Record<string, { operator: string; values: string[] }>>)
    .filter(f => "type" in f)
    .map(f => f.type!.operator + ":" + f.type!.values.join(","));

  it("does not exclude a type the project does not have", async () => {
    const client = new FakeOpenProject([wp()]);
    // A freshly created project gets OpenProject's default set, with no 交接 in it.
    client.projectTypes = [{ id: 1, name: "Task" }, { id: 2, name: "Milestone" }];
    const service = new RequirementService(client, handoffAwareFieldMap);

    await service.list({ project: "eva-project" }, alice);

    // OpenProject answers 400 to a type filter naming a type the project does not have,
    // so excluding it unconditionally broke every list read on every new project — the
    // tool as well as the page. There is nothing to exclude there in any case.
    expect(typeFilters(client)).toEqual([]);
  });

  it("still excludes it where the project does have it", async () => {
    const client = new FakeOpenProject([wp()]);
    client.projectTypes = [{ id: 1, name: "Task" }, { id: 9, name: "交接" }];
    const service = new RequirementService(client, handoffAwareFieldMap);

    await service.list({ project: "eva-project" }, alice);

    expect(typeFilters(client)).toEqual(["!:9", "!:9"]);
  });

  it("always sends a filter set, so OpenProject never falls back to its default query", async () => {
    const client = new FakeOpenProject([wp()]);
    client.projectTypes = [{ id: 1, name: "Task" }];
    const service = new RequirementService(client, handoffAwareFieldMap);

    // An admin needs no visibility streams, so this is the one caller whose filter set
    // can legitimately come out empty — exactly the case that used to omit it.
    await service.list({ project: "eva-project" }, admin);

    // Omitting the parameter does not mean "no filters": OpenProject applies the
    // instance's default query instead, which here is 「open status」 plus 「not 交接」.
    // On production the same project answered total=2 without the parameter and total=7
    // with an empty one — leaving it out silently drops every closed requirement.
    expect(client.listParameters.length).toBeGreaterThan(0);
    for (const parameters of client.listParameters) {
      expect(parameters.filters).toBeDefined();
    }
    expect(client.listParameters.some(parameters => parameters.filters === "[]")).toBe(true);
  });

  it("asks OpenProject for a project's types once, not once per list", async () => {
    const client = new FakeOpenProject([wp()]);
    client.projectTypes = [{ id: 1, name: "Task" }];
    const service = new RequirementService(client, handoffAwareFieldMap);
    let calls = 0;
    const original = client.listProjectTypes.bind(client);
    client.listProjectTypes = async () => { calls += 1; return original(); };

    await service.list({ project: "eva-project" }, alice);
    await service.list({ project: "eva-project" }, alice);

    expect(calls).toBe(1);
  });
});

describe("the sort key OpenProject is asked for", () => {
  const sortKeys = (client: FakeOpenProject) =>
    client.listParameters.map(p => JSON.parse(p.sortBy ?? "[]"));

  it("does not name id twice when id is already the sort key", async () => {
    const client = new FakeOpenProject([wp()]);
    const service = new RequirementService(client, fieldMap);

    await service.list({ project: "eva-project", sortBy: "id:asc" }, alice);

    // The id tiebreak is the sort key itself here; sending it twice is noise in every
    // error message and asks OpenProject to order by the same column twice.
    expect(sortKeys(client)[0]).toEqual([["id", "asc"]]);
  });

  it("keeps the tiebreak for any other key, or paging repeats and skips records", async () => {
    const client = new FakeOpenProject([wp()]);
    const service = new RequirementService(client, fieldMap);

    await service.list({ project: "eva-project", sortBy: "updatedAt:desc" }, alice);

    expect(sortKeys(client)[0]).toEqual([["updatedAt", "desc"], ["id", "asc"]]);
  });
});

describe("signing what the service writes", () => {
  const viaClaude: Principal = { ...alice, via: "Claude" };

  it("signs a comment with the identity and the agent", async () => {
    const client = new FakeOpenProject([wp()]);
    const service = new RequirementService(client, fieldMap);

    await service.comment({ project: "eva-project", reference: 1, text: "看过了" }, viaClaude);

    expect(client.comments.map(comment => comment.text)).toEqual(["看过了\n\n— 署名：alice · Claude"]);
  });

  it("signs the reason a state change carries, in the same note, before the change", async () => {
    const client = new FakeOpenProject([wp({ cfClaimedSession: "session-a" })]);
    const service = new RequirementService(client, fieldMap);

    await service.updateState({
      project: "eva-project", reference: 1, state: "进行中", note: "开工", changedAt: "2026-09-23T10:00:00+08:00"
    }, viaClaude);

    expect(client.comments[0]!.text).toBe("- 2026-09-23T10:00:00+08:00：状态更新为「进行中」。开工\n\n— 署名：alice · Claude");
    expect(client.calls).toEqual(["comment", "update"]);
  });

  // A bare change left unsigned would be aggregated into whatever signed entry came
  // before it within five minutes, and read as that agent's work.
  it("gives a change that carries no reason a note that is only the signature, posted first", async () => {
    const client = new FakeOpenProject([wp()]);
    const service = new RequirementService(client, fieldMap);

    await service.claim({
      project: "eva-project", reference: 1, agent: "Codex", sessionId: "session-a",
      label: "开工", scope: "全部", claimedAt: "2026-09-23T10:00:00+08:00"
    }, viaClaude);

    expect(client.comments.map(comment => comment.text)).toEqual(["— 署名：alice · Claude"]);
    expect(client.calls).toEqual(["comment", "update"]);
  });

  it("signs a new requirement once, in the entry that creates it", async () => {
    const client = new FakeOpenProject([]);
    const service = new RequirementService(client, fieldMap);

    const result = await service.create(requirementInput(), viaClaude);

    expect(client.comments).toEqual([{ workPackageId: result.item.workPackageId, text: "— 署名：alice · Claude" }]);
  });

  it("signs each new child once, not once for creating it and again for binding it", async () => {
    const client = new FakeOpenProject([wp({ id: 1, cfId: "MPR-REQ-PARENT" })]);
    const service = new RequirementService(client, fieldMap);
    const { project: _project, requiredForParent: _required, ...fields } = requirementInput({ id: "MPR-REQ-CHILD-1" });

    await service.createChildren({
      project: "eva-project", parent: 1, children: [{ ...fields, requiredForParent: true }]
    }, viaClaude);

    expect(client.comments).toEqual([{ workPackageId: 2, text: "— 署名：alice · Claude" }]);
  });

  it("signs what a person does on the pool page as their own doing", async () => {
    const client = new FakeOpenProject([wp()]);
    const service = new RequirementService(client, fieldMap);

    await service.comment({ project: "eva-project", reference: 1, text: "我自己补一句" }, { ...alice, via: "网页" });

    expect(client.comments[0]!.text).toBe("我自己补一句\n\n— 署名：alice · 网页");
  });
});

describe("reading signatures back", () => {
  const entry = (id: number, raw: string, userId = 13): ActivityResource => ({
    id,
    createdAt: "2026-09-23T02:00:00.000Z",
    comment: { raw },
    _links: { user: { href: `/api/v3/users/${userId}` } }
  });

  it("names the identity and the agent, and hands the note back without its signature", async () => {
    const client = new FakeOpenProject([wp()]);
    client.activities = [entry(1, signed("开工", "brian", "Claude"))];
    const service = new RequirementService(client, fieldMap);

    const result = await service.activities(1, "eva-project", admin);

    expect(result.items[0]).toMatchObject({ user: "Brian", userId: 13, agent: "Claude", comment: "开工" });
  });

  // Production: the identity brian is joined to the OpenProject login admin, whose name
  // is Brian Tan, and every signed entry is journalled under that same account.
  it("follows the identity to the OpenProject account it is joined to", async () => {
    const client = new FakeOpenProject([wp()]);
    client.getUser = async id => ({ id, login: "admin", name: "Brian Tan" });
    client.activities = [entry(1, signed("", "brian", "Codex"), 4)];
    const service = new RequirementService(client, fieldMap, userId => userId === "brian" ? "admin" : null);

    const result = await service.activities(1, "eva-project", admin);

    expect(result.items[0]).toMatchObject({ user: "Brian Tan", userId: 4, agent: "Codex", comment: "" });
  });

  it("names someone other than the service's own account by their own OpenProject account", async () => {
    const client = new FakeOpenProject([wp()]);
    client.listUsers = async () => collection([{ id: 11, login: "alice", name: "Alice Wong" }]);
    client.activities = [entry(1, signed("我来", "alice", "Codex"))];
    const service = new RequirementService(client, fieldMap);

    const result = await service.activities(1, "eva-project", admin);

    expect(result.items[0]).toMatchObject({ user: "Alice Wong", userId: 11, agent: "Codex", comment: "我来" });
  });

  it("shows the id a signature gives when no account answers to it", async () => {
    const client = new FakeOpenProject([wp()]);
    client.activities = [entry(1, signed("", "ghost", "Claude"))];
    const service = new RequirementService(client, fieldMap);

    const result = await service.activities(1, "eva-project", admin);

    expect(result.items[0]).toMatchObject({ user: "ghost", userId: null, agent: "Claude" });
  });

  it("does not count a signature as a reason when only the reasons are asked for", async () => {
    const client = new FakeOpenProject([wp()]);
    client.activities = [
      entry(1, signed("", "brian", "Claude")),
      entry(2, signed("理由", "brian", "Claude")),
      { id: 3, details: [{ raw: "字段变了" }] }
    ];
    const service = new RequirementService(client, fieldMap);

    const result = await service.activities(1, "eva-project", admin, { notesOnly: true });

    expect(result.items.map(item => item.id)).toEqual([2]);
  });
});

describe("finding a requirement by its business id", () => {
  // The list shows it in a column now, and a reader handed EVAPROJECT-REQ-20260922-003
  // types a part of it (Brian 2026-09-23).
  it("asks OpenProject for the ids containing what was typed", async () => {
    const client = new FakeOpenProject([wp()]);
    const service = new RequirementService(client, fieldMap);

    await service.list({ project: "eva-project", requirementId: " 20260922-003 " }, alice);

    const filters = JSON.parse(client.listParameters.at(-1)!.filters!) as unknown[];
    expect(filters).toContainEqual({ cfId: { operator: "~", values: ["20260922-003"] } });
  });
});

describe("completing a delivery that is files outside any repository", () => {
  // #157: the work was global skills under ~/.codex, which no commit can carry, and the
  // only way to complete it was a placeholder SHA.
  const files = {
    kind: "file" as const,
    locations: ["~/.codex/skills/update-context/SKILL.md", "~/.codex/skills/resume-context/SKILL.md"],
    change: "两个交接 Skill 适配到 Codex 环境",
    verification: "在新会话里触发两个 Skill，读写交接成功",
    acceptanceStatus: "已验收" as const,
    acceptanceSource: "Brian 2026-09-23：ok，那可以标已完成了"
  };
  const commit = {
    repository: "Eva-Project",
    sha: "a".repeat(40),
    paths: ["services/mcp/src/service.ts"],
    verification: "npm test passed",
    acceptanceStatus: "不适用" as const,
    acceptanceSource: "基础设施改动，无产品验收"
  };
  const complete = (service: RequirementService, evidence: unknown[]) => service.complete({
    reference: 1, sessionId: "session-a", completedAt: "2026-09-23T14:00:00+08:00",
    evidence: evidence as never
  }, alice);

  it("completes without a repository or a commit, keeping where the files are and what changed", async () => {
    const client = new FakeOpenProject([wp({ cfClaimedSession: "session-a" })]);
    const service = new RequirementService(client, fieldMap);

    const result = await complete(service, [files]);

    expect(result.state).toBe("已完成");
    const raw = String((client.updateCalls[0]!.payload.description as { raw: string }).raw);
    expect(raw).toContain("~/.codex/skills/update-context/SKILL.md");
    expect(raw).toContain("两个交接 Skill 适配到 Codex 环境");
    expect(raw).toContain("Brian 2026-09-23：ok，那可以标已完成了");
    expect(client.comments.map(comment => comment.text))
      .toEqual(["- 2026-09-23T14:00:00+08:00：完成。交付证据 1 条，仓库外文件 2 处"]);
  });

  it("names both the commits and the outside files when a delivery has both", async () => {
    const client = new FakeOpenProject([wp({ cfClaimedSession: "session-a" })]);
    const service = new RequirementService(client, fieldMap);

    await complete(service, [commit, { ...files, locations: ["~/.claude/CLAUDE.md"] }]);

    expect(client.comments[0]!.text)
      .toBe("- 2026-09-23T14:00:00+08:00：完成。交付证据 2 条，提交 aaaaaaaaaaaa；仓库外文件 1 处");
  });

  it.each([
    ["no locations", { ...files, locations: [] }],
    ["only blank locations", { ...files, locations: ["  "] }],
    ["no description of the change", { ...files, change: " " }],
    ["no verification", { ...files, verification: "" }],
    ["no acceptance source", { ...files, acceptanceSource: "" }]
  ])("still refuses outside files with %s", async (_label, evidence) => {
    const client = new FakeOpenProject([wp({ cfClaimedSession: "session-a" })]);
    const service = new RequirementService(client, fieldMap);

    await expect(complete(service, [evidence])).rejects.toThrow(RequirementValidationError);
    expect(client.updateCalls).toHaveLength(0);
    expect(client.comments).toHaveLength(0);
  });

  it("refuses a kind of evidence it does not know", async () => {
    const client = new FakeOpenProject([wp({ cfClaimedSession: "session-a" })]);
    const service = new RequirementService(client, fieldMap);

    await expect(complete(service, [{ ...files, kind: "trust-me" }])).rejects.toThrow(/Unknown evidence kind/);
    expect(client.updateCalls).toHaveLength(0);
  });

  it("still checks a commit named as one, and refuses it without a full SHA", async () => {
    const client = new FakeOpenProject([wp({ cfClaimedSession: "session-a" })]);
    const service = new RequirementService(client, fieldMap);

    await expect(complete(service, [{ ...commit, kind: "git", sha: "不适用" }])).rejects.toThrow(/40 hex/);
    expect(client.updateCalls).toHaveLength(0);
  });

  it("leaves the other gates where they were: an unfinished required child still blocks it", async () => {
    const client = new FakeOpenProject([wp({ cfClaimedSession: "session-a" })]);
    client.children = [wp({
      id: 2, cfId: "MPR-REQ-002", cfRequired: true,
      _links: { ...wp()._links, cfState: { href: option("state", "active"), title: "进行中" } }
    })];
    const service = new RequirementService(client, fieldMap);

    await expect(complete(service, [files])).rejects.toThrow(/Required children are incomplete/);
    expect(client.updateCalls).toHaveLength(0);
  });
});

describe("home dashboard", () => {
  // Monday 2026-09-21 to the next Monday, both at midnight in +08:00.
  const from = "2026-09-20T16:00:00.000Z";
  const to = "2026-09-27T16:00:00.000Z";
  // Three weeks of trend, the last of them the chosen one.
  const edges = ["2026-09-06T16:00:00.000Z", "2026-09-13T16:00:00.000Z", from, to];
  const now = Date.parse("2026-09-23T08:00:00Z");
  const during = "2026-09-23T06:00:00Z";

  function record(id: number, spec: {
    project?: 1 | 2;
    created?: string;
    updated?: string;
    type?: [number, string];
    state: string;
    agent?: string | null;
    claimed?: string | null;
    visibility?: "公开" | "私有";
    owner?: string;
    modules?: string[];
    evidence?: string;
  }): WorkPackage {
    const base = wp();
    const project = spec.project ?? 1;
    const visibility = spec.visibility ?? "公开";
    const agent = spec.agent === undefined ? "Codex" : spec.agent;
    return wp({
      id,
      cfId: `MPR-REQ-${id}`,
      createdAt: spec.created ?? during,
      updatedAt: spec.updated ?? spec.created ?? during,
      cfClaimedSession: spec.claimed ?? null,
      cfOwnerUserId: spec.owner ?? "alice",
      description: {
        format: "markdown",
        raw: `## 用户原文\n\n> text\n\n## 交付证据\n\n${spec.evidence ?? "尚无。"}`
      },
      _links: {
        ...base._links,
        project: { href: `/api/v3/projects/${project}`, title: project === 1 ? "Eva-Project Requirements" : "Mila 3 Requirements" },
        ...(spec.type ? { type: { href: `/api/v3/types/${spec.type[0]}`, title: spec.type[1] } } : {}),
        cfState: { href: option("state", spec.state), title: spec.state },
        cfResponsible: agent === null ? { href: null } : { href: option("responsible", agent.toLowerCase()), title: agent },
        cfVisibility: {
          href: option("visibility", visibility === "公开" ? "public" : "private"),
          title: visibility
        },
        ...(spec.modules ? { cfModules: spec.modules.map(module => ({ href: option("module", module), title: module })) } : {})
      }
    });
  }

  function pool(): FakeOpenProject {
    const client = new FakeOpenProject([
      record(1, { type: [7, "Bug"], state: "进行中", agent: "Claude", claimed: "s1", updated: "2026-09-23T07:00:00Z" }),
      record(2, { type: [4, "Feature"], state: "待认领" }),
      // Finished work keeps its claim.
      record(3, { type: [1, "Task"], state: "已完成", agent: "Claude", claimed: "s3",
        updated: "2026-09-22T10:00:00Z", evidence: "完成时间：2026-09-22T10:00:00Z" }),
      record(4, { type: [4, "Feature"], state: "取消", agent: null, updated: "2026-09-21T00:00:00Z" }),
      // The second before the chosen week: in the pool, not in the week.
      record(5, { type: [7, "Bug"], state: "待认领", created: "2026-09-20T15:59:59Z" }),
      record(6, { type: [4, "Feature"], state: "待认领", visibility: "私有", owner: "bob" }),
      record(7, { type: [9, "交接"], state: "待认领" }),
      // The chosen week's end belongs to the next one.
      record(8, { type: [4, "Feature"], state: "待认领", created: to, updated: "2026-09-23T05:00:00Z" }),
      record(9, { project: 2, type: [1, "Task"], state: "待验证/验收", agent: "Mila", claimed: "s9",
        updated: "2026-09-10T00:00:00Z" }),
      // Held and untouched for three weeks.
      record(10, { type: [4, "Feature"], state: "进行中", agent: "Claude", claimed: "s10", created: "2026-09-01T00:00:00Z" }),
      record(11, { type: [4, "Feature"], state: "待确认", agent: null, created: "2026-09-08T00:00:00Z", modules: [] }),
      // Finished with no 完成时间 on record: its completion has no period.
      record(12, { type: [1, "Task"], state: "已完成", created: "2026-09-02T00:00:00Z" }),
      // Completed, reopened and completed again: the later completion is the one.
      record(13, { type: [1, "Task"], state: "已完成", created: "2026-09-03T00:00:00Z", updated: "2026-09-15T00:00:00Z",
        evidence: "完成时间：2026-09-08T00:00:00Z\n\n完成时间：2026-09-15T00:00:00Z" })
    ]);
    client.scopeByProject = true;
    return client;
  }

  const dashboard = (service: RequirementService, principal: Principal) =>
    service.dashboard({ from, to, edges, now }, principal);

  it("counts the pool as it stands, whenever its requirements were created", async () => {
    const result = await dashboard(new RequirementService(pool(), handoffAwareFieldMap), alice);

    const mProject = result.projects.find(project => project.identifier === "eva-project");
    expect(mProject?.current).toMatchObject({
      total: 10,
      bugs: 2,
      // #2, #5, #8 and #11; claimed, finished and cancelled ones wait for nobody.
      unclaimed: 4,
      states: { 进行中: 2, 待认领: 3, 已完成: 3, 取消: 1, 待确认: 1 }
    });
    // Codex is the one Agent this field map lists, so it leads; Claude is not listed and
    // still gets its row; unassigned comes last.
    expect(mProject?.current.agents.map(row => [row.agent, row.total])).toEqual([["Codex", 5], ["Claude", 3], [null, 2]]);
    // Unfinished work only, and a requirement with no module is counted as such.
    expect(mProject?.current.modules).toEqual([{ module: "Runtime", open: 5 }, { module: null, open: 1 }]);
    expect(result.all.current.total).toBe(11);
  });

  it("counts what was created in the chosen period by its state now", async () => {
    const result = await dashboard(new RequirementService(pool(), handoffAwareFieldMap), alice);

    expect(result.projects.find(project => project.identifier === "eva-project")?.period).toMatchObject({
      total: 4, bugs: 1, unclaimed: 1, states: { 进行中: 1, 待认领: 1, 已完成: 1, 取消: 1 }
    });
    expect(result.projects.find(project => project.identifier === "mila-3")?.period).toMatchObject({
      total: 1, agents: [{ agent: "Mila", total: 1 }]
    });
  });

  it("lays out a trend of what was created and what was completed in each period", async () => {
    const result = await dashboard(new RequirementService(pool(), handoffAwareFieldMap), alice);

    expect(result.all.trend).toEqual({
      buckets: [
        { created: 1, createdBugs: 0, completed: 0 },
        { created: 1, createdBugs: 1, completed: 1 },
        { created: 5, createdBugs: 1, completed: 1 }
      ],
      undatedCompletions: 1
    });
  });

  it("lists what waits on someone, longest waiting first, and what changed last", async () => {
    const result = await dashboard(new RequirementService(pool(), handoffAwareFieldMap), alice);

    const ids = (list: { items: Array<{ workPackageId: number }> }) => list.items.map(item => item.workPackageId);
    expect(result.all.attention.acceptance.total).toBe(1);
    expect(result.all.attention.acceptance.items[0]).toMatchObject({ workPackageId: 9, project: "mila-3", state: "待验证/验收" });
    expect(ids(result.all.attention.confirmation)).toEqual([11]);
    // #1 is in progress too, but it moved today.
    expect(ids(result.all.attention.stale)).toEqual([10]);
    expect(result.staleDays).toBe(7);
    expect(result.all.recent.map(item => item.workPackageId)).toEqual([1, 2, 8, 3, 4, 5, 13, 9]);
    expect(result.all.recent[0]?.project).toBe("eva-project");
  });

  it("counts and lists someone else's private requirement only for its owner", async () => {
    const service = new RequirementService(pool(), handoffAwareFieldMap);

    const forAlice = await dashboard(service, alice);
    const forBob = await dashboard(service, bob);

    expect(forAlice.all.current.total).toBe(11);
    expect(forBob.all.current.total).toBe(12);
    expect(forBob.all.period.total).toBe(6);
    expect(forAlice.all.recent.some(item => item.workPackageId === 6)).toBe(false);
    expect(forBob.all.recent.some(item => item.workPackageId === 6)).toBe(true);
  });

  it("reads the whole pool once per project and leaves handoffs out", async () => {
    const client = pool();
    const service = new RequirementService(client, handoffAwareFieldMap);

    await dashboard(service, alice);

    for (const parameters of client.listParameters) {
      const filters = parseFilters(parameters.filters);
      expect(filters).toContainEqual({ type: { operator: "!", values: ["9"] } });
      expect(filters.some(filter => "createdAt" in filter)).toBe(false);
    }
  });

  it("refuses a period that does not end after it starts, and trend edges out of order", async () => {
    const service = new RequirementService(pool(), handoffAwareFieldMap);

    await expect(service.dashboard({ from: to, to: from }, alice)).rejects.toThrow(/from before to/);
    await expect(service.dashboard({ from: "", to }, alice)).rejects.toThrow(/timestamps/);
    await expect(service.dashboard({ from, to, edges: [to, from] }, alice)).rejects.toThrow(/ascending/);
    await expect(service.dashboard({ from, to, edges: [from] }, alice)).rejects.toThrow(/ascending/);
  });
});

describe("the top bar's search (#218)", () => {
  const types = {
    feature: { href: "/api/v3/types/4", title: "Feature" },
    handoff: { href: "/api/v3/types/9", title: "交接" }
  };
  const visibility = {
    公开: { href: option("visibility", "public"), title: "公开" },
    私有: { href: option("visibility", "private"), title: "私有" }
  };

  function record(id: number, fields: {
    title?: string;
    body?: string;
    businessId?: string;
    owner?: string;
    visible?: "公开" | "私有";
    project?: number;
    handoff?: boolean;
    extra?: Partial<WorkPackage>;
  } = {}): WorkPackage {
    const base = wp();
    const project = PROJECTS.find(item => item.id === (fields.project ?? 1))!;
    return wp({
      id,
      subject: fields.title ?? `Record ${id}`,
      description: { format: "markdown", raw: fields.body ?? "" },
      cfId: fields.businessId ?? `MPR-REQ-${id}`,
      cfOwnerUserId: fields.owner ?? "alice",
      ...fields.extra,
      _links: {
        ...base._links,
        project: { href: `/api/v3/projects/${project.id}`, title: project.name },
        type: fields.handoff ? types.handoff : types.feature,
        cfVisibility: visibility[fields.visible ?? "公开"]
      }
    });
  }

  const ids = (group: { items: Array<{ workPackageId: number }> } | undefined) =>
    group?.items.map(item => item.workPackageId);

  // #43 on the local instance: 地基 in its title and 解析器 in its body, and OpenProject's own
  // full-text filter found nothing for the two together.
  it("finds a record whose words sit in different fields", async () => {
    const client = new FakeOpenProject([
      record(43, { title: "交接功能：地基完成", body: "## 主线\n\n解析器已完成" }),
      record(44, { title: "地基", body: "别的内容" })
    ]);
    const service = new RequirementService(client, handoffAwareFieldMap);

    const result = await service.search({ query: "地基 解析器" }, admin);

    expect(ids(result.groups.requirements)).toEqual([43]);
    expect(result.groups.requirements?.items[0]?.matched).toEqual(["title", "body"]);
  });

  it("finds words written in a comment, and says that is where", async () => {
    const client = new FakeOpenProject([record(57, { title: "自建需求池页面" })]);
    client.comments = [{ workPackageId: 57, text: "在这页直接留言，不用去原生页面。" }];
    const service = new RequirementService(client, handoffAwareFieldMap);

    const result = await service.search({ query: "直接留言" }, admin);

    expect(result.groups.requirements?.items[0]).toMatchObject({ workPackageId: 57, matched: ["comment"], snippet: null });
  });

  // Brian 2026-09-24: 标题、编号、正文和评论. OpenProject's own filter also read the text custom
  // fields, and "brian" then matched every record through its owner.
  it("reads the business id, title, body and comments, and no other field", async () => {
    const client = new FakeOpenProject([
      record(1, { owner: "brian", extra: { cfRequesterName: "Brian" } }),
      record(2, { body: "Brian 2026-09-24 定的" }),
      record(3, { businessId: "EVAPROJECT-REQ-20260924-006" })
    ]);
    const service = new RequirementService(client, handoffAwareFieldMap);

    expect(ids((await service.search({ query: "brian" }, admin)).groups.requirements)).toEqual([2]);
    expect(ids((await service.search({ query: "20260924-006" }, admin)).groups.requirements)).toEqual([3]);
  });

  it("never shows or counts someone else's private record", async () => {
    const client = new FakeOpenProject([
      record(1, { title: "搜索 公开", owner: "bob" }),
      record(2, { title: "搜索 bob 私有", owner: "bob", visible: "私有" }),
      record(3, { title: "搜索 alice 私有", owner: "alice", visible: "私有" })
    ]);
    const service = new RequirementService(client, handoffAwareFieldMap);

    const result = await service.search({ query: "搜索" }, alice);

    expect(ids(result.groups.requirements)).toEqual([3, 1]);
    expect(result.groups.requirements?.total).toBe(2);
  });

  it("looks only in the projects the caller may see", async () => {
    const client = new FakeOpenProject([
      record(1, { title: "搜索", project: 1 }),
      record(2, { title: "搜索", project: 2 })
    ]);
    client.visibleProjects = new Map([[11, [1]]]);
    const service = new RequirementService(client, handoffAwareFieldMap);

    const result = await service.search({ query: "搜索" }, alice);

    expect(ids(result.groups.requirements)).toEqual([1]);
    expect(result.groups.requirements?.items[0]).toMatchObject({ project: "eva-project", projectName: "Eva-Project Requirements" });
  });

  it("answers requirements and handoffs as two groups, each with its own total", async () => {
    const client = new FakeOpenProject([
      record(1, { title: "分页" }),
      record(2, { title: "分页", handoff: true }),
      record(3, { body: "分页的交接", handoff: true })
    ]);
    const service = new RequirementService(client, handoffAwareFieldMap);

    const result = await service.search({ query: "分页" }, admin);

    expect(result.groups.requirements).toMatchObject({ total: 1 });
    expect(result.groups.handoffs).toMatchObject({ total: 2 });
    expect(result.groups.handoffs?.items.every(item => item.kind === "handoff")).toBe(true);
  });

  it("puts a match on the business id first, then one on the title, then the newest", async () => {
    const client = new FakeOpenProject([
      record(20, { businessId: "MPR-SEARCH-1" }),
      record(21, { title: "search box" }),
      record(22, { body: "search" }),
      record(23, { body: "search" })
    ]);
    const service = new RequirementService(client, handoffAwareFieldMap);

    const result = await service.search({ query: "SEARCH" }, admin);

    expect(ids(result.groups.requirements)).toEqual([20, 21, 23, 22]);
  });

  it("pages one group on its own", async () => {
    const client = new FakeOpenProject(
      Array.from({ length: 25 }, (_, index) => record(index + 1, { title: `分组 ${index + 1}` }))
    );
    const service = new RequirementService(client, handoffAwareFieldMap);

    const result = await service.search({ query: "分组", group: "requirements", page: 3, pageSize: 10 }, admin);

    expect(Object.keys(result.groups)).toEqual(["requirements"]);
    expect(result.groups.requirements).toMatchObject({ total: 25, page: 3, pageSize: 10 });
    expect(ids(result.groups.requirements)).toEqual([5, 4, 3, 2, 1]);
  });

  it("finds a work package by its number, ahead of the records that mention it", async () => {
    const client = new FakeOpenProject([
      record(57, { title: "自建需求池页面" }),
      record(60, { body: "接着 #57 做" })
    ]);
    const service = new RequirementService(client, handoffAwareFieldMap);

    expect(ids((await service.search({ query: "#57" }, admin)).groups.requirements)).toEqual([57, 60]);
  });

  it("shows the body around the first match as plain text", async () => {
    const client = new FakeOpenProject([record(57, {
      body: "## Agent 理解\n\n原生工作包页面要穿八层才能读一条需求。自建页面做成**一屏到底**：左表右详情。"
    })]);
    const service = new RequirementService(client, handoffAwareFieldMap);

    const hit = (await service.search({ query: "一屏到底" }, admin)).groups.requirements?.items[0];

    expect(hit?.snippet).toBe("Agent 理解 原生工作包页面要穿八层才能读一条需求。自建页面做成一屏到底：左表右详情。");
    expect(searchSnippet(`${"前".repeat(100)}命中${"后".repeat(200)}`, ["命中"]))
      .toBe(`…${"前".repeat(40)}命中${"后".repeat(90)}…`);
    // Cut at the edges of a word, not through one.
    const latin = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
    const around = searchSnippet(`${latin} needle ${latin} ${latin}`, ["needle"]) ?? "";
    const pieces = around.replace(/^…|…$/g, "").split(" ");
    expect(latin.split(" ")).toContain(pieces[0]);
    expect(latin.split(" ")).toContain(pieces.at(-1));
  });

  it("searches one project when one is named", async () => {
    const client = new FakeOpenProject([
      record(1, { title: "搜索", project: 1 }),
      record(2, { title: "搜索", project: 2 })
    ]);
    const service = new RequirementService(client, handoffAwareFieldMap);

    const result = await service.search({ query: "搜索", project: "mila-3" }, admin);

    expect(ids(result.groups.requirements)).toEqual([2]);
    await expect(service.search({ query: "搜索", project: "no-such-project" }, admin)).rejects.toThrow(/not found/);
  });

  it("asks OpenProject nothing for an empty query", async () => {
    const client = new FakeOpenProject([record(1)]);
    const service = new RequirementService(client, handoffAwareFieldMap);

    const result = await service.search({ query: "   " }, admin);

    expect(result.groups).toEqual({
      requirements: { total: 0, page: 1, pageSize: 20, items: [] },
      handoffs: { total: 0, page: 1, pageSize: 20, items: [] }
    });
    expect(client.globalListParameters).toEqual([]);
  });
});
