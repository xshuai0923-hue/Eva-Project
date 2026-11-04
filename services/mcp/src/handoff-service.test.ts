import { describe, expect, it } from "vitest";

import { HandoffService, type SaveHandoffInput } from "./handoff-service.js";
import { OpenProjectHttpError, type OpenProjectApi } from "./openproject.js";
import { RequirementConflictError } from "./record-service.js";
import type {
  Attachment,
  FieldMap,
  HalCollection,
  Principal,
  ProjectResource,
  Relation,
  WorkPackage,
  WorkPackageType
} from "./types.js";

const option = (field: string, value: string) => `/api/v3/custom_options/${field}-${value}`;

const PROJECTS: ProjectResource[] = [{ id: 1, identifier: "eva-project", name: "Eva-Project" }];

/** Reads one filter out of an API v3 filters parameter. */
const readFilter = (raw: string | undefined, key: string): { operator: string; values: string[] } | null => {
  if (!raw) return null;
  for (const filter of JSON.parse(raw) as Array<Record<string, { operator: string; values: string[] }>>) {
    const spec = filter[key];
    if (spec) return spec;
  }
  return null;
};

const alice: Principal = { userId: "alice", displayName: "Alice", role: "user" };
const bob: Principal = { userId: "bob", displayName: "Bob", role: "user" };

const HANDOFF_TYPE = "/api/v3/types/9";

const fieldMap: FieldMap = {
  defaultProjectIdentifier: "eva-project",
  typeHref: "/api/v3/types/1",
  handoffTypeHref: HANDOFF_TYPE,
  handoffStatusHrefs: {
    草稿: "/api/v3/statuses/1",
    待接手: "/api/v3/statuses/1",
    已接手: "/api/v3/statuses/2",
    已归档: "/api/v3/statuses/3",
    已作废: "/api/v3/statuses/4"
  },
  handoffCompletionStates: ["已归档", "已作废"],
  fields: {
    requirementId: { key: "cfId", kind: "text" },
    ownerUserId: { key: "cfOwner", kind: "text" },
    visibility: { key: "cfVisibility", kind: "list", options: { 公开: option("v", "public"), 私有: option("v", "private") } },
    modules: { key: "cfModules", kind: "list", multi: true, options: { 开发流程: option("m", "process") } },
    sourceSessionId: { key: "cfSourceSession", kind: "text" },
    claimedAgent: { key: "cfClaimedAgent", kind: "list", options: { Claude: option("a", "claude"), Codex: option("a", "codex") } },
    claimedSession: { key: "cfClaimedSession", kind: "text" },
    claimLabel: { key: "cfClaimLabel", kind: "text" },
    claimedAt: { key: "cfClaimedAt", kind: "text" },
    claimScope: { key: "cfClaimScope", kind: "text" },
    state: { key: "cfState", kind: "list", options: { 进行中: option("s", "active"), "待验证/验收": option("s", "verify") } },
    handoffThread: { key: "cfThread", kind: "text" },
    handoffState: {
      key: "cfHandoffState",
      kind: "list",
      options: {
        草稿: option("hs", "draft"),
        待接手: option("hs", "await"),
        已接手: option("hs", "taken"),
        已归档: option("hs", "archived"),
        已作废: option("hs", "void")
      }
    },
    handoffPrevious: { key: "cfPrevious", kind: "text" },
    handoffExpectedAgent: {
      key: "cfExpected",
      kind: "list",
      options: { Codex: option("e", "codex"), Claude: option("e", "claude"), 不限: option("e", "any") }
    },
    handoffRepository: { key: "cfRepo", kind: "text" },
    handoffBranch: { key: "cfBranch", kind: "text" },
    handoffBaseCommit: { key: "cfBase", kind: "text" },
    handoffTodoTotal: { key: "cfTodoTotal", kind: "int" },
    handoffTodoDone: { key: "cfTodoDone", kind: "int" }
  },
  statusHrefs: { 待认领: "/api/v3/statuses/1" },
  completionStates: ["已完成"]
};

function collection<T>(elements: T[]): HalCollection<T> {
  return { total: elements.length, count: elements.length, pageSize: 200, offset: 1, _embedded: { elements } };
}

/** Applies the same filters the real API would, so server-side filtering is exercised. */
function matches(item: WorkPackage, filters: Array<Record<string, unknown>>): boolean {
  return filters.every(filter => {
    const [key, spec] = Object.entries(filter)[0] as [string, { operator: string; values: string[] }];
    if (key === "type") {
      const link = Array.isArray(item._links.type) ? undefined : item._links.type;
      const id = link?.href?.split("/").at(-1) ?? null;
      const hit = id !== null && spec.values.includes(id);
      return spec.operator === "!" ? !hit : hit;
    }
    const value = item[key];
    if (typeof value === "string") {
      return spec.operator === "~" ? value.includes(spec.values[0] ?? "") : spec.values.includes(value);
    }
    const link = Array.isArray(item._links[key]) ? undefined : item._links[key];
    const id = link?.href?.split("/").at(-1) ?? null;
    return id !== null && spec.values.includes(id);
  });
}

/** The real API echoes a list value's human title back; the fake has to as well. */
const OPTION_TITLES = new Map<string, string>(
  Object.values(fieldMap.fields).flatMap(field =>
    Object.entries(field.options ?? {}).map(([title, href]) => [href, title] as [string, string]))
);

function titled(links: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(links).map(([key, value]) => {
    const withTitle = (link: unknown) => {
      const href = (link as { href?: string } | null)?.href;
      const title = href ? OPTION_TITLES.get(href) : undefined;
      return title ? { href, title } : link;
    };
    return [key, Array.isArray(value) ? value.map(withTitle) : withTitle(value)];
  }));
}

class FakeOpenProject implements OpenProjectApi {
  async canCreateWorkPackages(): Promise<boolean> { return true; }
  async canEditWorkPackages(): Promise<boolean> { return true; }
  workPackages = new Map<number, WorkPackage>();
  createCalls: Array<{ projectId: number; payload: Record<string, unknown> }> = [];
  updateCalls: Array<{ id: number; payload: Record<string, unknown> }> = [];
  relationCalls: Array<{ fromId: number; toId: number; type: string }> = [];
  private nextId = 100;

  constructor(initial: WorkPackage[] = []) {
    for (const item of initial) this.workPackages.set(item.id, item);
  }

  async getProject(identifier: string | number): Promise<ProjectResource> {
    if (String(identifier) === "eva-project" || String(identifier) === "1") {
      return { id: 1, identifier: "eva-project", name: "Eva-Project" };
    }
    throw new Error("unknown project");
  }
  async listProjectTypes(): Promise<HalCollection<WorkPackageType>> {
    return collection([{ id: 1, name: "Task" }, { id: 9, name: "交接" }]);
  }
  async createProject(): Promise<ProjectResource> { throw new Error("unused"); }
  async listProjectRoles(): Promise<never> { throw new Error("unused"); }
  async createProjectMembership(): Promise<never> { throw new Error("unused"); }
  async getMembership(): Promise<never> { throw new Error("unused"); }
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
    let projects: ProjectResource[] = PROJECTS;
    const visible = readFilter(parameters.filters, "visible")?.values[0];
    if (visible !== undefined && this.visibleProjects) {
      const allowed = this.visibleProjects.get(Number(visible)) ?? [];
      projects = projects.filter(project => allowed.includes(project.id));
    }
    const wanted = readFilter(parameters.filters, "id")?.values;
    if (wanted) projects = projects.filter(project => wanted.includes(String(project.id)));
    return collection(projects);
  }
  async getWorkPackage(id: number): Promise<WorkPackage> {
    const item = this.workPackages.get(id);
    if (!item) throw new Error(`not found: ${id}`);
    return item;
  }
  async listProjectWorkPackages(_projectId: number, parameters: Record<string, string>): Promise<HalCollection<WorkPackage>> {
    const filters = parameters.filters
      ? JSON.parse(parameters.filters) as Array<Record<string, unknown>>
      : [];
    return collection([...this.workPackages.values()].filter(item => matches(item, filters)));
  }
  async listWorkPackages(): Promise<HalCollection<WorkPackage>> { throw new Error("unused"); }
  async createWorkPackage(projectId: number, payload: Record<string, unknown>): Promise<WorkPackage> {
    this.createCalls.push({ projectId, payload });
    const links = (payload._links ?? {}) as Record<string, unknown>;
    const created: WorkPackage = {
      id: this.nextId++,
      lockVersion: 0,
      subject: String(payload.subject ?? ""),
      description: payload.description as WorkPackage["description"],
      updatedAt: "2026-09-21T22:00:00+08:00",
      ...Object.fromEntries(Object.entries(payload).filter(([key]) => key.startsWith("cf"))),
      _links: titled({ project: { href: "/api/v3/projects/1", title: "eva-project" }, ...links }) as WorkPackage["_links"]
    };
    this.workPackages.set(created.id, created);
    return created;
  }
  async updateWorkPackage(id: number, payload: Record<string, unknown>): Promise<WorkPackage> {
    this.updateCalls.push({ id, payload });
    const current = this.workPackages.get(id);
    if (!current) throw new Error("not found");
    if (payload.lockVersion !== current.lockVersion) throw new OpenProjectHttpError(409, "conflict", {});
    const links = (payload._links ?? {}) as Record<string, unknown>;
    const updated: WorkPackage = {
      ...current,
      lockVersion: current.lockVersion + 1,
      description: (payload.description as WorkPackage["description"]) ?? current.description,
      ...Object.fromEntries(Object.entries(payload).filter(([key]) => key.startsWith("cf"))),
      _links: titled({ ...current._links, ...links }) as WorkPackage["_links"]
    };
    this.workPackages.set(id, updated);
    return updated;
  }
  async listRelations(): Promise<HalCollection<Relation>> { return collection([]); }
  async createRelation(fromId: number, toId: number, type: "blocks" | "requires" | "relates"): Promise<Relation> {
    this.relationCalls.push({ fromId, toId, type });
    return { id: 1, type, _links: { from: { href: `/api/v3/work_packages/${fromId}` }, to: { href: `/api/v3/work_packages/${toId}` } } };
  }
  async listAttachments(): Promise<Attachment[]> { return []; }
  async uploadAttachment(): Promise<Attachment> { throw new Error("unused"); }
  async uploadMarkdown(): Promise<Attachment> { throw new Error("unused"); }
  async readAttachment(): Promise<string> { throw new Error("unused"); }
}

function saveInput(overrides: Partial<SaveHandoffInput> = {}): SaveHandoffInput {
  return {
    project: "eva-project",
    id: "EVAPROJECT-HO-20260921-001",
    title: "交接功能设计与地基",
    thread: "eva-project/交接功能",
    sections: {
      背景: "为 Session 之间的上下文交接建模。",
      主线: "解析器与需求侧排除已完成。",
      现状: "本地实例已跑通。",
      待办: "- [x] (T1) 写解析器 · 状态:已完成\n- [ ] (T2) 写工具 · 需求:MPR-REQ-1 · 状态:进行中",
      注意事项: "正式环境等 Brian 通知才升级。"
    },
    repository: "Eva-Project",
    branch: "main",
    baseCommit: "390fe27f7b63ba34a486567dd12d507f035d263e",
    sourceSessionId: "session-a",
    requestId: "req-1",
    modules: ["开发流程"],
    visibility: "私有",
    ...overrides
  };
}

const requirement = (id: number, requirementId: string, state: string): WorkPackage => ({
  id,
  lockVersion: 1,
  subject: "某需求",
  cfId: requirementId,
  cfOwner: "alice",
  updatedAt: "2026-09-21T10:00:00+08:00",
  _links: {
    type: { href: "/api/v3/types/1", title: "Task" },
    project: { href: "/api/v3/projects/1", title: "eva-project" },
    cfVisibility: { href: option("v", "public"), title: "公开" },
    cfState: { href: option("s", state === "进行中" ? "active" : "verify"), title: state }
  }
});

describe("writing a handoff", () => {
  it("pages 51 handoffs without losing the final record and searches within the project", async () => {
    const service = new HandoffService(new FakeOpenProject(), fieldMap);
    for (let index = 0; index < 51; index++) await service.save(saveInput({
      id: `HO-${index}`, requestId: `create-${index}`, thread: `thread-${index}`, title: `交接 ${index}`
    }), alice);
    const first = await service.list({ project: "eva-project", pageSize: 50 }, alice);
    expect(first.items).toHaveLength(50); expect(first.total).toBe(51); expect(first.nextCursor).toBe("2");
    const second = await service.list({ project: "eva-project", pageSize: 50, cursor: first.nextCursor! }, alice);
    expect(second.items).toHaveLength(1); expect(second.nextCursor).toBe(null);
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(51);
    const found = await service.list({ project: "eva-project", query: "thread-50" }, alice);
    expect(found.items.map(item => item.id)).toEqual(["HO-50"]);
  });
  it("stores it as a handoff awaiting pickup with counts taken from the list", async () => {
    const client = new FakeOpenProject();
    const service = new HandoffService(client, fieldMap);

    const result = await service.save(saveInput(), alice);

    expect(result.replayed).toBe(false);
    expect(result.item.thread).toBe("eva-project/交接功能");
    expect(result.item.handoffState).toBe("待接手");
    expect(result.item.todoTotal).toBe(2);
    expect(result.item.todoDone).toBe(1);
    expect((client.createCalls[0]!.payload._links as Record<string, unknown>).type)
      .toEqual({ href: HANDOFF_TYPE });
  });

  it("records the checkout so the next session can verify where it is", async () => {
    const service = new HandoffService(new FakeOpenProject(), fieldMap);

    const result = await service.save(saveInput(), alice);

    expect(result.item.repository).toBe("Eva-Project");
    expect(result.item.branch).toBe("main");
    expect(result.item.baseCommit).toBe("390fe27f7b63ba34a486567dd12d507f035d263e");
  });

  it("defaults to any agent so a handoff Claude wrote can be picked up by Codex", async () => {
    const service = new HandoffService(new FakeOpenProject(), fieldMap);

    expect((await service.save(saveInput(), alice)).item.expectedAgent).toBe("不限");
  });

  it("replays instead of creating a second record for the same id", async () => {
    const client = new FakeOpenProject();
    const service = new HandoffService(client, fieldMap);

    await service.save(saveInput(), alice);
    const again = await service.save(saveInput(), alice);

    expect(again.replayed).toBe(true);
    expect(client.createCalls).toHaveLength(1);
  });

  it("refuses to leave two unclaimed handoffs on one thread", async () => {
    const service = new HandoffService(new FakeOpenProject(), fieldMap);
    await service.save(saveInput(), alice);

    await expect(service.save(saveInput({ id: "EVAPROJECT-HO-20260921-002" }), alice))
      .rejects.toThrow(RequirementConflictError);
  });

  it("archives the previous handoff when superseding it", async () => {
    const service = new HandoffService(new FakeOpenProject(), fieldMap);
    const first = await service.save(saveInput(), alice);

    await service.save(saveInput({ id: "EVAPROJECT-HO-20260921-002", supersede: true }), alice);

    const detail = await service.get({ project: "eva-project", reference: first.item.workPackageId }, alice);
    expect((detail.handoff as Record<string, unknown>).handoffState).toBe("已归档");
  });

  it("leaves exactly one handoff awaiting pickup after superseding", async () => {
    const service = new HandoffService(new FakeOpenProject(), fieldMap);
    await service.save(saveInput(), alice);
    await service.save(saveInput({ id: "EVAPROJECT-HO-20260921-002", supersede: true }), alice);

    const waiting = await service.list({ project: "eva-project", state: "待接手" }, alice);
    expect(waiting.items.map(item => item.id)).toEqual(["EVAPROJECT-HO-20260921-002"]);
  });

  it("archives the predecessor it continues, even when that one was claimed", async () => {
    const service = new HandoffService(new FakeOpenProject(), fieldMap);
    const first = await service.save(saveInput(), alice);
    await service.claim({ expectedLockVersion: 0,
      project: "eva-project", reference: first.item.workPackageId, agent: "Codex",
      sessionId: "s1", label: "接手", scope: "范围", claimedAt: "2026-09-22T09:00:00+08:00"
    }, alice);

    await service.save(saveInput({
      id: "EVAPROJECT-HO-20260921-004", previous: first.item.id ?? undefined
    }), alice);

    const detail = await service.get({ project: "eva-project", reference: first.item.workPackageId }, alice);
    expect((detail.handoff as Record<string, unknown>).handoffState).toBe("已归档");
  });

  it("leaves a predecessor that is already archived alone", async () => {
    const client = new FakeOpenProject();
    const service = new HandoffService(client, fieldMap);
    const first = await service.save(saveInput(), alice);
    await service.updateState({ expectedLockVersion: 0,
      project: "eva-project", reference: first.item.workPackageId, state: "已作废",
      note: "作废", changedAt: "2026-09-22T09:00:00+08:00"
    }, alice);
    const before = client.updateCalls.length;

    await service.save(saveInput({
      id: "EVAPROJECT-HO-20260921-005", previous: first.item.id ?? undefined
    }), alice);

    const detail = await service.get({ project: "eva-project", reference: first.item.workPackageId }, alice);
    expect((detail.handoff as Record<string, unknown>).handoffState).toBe("已作废");
    expect(client.updateCalls.length).toBe(before);
  });

  it("keeps a separate thread free of the first thread's pending handoff", async () => {
    const service = new HandoffService(new FakeOpenProject(), fieldMap);
    await service.save(saveInput(), alice);

    const other = await service.save(saveInput({
      id: "EVAPROJECT-HO-20260921-003",
      thread: "EVAPROJECT-REQ-20260919-001"
    }), alice);

    expect(other.item.thread).toBe("EVAPROJECT-REQ-20260919-001");
  });
});

describe("picking a handoff up", () => {
  const setup = async () => {
    const client = new FakeOpenProject();
    const service = new HandoffService(client, fieldMap);
    const saved = await service.save(saveInput(), alice);
    return { client, service, reference: saved.item.workPackageId };
  };
  const claim = (extra: Record<string, unknown> = {}) => ({
    project: "eva-project",
    agent: "Codex",
    sessionId: "session-b",
    label: "接手交接功能",
    scope: "继续 MCP 工具",
    claimedAt: "2026-09-21T23:00:00+08:00",
    ...extra
  });

  it("returns a compact digest with only the open todos", async () => {
    const { service } = await setup();

    const digest = await service.latest({ project: "eva-project", thread: "eva-project/交接功能" }, alice);

    expect((digest?.openTodos as unknown[]).length).toBe(1);
    expect(digest?.openTodoCount).toBe(1);
    expect(digest?.truncated).toBe(false);
    expect(digest).not.toHaveProperty("sections.背景");
  });

  it("returns nothing for a thread with no handoff waiting", async () => {
    const { service } = await setup();

    expect(await service.latest({ project: "eva-project", thread: "不存在的线程" }, alice)).toBeNull();
  });

  it("claims atomically and moves the handoff to 已接手", async () => {
    const { service, reference } = await setup();

    const result = await service.claim({ expectedLockVersion: 0, ...claim(), reference } as never, alice);

    expect(result.item.claimedSession).toBe("session-b");
    expect(result.item.handoffState).toBe("已接手");
  });

  it("refuses a second session and does not preempt the first", async () => {
    const { service, reference } = await setup();
    await service.claim({ expectedLockVersion: 0, ...claim(), reference } as never, alice);

    await expect(service.claim({ expectedLockVersion: 1, ...claim({ sessionId: "session-c" }), reference } as never, alice))
      .rejects.toThrow(/already claimed by session session-b/);
  });

  it("replays for the same session instead of failing", async () => {
    const { service, reference } = await setup();
    await service.claim({ expectedLockVersion: 0, ...claim(), reference } as never, alice);

    expect((await service.claim({ expectedLockVersion: 0, ...claim(), reference } as never, alice)).replayed).toBe(true);
  });

  it("guards a named expected agent but lets an explicit override through", async () => {
    const client = new FakeOpenProject();
    const service = new HandoffService(client, fieldMap);
    const saved = await service.save(saveInput({ expectedAgent: "Claude" }), alice);
    const reference = saved.item.workPackageId;

    await expect(service.claim({ expectedLockVersion: 0, ...claim(), reference } as never, alice))
      .rejects.toThrow(/expects agent Claude/);

    const forced = await service.claim({ expectedLockVersion: 0, ...claim({ override: true }), reference } as never, alice);
    expect(forced.item.claimedAgent).toBe("Codex");
  });
});

describe("a claim left behind by a session that is gone", () => {
  const setup = async () => {
    const client = new FakeOpenProject();
    const service = new HandoffService(client, fieldMap);
    const saved = await service.save(saveInput(), alice);
    const reference = saved.item.workPackageId;
    await service.claim({ expectedLockVersion: 0,
      project: "eva-project", reference, agent: "Claude", sessionId: "dead-session",
      label: "接手", scope: "范围", claimedAt: "2026-09-21T23:00:00+08:00"
    }, alice);
    return { client, service, reference };
  };
  const release = (extra: Record<string, unknown> = {}) => ({
    project: "eva-project", sessionId: "session-c", reason: "上一任已失联",
    releasedAt: "2026-09-22T09:00:00+08:00", ...extra
  });

  it("is not released by another session by default", async () => {
    const { service, reference } = await setup();

    await expect(service.release({ expectedLockVersion: 1, ...release(), reference } as never, alice))
      .rejects.toThrow(/claimed by session dead-session/);
  });

  it("is released by the owner with an explicit takeover, returning the thread to 待接手", async () => {
    const { service, reference } = await setup();

    const result = await service.release({ expectedLockVersion: 1, ...release({ takeover: true }), reference } as never, alice);

    expect(result.claimedSession).toBeNull();
    expect(result.handoffState).toBe("待接手");
  });

  it("is not released by someone who does not own it", async () => {
    const { service, reference } = await setup();

    await expect(service.release({ expectedLockVersion: 1, ...release({ takeover: true }), reference } as never, bob))
      .rejects.toThrow();
  });
});

describe("todos and the requirement pool", () => {
  const setup = async (todos: string) => {
    const client = new FakeOpenProject([
      requirement(50, "MPR-REQ-1", "进行中"),
      requirement(51, "MPR-REQ-2", "待验证/验收")
    ]);
    const service = new HandoffService(client, fieldMap);
    const saved = await service.save(saveInput({ sections: { ...saveInput().sections, 待办: todos } }), alice);
    return { client, service, reference: saved.item.workPackageId };
  };

  it("reads requirement state live rather than storing it", async () => {
    const { service, reference } = await setup("- [ ] (T1) 做事 · 需求:MPR-REQ-1 · 状态:进行中");

    const detail = await service.get({ project: "eva-project", reference }, alice);
    const [todo] = detail.todos as Array<Record<string, unknown>>;

    expect(todo?.requirementState).toBe("进行中");
    expect(todo?.aligned).toBe(true);
  });

  it("reports disagreement instead of picking a side", async () => {
    const { service, reference } = await setup("- [x] (T1) 做完了 · 需求:MPR-REQ-1 · 状态:待验证");

    const detail = await service.get({ project: "eva-project", reference }, alice);
    const [todo] = detail.todos as Array<Record<string, unknown>>;

    expect(todo?.requirementState).toBe("进行中");
    expect(todo?.aligned).toBe(false);
  });

  it("marks a todo with no requirement as not compared rather than misaligned", async () => {
    const { service, reference } = await setup("- [ ] (T1) 临时事项 · 状态:进行中");

    const detail = await service.get({ project: "eva-project", reference }, alice);
    const [todo] = detail.todos as Array<Record<string, unknown>>;

    expect(todo?.aligned).toBeNull();
    expect(todo?.requirement).toBeNull();
  });

  it("never writes to the requirement when a todo is ticked", async () => {
    const { client, service, reference } = await setup("- [ ] (T1) 做事 · 需求:MPR-REQ-1 · 状态:进行中");

    await service.updateTodos({ expectedLockVersion: 0,
      project: "eva-project", reference,
      todos: "- [x] (T1) 做事 · 需求:MPR-REQ-1 · 状态:已完成",
      note: "做完了", changedAt: "2026-09-22T09:00:00+08:00", sessionId: "session-a"
    }, alice);

    expect(client.updateCalls.every(call => call.id !== 50)).toBe(true);
  });

  it("recomputes counts from the list instead of trusting the caller", async () => {
    const { service, reference } = await setup("- [ ] (T1) 一 · 状态:进行中");

    const result = await service.updateTodos({ expectedLockVersion: 0,
      project: "eva-project", reference,
      todos: "- [x] (T1) 一\n- [x] (T2) 二\n- [ ] (T3) 三",
      note: "推进", changedAt: "2026-09-22T09:00:00+08:00", sessionId: "session-a"
    }, alice);

    expect({ total: result.total, done: result.done }).toEqual({ total: 3, done: 2 });
    expect(result.item.todoTotal).toBe(3);
  });

  it("leaves the other sections untouched when only todos change", async () => {
    const { service, reference } = await setup("- [ ] (T1) 一");

    await service.updateTodos({ expectedLockVersion: 0,
      project: "eva-project", reference, todos: "- [x] (T1) 一",
      note: "完成", changedAt: "2026-09-22T09:00:00+08:00", sessionId: "session-a"
    }, alice);
    const detail = await service.get({ project: "eva-project", reference }, alice);

    expect((detail.sections as Record<string, string>).背景).toContain("为 Session 之间的上下文交接建模");
  });

  it("keeps a line it cannot parse instead of dropping the work it describes", async () => {
    const { service, reference } = await setup("- [ ] (T1) 正常\n这一行不是待办");

    const detail = await service.get({ project: "eva-project", reference }, alice);

    expect(detail.unparsedTodoLines).toContain("这一行不是待办");
  });

  it("links the handoff to the requirements its todos point at", async () => {
    const { client, service, reference } = await setup(
      "- [ ] (T1) 一 · 需求:MPR-REQ-1\n- [ ] (T2) 二 · 需求:MPR-REQ-2"
    );

    const linked = await service.linkRequirements({ project: "eva-project", reference }, alice);

    expect(linked).toEqual(["MPR-REQ-1", "MPR-REQ-2"]);
    expect(client.relationCalls.map(call => call.type)).toEqual(["relates", "relates"]);
  });
});

describe("reading handoffs", () => {
  it("returns only the sections asked for", async () => {
    const client = new FakeOpenProject();
    const service = new HandoffService(client, fieldMap);
    const saved = await service.save(saveInput(), alice);

    const detail = await service.get({
      project: "eva-project", reference: saved.item.workPackageId, sections: ["现状"]
    }, alice);

    expect(Object.keys(detail.sections as object)).toEqual(["现状"]);
  });

  it("finds a handoff by its business id", async () => {
    const service = new HandoffService(new FakeOpenProject(), fieldMap);
    await service.save(saveInput(), alice);

    const detail = await service.get({ project: "eva-project", reference: "EVAPROJECT-HO-20260921-001" }, alice);

    expect((detail.handoff as Record<string, unknown>).id).toBe("EVAPROJECT-HO-20260921-001");
  });

  it("hides a private handoff from another user", async () => {
    const service = new HandoffService(new FakeOpenProject(), fieldMap);
    const saved = await service.save(saveInput(), alice);

    await expect(service.get({ project: "eva-project", reference: saved.item.workPackageId }, bob))
      .rejects.toThrow(/not found/);
  });

  it("lists the threads waiting for someone to pick them up", async () => {
    const service = new HandoffService(new FakeOpenProject(), fieldMap);
    await service.save(saveInput(), alice);
    await service.save(saveInput({ id: "EVAPROJECT-HO-002", thread: "另一条线" }), alice);

    const result = await service.list({ project: "eva-project", state: "待接手" }, alice);

    expect(result.items.map(item => item.thread).sort()).toEqual(["eva-project/交接功能", "另一条线"]);
  });
});

describe("editing a handoff that already exists", () => {
  it("rewrites one prose section and leaves the others and the todos alone", async () => {
    const client = new FakeOpenProject();
    const service = new HandoffService(client, fieldMap);
    const { item } = await service.save(saveInput(), alice);

    await service.updateSection({ expectedLockVersion: 0,
      project: "eva-project",
      reference: item.id,
      section: "现状",
      content: "⚠️ 生产是靠手改 DB 撑住的。",
      note: "修正",
      changedAt: "2026-09-22T10:00:00+08:00"
    }, alice);

    const detail = await service.get({ project: "eva-project", reference: item.id }, alice);
    const sections = detail.sections as Record<string, string | null>;
    expect(sections.现状).toBe("⚠️ 生产是靠手改 DB 撑住的。");
    expect(sections.背景).toBe("为 Session 之间的上下文交接建模。");
    expect(sections.注意事项).toBe("正式环境等 Brian 通知才升级。");
    expect((detail.todos as unknown[]).length).toBe(2);
  });

  it("sends the todo list to updateTodos instead of rewriting it as prose", async () => {
    const service = new HandoffService(new FakeOpenProject(), fieldMap);
    const { item } = await service.save(saveInput(), alice);

    await expect(service.updateSection({ expectedLockVersion: 0,
      project: "eva-project",
      reference: item.id,
      section: "待办" as never,
      content: "- [x] (T1) 随便",
      note: "不该走这条路",
      changedAt: "2026-09-22T10:00:00+08:00"
    }, alice)).rejects.toThrow(/updateTodos/);
  });

  it("refuses a repeated save that carries different content, naming what differs", async () => {
    const client = new FakeOpenProject();
    const service = new HandoffService(client, fieldMap);
    await service.save(saveInput(), alice);

    const corrected = saveInput({
      sections: { ...saveInput().sections, 背景: "改过的背景。" }
    });
    await expect(service.save(corrected, alice)).rejects.toThrow(RequirementConflictError);
    await expect(service.save(corrected, alice)).rejects.toThrow(/背景/);
    // The attempt must not have created a second record, nor edited the first one.
    expect(client.createCalls).toHaveLength(1);
    const detail = await service.get({ project: "eva-project", reference: "EVAPROJECT-HO-20260921-001" }, alice);
    expect((detail.sections as Record<string, string>).背景).toBe("为 Session 之间的上下文交接建模。");
  });

  it("still replays a byte-identical save, so a retried call is harmless", async () => {
    const client = new FakeOpenProject();
    const service = new HandoffService(client, fieldMap);
    await service.save(saveInput(), alice);

    expect((await service.save(saveInput(), alice)).replayed).toBe(true);
    expect(client.createCalls).toHaveLength(1);
  });
});


describe("web handoff pickup", () => {
  const person: Principal = { ...bob, via: "网页" };
  const input = (reference: number, version: number) => ({
    project: "eva-project", reference, agent: "", sessionId: "web:bob", label: "Bob",
    scope: "网页接手", claimedAt: "2026-11-04T07:00:00Z", expectedLockVersion: version
  });
  const setup = async (overrides: Partial<SaveHandoffInput> = {}) => {
    const client = new FakeOpenProject();
    const service = new HandoffService(client, fieldMap);
    const saved = await service.save(saveInput({ visibility: "公开", ...overrides }), alice);
    return { client, service, saved };
  };
  it("registers a different project member as the human recipient and returns their time", async () => {
    const { service, saved } = await setup();
    const result = await service.claim(input(saved.item.workPackageId, saved.item.lockVersion), person);
    expect(result.item).toMatchObject({ claimedSession: "web:bob", claimedAgent: null, claimLabel: "Bob",
      claimedAt: "2026-11-04T07:00:00Z", handoffState: "已接手" });
    await service.updateSection({ expectedLockVersion: result.item.lockVersion, project: "eva-project", reference: saved.item.workPackageId,
      section: "现状", content: "已由接手人继续处理", note: "test", changedAt: "now", sessionId: "web:bob"
    }, person);
  });
  it("makes a retry with the original version idempotent", async () => {
    const { client, service, saved } = await setup();
    const args = input(saved.item.workPackageId, saved.item.lockVersion);
    await service.claim(args, person);
    const result = await service.claim(args, person);
    expect(result.replayed).toBe(true);
    expect(client.updateCalls).toHaveLength(1);
  });
  it("allows only one of two concurrent recipients to acquire the handoff", async () => {
    const { service, saved } = await setup();
    const args = input(saved.item.workPackageId, saved.item.lockVersion);
    const results = await Promise.allSettled([
      service.claim(args, person),
      service.claim({ expectedLockVersion: 0, ...args, sessionId: "web:alice", label: "Alice" }, { ...alice, via: "网页" })
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  });
  it("refuses private records and archived handoffs", async () => {
    const { service, saved } = await setup({ visibility: "私有" });
    await expect(service.claim(input(saved.item.workPackageId, saved.item.lockVersion), person)).rejects.toThrow();
    await service.updateState({ expectedLockVersion: 0, project: "eva-project", reference: saved.item.workPackageId,
      state: "已归档", note: "test", changedAt: "now" }, alice);
    await expect(service.claim({ expectedLockVersion: 0, ...input(saved.item.workPackageId, saved.item.lockVersion),
      sessionId: "web:alice" }, { ...alice, via: "网页" })).rejects.toThrow("无法接手");
  });
  it("requires an explicit override for a named expected Agent", async () => {
    const { service, saved } = await setup({ expectedAgent: "Claude" });
    const args = input(saved.item.workPackageId, saved.item.lockVersion);
    await expect(service.claim(args, person)).rejects.toThrow("expects agent");
    expect((await service.claim({ ...args, override: true }, person)).item.claimedAgent).toBeNull();
  });
  it("lets the recipient release their own claim without owning the record", async () => {
    const { service, saved } = await setup();
    const claimed = await service.claim(input(saved.item.workPackageId, saved.item.lockVersion), person);
    const released = await service.release({project:"eva-project", reference:saved.item.workPackageId,
      sessionId:"web:bob", reason:"暂时无法继续", releasedAt:"now", expectedLockVersion:claimed.item.lockVersion},person);
    expect(released).toMatchObject({ handoffState:"待接手", claimedSession:null, claimLabel:null, claimedAt:null });
  });
  it("prevents a bare state change from leaving state and pickup metadata inconsistent", async () => {
    const { service, saved } = await setup();
    await expect(service.updateState({ expectedLockVersion: 0,project:"eva-project",reference:saved.item.workPackageId,
      state:"已接手",note:"test",changedAt:"now"},alice)).rejects.toThrow("登记接手人");
    const claimed = await service.claim(input(saved.item.workPackageId, saved.item.lockVersion), person);
    await expect(service.updateState({project:"eva-project",reference:saved.item.workPackageId,
      state:"待接手",note:"test",changedAt:"now",sessionId:"web:bob",expectedLockVersion:claimed.item.lockVersion},person))
      .rejects.toThrow("先释放接手");
  });
});


describe("handoff retry and version safeguards", () => {
  it.each([{}, { 背景: "context" }, { 主线: "  ", 待办: "\n" }])(
    "replays a saved handoff with empty sections without creating a duplicate (%j)", async sections => {
      const client = new FakeOpenProject();
      const service = new HandoffService(client, fieldMap);
      const input = saveInput({ sections });
      const first = await service.save(input, alice);
      const retry = await service.save(input, alice);
      expect(retry).toMatchObject({ replayed: true, item: { workPackageId: first.item.workPackageId } });
      expect(client.createCalls).toHaveLength(1);
      await expect(service.save({ ...input, sections: { ...sections, 背景: "different" } }, alice))
        .rejects.toThrow("already exists");
    }
  );
  it("rejects missing versions for all handoff edits without changing the saved record", async () => {
    const client = new FakeOpenProject();
    const service = new HandoffService(client, fieldMap);
    const saved = await service.save(saveInput(), alice);
    const common = { project: "eva-project", reference: saved.item.workPackageId };
    const writes = [
      () => service.claim({ ...common, agent: "Codex", sessionId: "test", label: "test", scope: "test", claimedAt: "now" }, alice),
      () => service.release({ ...common, sessionId: "test", reason: "test", releasedAt: "now" }, alice),
      () => service.updateTodos({ ...common, todos: "", note: "test", changedAt: "now" }, alice),
      () => service.updateSection({ ...common, section: "背景", content: "new", note: "test", changedAt: "now" }, alice),
      () => service.updateState({ ...common, state: "已归档", note: "test", changedAt: "now" }, alice)
    ];
    for (const write of writes) await expect(write()).rejects.toThrow("记录版本");
    expect(client.updateCalls).toEqual([]);
  });
  it("preserves the current handoff when a later edit submits a stale version", async () => {
    const client = new FakeOpenProject();
    const service = new HandoffService(client, fieldMap);
    const saved = await service.save(saveInput(), alice);
    const edit = { project: "eva-project", reference: saved.item.workPackageId, section: "背景" as const,
      content: "current", note: "test", changedAt: "now", expectedLockVersion: saved.item.lockVersion };
    await service.updateSection(edit, alice);
    await expect(service.updateSection({ ...edit, content: "stale" }, alice)).rejects.toThrow("Stale lockVersion");
    expect(client.updateCalls).toHaveLength(1);
    expect(client.workPackages.get(saved.item.workPackageId)?.description?.raw).toContain("current");
  });
});


it("requires a version even when a handoff claim would otherwise be a same-session replay", async () => {
  const client = new FakeOpenProject();
  const service = new HandoffService(client, fieldMap);
  const saved = await service.save(saveInput(), alice);
  const input = { project: "eva-project", reference: saved.item.workPackageId, agent: "Codex",
    sessionId: "test", label: "test", scope: "test", claimedAt: "now" };
  await service.claim({ ...input, expectedLockVersion: saved.item.lockVersion }, alice);
  await expect(service.claim(input, alice)).rejects.toThrow("记录版本");
  expect((await service.claim({ ...input, expectedLockVersion: saved.item.lockVersion }, alice)).replayed).toBe(true);
  expect(client.updateCalls).toHaveLength(1);
});


describe("handoff ownership, thread concurrency and recovery", () => {
  it.each(["supersede", "previous"])("preflights %s ownership before creating or archiving anything", async path => {
    const client = new FakeOpenProject();
    const service = new HandoffService(client, fieldMap);
    const first = await service.save(saveInput({ visibility: "公开" }), alice);
    await expect(service.save(saveInput({ id: "BOB", visibility: "公开",
      ...(path === "supersede" ? { supersede: true } : { supersede: true, previous: first.item.id! }) }), bob)).rejects.toThrow();
    expect(client.createCalls).toHaveLength(1);
    expect(client.updateCalls).toEqual([]);
    expect((await service.get({ project: "eva-project", reference: first.item.workPackageId }, alice)).handoff).toMatchObject({ handoffState: "待接手" });
  });
  it("requires edit permission before superseding an owned handoff", async () => {
    const client = new FakeOpenProject();
    const service = new HandoffService(client, fieldMap);
    await service.save(saveInput(), alice);
    client.canEditWorkPackages = async () => false;
    await expect(service.save(saveInput({ id: "NEXT", supersede: true }), alice)).rejects.toThrow("处理任务的权限");
    expect(client.createCalls).toHaveLength(1);
    expect(client.updateCalls).toEqual([]);
  });
  it("serializes different ids on a thread across service instances", async () => {
    const client = new FakeOpenProject();
    const results = await Promise.allSettled([
      new HandoffService(client, fieldMap).save(saveInput({ id: "A" }), alice),
      new HandoffService(client, fieldMap).save(saveInput({ id: "B" }), alice)
    ]);
    expect(results.map(item => item.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(client.createCalls).toHaveLength(1);
  });
  it("allows unrelated threads concurrently and unlocks a thread after a rejected request", async () => {
    const client = new FakeOpenProject();
    const service = new HandoffService(client, fieldMap);
    await Promise.all([service.save(saveInput({ id: "A", thread: "a" }), alice), service.save(saveInput({ id: "B", thread: "b" }), alice)]);
    await expect(service.save(saveInput({ id: "C", thread: "a" }), alice)).rejects.toThrow();
    expect((await service.save(saveInput({ id: "C", thread: "a", supersede: true }), alice)).item.handoffState).toBe("待接手");
    expect((await service.list({ project: "eva-project", state: "待接手" }, alice)).items).toHaveLength(2);
  });
  it("leaves a draft on archive failure and resumes it with no duplicate creation", async () => {
    const client = new FakeOpenProject();
    const service = new HandoffService(client, fieldMap);
    const old = await service.save(saveInput(), alice);
    const update = client.updateWorkPackage.bind(client);
    client.updateWorkPackage = async (id, payload) => {
      if (id === old.item.workPackageId) throw new OpenProjectHttpError(409, "archive conflict", {});
      return update(id, payload);
    };
    const next = saveInput({ id: "NEXT", supersede: true });
    await expect(service.save(next, alice)).rejects.toThrow("已保存为草稿");
    expect((await service.list({ project: "eva-project", state: "待接手" }, alice)).items).toHaveLength(1);
    expect((await service.list({ project: "eva-project", state: "草稿" }, alice)).items).toHaveLength(1);
    client.updateWorkPackage = update;
    const resumed = await new HandoffService(client, fieldMap).save(next, alice);
    expect(resumed.item.handoffState).toBe("待接手");
    expect(client.createCalls).toHaveLength(2);
    expect((await service.list({ project: "eva-project", state: "待接手" }, alice)).items.map(item => item.id)).toEqual(["NEXT"]);
  });
  it("binds handoff claims to their real user, including release and successor archival", async () => {
    const client = new FakeOpenProject();
    client.users.set("mallory", 14);
    const mallory: Principal = { userId: "mallory", displayName: "Mallory", role: "user" };
    const service = new HandoffService(client, fieldMap);
    const first = await service.save(saveInput({ visibility: "公开" }), alice);
    const claim = { project: "eva-project", reference: first.item.workPackageId, agent: "Codex", sessionId: "bob-session",
      label: "Bob", scope: "work", claimedAt: "now", expectedLockVersion: first.item.lockVersion };
    const claimed = await service.claim(claim, bob);
    const common = { project: "eva-project", reference: first.item.workPackageId, sessionId: "bob-session", expectedLockVersion: claimed.item.lockVersion };
    await expect(service.updateSection({ ...common, section: "背景", content: "stolen", note: "test", changedAt: "now" }, mallory)).rejects.toThrow();
    await expect(service.release({ ...common, reason: "test", releasedAt: "now" }, mallory)).rejects.toThrow();
    await expect(service.claim({ ...claim, expectedLockVersion: claimed.item.lockVersion }, mallory)).rejects.toThrow("already claimed");
    await expect(service.save(saveInput({ id: "STOLEN", previous: first.item.id!, sourceSessionId: "bob-session" }), mallory)).rejects.toThrow();
    expect(client.updateCalls).toHaveLength(1);
    const next = await service.save(saveInput({ id: "BOB-NEXT", previous: first.item.id!, sourceSessionId: "bob-session" }), bob);
    expect(next.item.handoffState).toBe("待接手");
    expect((await service.get({ project: "eva-project", reference: first.item.workPackageId }, alice)).handoff).toMatchObject({ handoffState: "已归档" });
  });
});
