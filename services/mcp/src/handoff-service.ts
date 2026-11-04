// Session-to-session handoffs. A handoff records where one working session stopped so
// the next one can continue without re-deriving it, and is always one writer to one
// reader: parallelism comes from having several handoffs, never from several sessions
// claiming one.
//
// Requirement state is never copied in here. Todo lines may point at a requirement, and
// that pointer is resolved on read, so the two can only ever be reported as disagreeing
// — never silently stored twice.

import { OpenProjectHttpError } from "./openproject.js";
import {
  FIELD,
  hrefId,
  linkTitle,
  OpenProjectRecordService,
  RequirementConflictError,
  RequirementValidationError
} from "./record-service.js";
import {
  alignment,
  countTodos,
  parseTodoSection,
  serializeTodoSection,
  todoItems,
  type TodoEntry,
  type TodoItem
} from "./handoff-todos.js";
import type { HandoffSummary, Principal, WorkPackage } from "./types.js";

export const HANDOFF_FIELD = {
  thread: "handoffThread",
  state: "handoffState",
  previous: "handoffPrevious",
  expectedAgent: "handoffExpectedAgent",
  repository: "handoffRepository",
  branch: "handoffBranch",
  baseCommit: "handoffBaseCommit",
  todoTotal: "handoffTodoTotal",
  todoDone: "handoffTodoDone"
} as const;

export const HANDOFF_SECTIONS = ["背景", "主线", "现状", "待办", "注意事项"] as const;

/** The sections updateSection accepts: everything except 待办, which updateTodos owns. */
export const HANDOFF_PROSE_SECTIONS = ["背景", "主线", "现状", "注意事项"] as const;

export type HandoffSection = (typeof HANDOFF_SECTIONS)[number];

/** The state a handoff sits in while it waits for someone to pick it up. */
const AWAITING = "待接手";

export type SaveHandoffInput = {
  project: string;
  id: string;
  title: string;
  thread: string;
  sections: Partial<Record<HandoffSection, string>>;
  repository: string;
  branch: string;
  baseCommit: string;
  sourceSessionId: string;
  requestId: string;
  modules: string[];
  visibility: "公开" | "私有";
  expectedAgent?: string;
  previous?: string;
  supersede?: boolean;
};

export type ResolvedTodo = TodoItem & {
  requirementState: string | null;
  aligned: boolean | null;
};

export class HandoffService extends OpenProjectRecordService {
  private typeHref(): string {
    const href = this.map.handoffTypeHref;
    if (!href) {
      throw new RequirementValidationError(
        "This deployment has no handoff type; rerun the OpenProject bootstrap"
      );
    }
    return href;
  }

  private statusLink(payload: Record<string, unknown>, state: string): void {
    const href = this.map.handoffStatusHrefs?.[state];
    if (!href) return;
    const links = (payload._links ?? {}) as Record<string, unknown>;
    links.status = { href };
    payload._links = links;
  }

  private isHandoff(workPackage: WorkPackage): boolean {
    return this.workPackageTypeId(workPackage) === Number(hrefId(this.typeHref()));
  }

  private assertHandoff(workPackage: WorkPackage): void {
    if (!this.isHandoff(workPackage)) {
      throw new RequirementValidationError("This work package is not a handoff");
    }
  }

  private summarize(workPackage: WorkPackage): HandoffSummary {
    return {
      id: this.readText(workPackage, FIELD.requirementId),
      workPackageId: workPackage.id,
      project: linkTitle(workPackage._links.project),
      title: workPackage.subject,
      thread: this.readText(workPackage, HANDOFF_FIELD.thread),
      handoffState: this.readList(workPackage, HANDOFF_FIELD.state)[0] ?? null,
      previous: this.readText(workPackage, HANDOFF_FIELD.previous),
      expectedAgent: this.readList(workPackage, HANDOFF_FIELD.expectedAgent)[0] ?? null,
      repository: this.readText(workPackage, HANDOFF_FIELD.repository),
      branch: this.readText(workPackage, HANDOFF_FIELD.branch),
      baseCommit: this.readText(workPackage, HANDOFF_FIELD.baseCommit),
      todoTotal: this.readInt(workPackage, HANDOFF_FIELD.todoTotal),
      todoDone: this.readInt(workPackage, HANDOFF_FIELD.todoDone),
      claimedAgent: this.readList(workPackage, FIELD.claimedAgent)[0] ?? null,
      claimedSession: this.readText(workPackage, FIELD.claimedSession),
      sourceSessionId: this.readText(workPackage, FIELD.sourceSessionId),
      visibility: (this.readList(workPackage, FIELD.visibility)[0] as "公开" | "私有") ?? null,
      ownerUserId: this.readText(workPackage, FIELD.ownerUserId),
      updatedAt: workPackage.updatedAt ?? null,
      lockVersion: workPackage.lockVersion
    };
  }

  private todoEntries(workPackage: WorkPackage): TodoEntry[] {
    return parseTodoSection(this.readMarkdownSection(workPackage.description?.raw ?? "", "待办") ?? "");
  }

  /**
   * Reads each referenced requirement's current state so a stale handoff can only ever
   * be reported as out of step, never mistaken for the truth.
   */
  private async resolveTodos(
    workPackage: WorkPackage,
    project: string,
    principal: Principal
  ): Promise<ResolvedTodo[]> {
    const items = todoItems(this.todoEntries(workPackage));
    const references = [...new Set(items.map(item => item.requirement).filter((value): value is string => Boolean(value)))];
    const states = new Map<string, string | null>();
    await Promise.all(references.map(async reference => {
      try {
        const target = await this.resolve(reference, project, principal);
        states.set(reference, this.canRead(target, principal)
          ? this.readList(target, FIELD.state)[0] ?? null
          : null);
      } catch {
        // A pointer to something unreadable or deleted is reported as unknown rather
        // than failing the whole read; the handoff is still useful without it.
        states.set(reference, null);
      }
    }));
    return items.map(item => {
      const requirementState = item.requirement ? states.get(item.requirement) ?? null : null;
      return { ...item, requirementState, aligned: alignment(item, requirementState) };
    });
  }

  private async findByHandoffId(id: string, project: string, principal: Principal): Promise<WorkPackage | null> {
    const scope = await this.visibleProject(project, principal);
    const result = await this.client.listProjectWorkPackages(scope.id, {
      pageSize: "2",
      offset: "1",
      filters: JSON.stringify([
        { type: { operator: "=", values: [String(hrefId(this.typeHref()))] } },
        { [this.field(FIELD.requirementId).key]: { operator: "=", values: [id] } }
      ])
    });
    return result._embedded.elements[0] ?? null;
  }

  private async resolveHandoff(
    reference: string | number,
    project: string,
    principal: Principal
  ): Promise<WorkPackage> {
    const workPackage = typeof reference === "number" || /^\d+$/.test(String(reference))
      ? await this.resolve(reference, project, principal)
      : await this.findByHandoffId(String(reference), project, principal);
    if (!workPackage) throw new RequirementValidationError(`Handoff not found: ${reference}`);
    this.assertReadable(workPackage, principal);
    this.assertHandoff(workPackage);
    return workPackage;
  }

  private description(input: SaveHandoffInput, todos: string): string {
    const section = (name: HandoffSection, body: string) => [`## ${name}`, body.trim() || "尚无。"];
    return [
      ...section("背景", input.sections.背景 ?? ""),
      ...section("主线", input.sections.主线 ?? ""),
      ...section("现状", input.sections.现状 ?? ""),
      "## 待办",
      todos || "尚无。",
      ...section("注意事项", input.sections.注意事项 ?? ""),
      "## 来源",
      `- 项目：${input.project}`,
      `- 线程：${input.thread}`,
      `- 仓库：${input.repository}`,
      `- 分支：${input.branch}`,
      `- 基线提交：${input.baseCommit}`,
      `- 写出 Session：${input.sourceSessionId}`,
      `- 上一任交接：${input.previous ?? "无，链首"}`,
      "## 变更记录",
      `- 写出请求：${input.requestId}`
    ].join("\n\n");
  }

  /** The handoff a session picks up: newest still awaiting a reader on this thread. */
  private async awaitingOnThread(thread: string, project: string, principal: Principal): Promise<WorkPackage | null> {
    const scope = await this.visibleProject(project, principal);
    const result = await this.client.listProjectWorkPackages(scope.id, {
      pageSize: "50",
      offset: "1",
      sortBy: JSON.stringify([["updatedAt", "desc"]]),
      filters: JSON.stringify([
        { type: { operator: "=", values: [String(hrefId(this.typeHref()))] } },
        { [this.field(HANDOFF_FIELD.thread).key]: { operator: "~", values: [thread] } }
      ])
    });
    return result._embedded.elements.find(item =>
      this.canRead(item, principal) &&
      this.readText(item, HANDOFF_FIELD.thread) === thread &&
      this.readList(item, HANDOFF_FIELD.state)[0] === AWAITING) ?? null;
  }

  async save(input: SaveHandoffInput, principal: Principal): Promise<{ replayed: boolean; item: HandoffSummary }> {
    const existing = await this.findByHandoffId(input.id, input.project, principal);
    if (existing) {
      // Resending the same record is an idempotent retry. Resending the same id with
      // different content is someone trying to correct a handoff, and silently handing
      // back the old record would throw their correction away without saying so.
      const changed = this.changedSections(existing, input);
      if (changed.length) {
        throw new RequirementConflictError(
          `Handoff ${input.id} already exists and ${changed.join(", ")} differ; use handoff_update_section to edit it, or save a new id and declare it the successor`
        );
      }
      return { replayed: true, item: this.summarize(existing) };
    }

    const pending = await this.awaitingOnThread(input.thread, input.project, principal);
    if (pending && !input.supersede) {
      throw new RequirementConflictError(
        `Thread ${input.thread} already has an unclaimed handoff ${this.readText(pending, FIELD.requirementId) ?? pending.id}; pass supersede to replace it`
      );
    }

    const entries = parseTodoSection(input.sections.待办 ?? "");
    const todos = serializeTodoSection(entries);
    const counts = countTodos(entries);

    const scope = await this.visibleProject(input.project, principal);
    const payload: Record<string, unknown> = {
      subject: input.title,
      description: { format: "markdown", raw: this.description(input, todos) },
      _links: { type: { href: this.typeHref() } }
    };
    this.writeField(payload, FIELD.requirementId, input.id);
    this.writeField(payload, FIELD.ownerUserId, principal.userId);
    this.writeField(payload, FIELD.visibility, input.visibility);
    this.writeField(payload, FIELD.modules, input.modules);
    this.writeField(payload, FIELD.sourceSessionId, input.sourceSessionId);
    this.writeField(payload, HANDOFF_FIELD.thread, input.thread);
    this.writeField(payload, HANDOFF_FIELD.state, AWAITING);
    this.writeField(payload, HANDOFF_FIELD.repository, input.repository);
    this.writeField(payload, HANDOFF_FIELD.branch, input.branch);
    this.writeField(payload, HANDOFF_FIELD.baseCommit, input.baseCommit);
    this.writeField(payload, HANDOFF_FIELD.todoTotal, counts.total);
    this.writeField(payload, HANDOFF_FIELD.todoDone, counts.done);
    if (input.previous !== undefined) this.writeField(payload, HANDOFF_FIELD.previous, input.previous);
    this.writeField(payload, HANDOFF_FIELD.expectedAgent, input.expectedAgent ?? "不限");
    this.statusLink(payload, AWAITING);

    const created = await this.client.createWorkPackage(scope.id, payload);

    const now = new Date().toISOString();
    if (pending) {
      await this.transition(pending, "已归档", `被 ${input.id} 接续，自动归档。`, now);
    }
    // Naming a predecessor means this handoff continues it, so the predecessor is done:
    // otherwise a claimed handoff stays 已接手 forever and the thread shows two live
    // records. Already-archived ones are left alone.
    if (input.previous && input.previous !== (pending && this.readText(pending, FIELD.requirementId))) {
      try {
        const earlier = await this.resolveHandoff(input.previous, input.project, principal);
        const state = this.readList(earlier, HANDOFF_FIELD.state)[0];
        if (state && state !== "已归档" && state !== "已作废") {
          await this.transition(earlier, "已归档", `被 ${input.id} 接续，自动归档。`, now);
        }
      } catch {
        // A predecessor that cannot be read is recorded as a pointer only; the new
        // handoff is already saved and must not fail because of it.
      }
    }
    return { replayed: false, item: this.summarize(created) };
  }

  /** Which parts of an existing handoff a repeated save would have changed. */
  private changedSections(existing: WorkPackage, input: SaveHandoffInput): string[] {
    const normalise = (value: string | null | undefined) => (value ?? "").trim();
    const raw = existing.description?.raw ?? "";
    const changed: string[] = [];
    if (normalise(existing.subject) !== normalise(input.title)) changed.push("标题");
    for (const name of HANDOFF_PROSE_SECTIONS) {
      if (normalise(this.readMarkdownSection(raw, name)) !== normalise(input.sections[name])) changed.push(name);
    }
    const todos = serializeTodoSection(parseTodoSection(input.sections.待办 ?? ""));
    if (normalise(this.readMarkdownSection(raw, "待办")) !== normalise(todos)) changed.push("待办");
    return changed;
  }

  private async transition(
    workPackage: WorkPackage,
    state: string,
    note: string,
    changedAt: string
  ): Promise<WorkPackage> {
    const payload: Record<string, unknown> = {
      lockVersion: workPackage.lockVersion,
      description: {
        format: "markdown",
        raw: `${workPackage.description?.raw ?? ""}\n\n## 变更记录\n\n- ${changedAt}：交接状态更新为「${state}」。${note}`
      }
    };
    this.writeField(payload, HANDOFF_FIELD.state, state);
    this.statusLink(payload, state);
    return this.updateWithConflict(workPackage.id, payload);
  }

  /**
   * The first call a continuing session makes. Deliberately compact: enough to decide
   * whether to pick the handoff up and what to do first, without the full prose.
   */
  async latest(input: { project: string; thread: string; openTodoLimit?: number }, principal: Principal): Promise<Record<string, unknown> | null> {
    const workPackage = await this.awaitingOnThread(input.thread, input.project, principal);
    if (!workPackage) return null;
    const todos = await this.resolveTodos(workPackage, input.project, principal);
    const open = todos.filter(item => !item.done);
    const limit = Math.min(Math.max(input.openTodoLimit ?? 10, 1), 50);
    return {
      handoff: this.summarize(workPackage),
      openTodos: open.slice(0, limit),
      openTodoCount: open.length,
      truncated: open.length > limit,
      requirements: this.requirementRollup(todos),
      sections: HANDOFF_SECTIONS
    };
  }

  /** Distinct requirements this thread carries, with the state read just now. */
  private requirementRollup(todos: ResolvedTodo[]): Array<Record<string, unknown>> {
    const seen = new Map<string, Record<string, unknown>>();
    for (const todo of todos) {
      if (!todo.requirement || seen.has(todo.requirement)) continue;
      seen.set(todo.requirement, {
        requirement: todo.requirement,
        requirementState: todo.requirementState,
        misaligned: todos.some(item => item.requirement === todo.requirement && item.aligned === false)
      });
    }
    return [...seen.values()];
  }

  async get(input: {
    project: string;
    reference: string | number;
    sections?: HandoffSection[];
  }, principal: Principal): Promise<Record<string, unknown>> {
    const workPackage = await this.resolveHandoff(input.reference, input.project, principal);
    const raw = workPackage.description?.raw ?? "";
    const wanted = input.sections?.length ? input.sections : HANDOFF_SECTIONS;
    const sections: Record<string, string | null> = {};
    for (const name of wanted) {
      if (name === "待办") continue;
      sections[name] = this.readMarkdownSection(raw, name);
    }
    return {
      handoff: this.summarize(workPackage),
      sections,
      todos: await this.resolveTodos(workPackage, input.project, principal),
      unparsedTodoLines: this.todoEntries(workPackage)
        .filter(entry => entry.kind === "passthrough" && entry.raw.trim())
        .map(entry => (entry as { raw: string }).raw)
    };
  }

  async claim(input: {
    project: string;
    reference: string | number;
    agent: string;
    sessionId: string;
    label: string;
    scope: string;
    claimedAt: string;
    expectedLockVersion?: number;
    override?: boolean;
  }, principal: Principal): Promise<{ replayed: boolean; item: HandoffSummary }> {
    const workPackage = await this.resolveHandoff(input.reference, input.project, principal);
    this.assertExpectedVersion(workPackage, input.expectedLockVersion);

    const current = this.readText(workPackage, FIELD.claimedSession);
    if (current === input.sessionId) return { replayed: true, item: this.summarize(workPackage) };
    if (current) {
      throw new RequirementConflictError(`Handoff is already claimed by session ${current}`);
    }

    // Advisory, not enforced: the server cannot tell which agent is calling. It stops an
    // accidental pickup, and an intentional one is recorded rather than blocked.
    const expected = this.readList(workPackage, HANDOFF_FIELD.expectedAgent)[0];
    if (expected && expected !== "不限" && expected !== input.agent && !input.override) {
      throw new RequirementConflictError(
        `Handoff expects agent ${expected}; pass override to claim it as ${input.agent}`
      );
    }

    const payload: Record<string, unknown> = {
      lockVersion: workPackage.lockVersion,
      description: {
        format: "markdown",
        raw: `${workPackage.description?.raw ?? ""}\n\n## 变更记录\n\n- ${input.claimedAt}：由 ${input.agent} Session ${input.sessionId} 领取。${
          expected && expected !== "不限" && expected !== input.agent ? `覆盖期望接手 Agent ${expected}。` : ""
        }${input.scope}`
      }
    };
    this.writeField(payload, FIELD.claimedAgent, input.agent);
    this.writeField(payload, FIELD.claimedSession, input.sessionId);
    this.writeField(payload, FIELD.claimLabel, input.label);
    this.writeField(payload, FIELD.claimedAt, input.claimedAt);
    this.writeField(payload, FIELD.claimScope, input.scope);
    this.writeField(payload, HANDOFF_FIELD.state, "已接手");
    this.statusLink(payload, "已接手");
    return { replayed: false, item: this.summarize(await this.updateWithConflict(workPackage.id, payload)) };
  }

  async release(input: {
    project: string;
    reference: string | number;
    sessionId: string;
    reason: string;
    releasedAt: string;
    expectedLockVersion?: number;
    takeover?: boolean;
  }, principal: Principal): Promise<HandoffSummary> {
    const workPackage = await this.resolveHandoff(input.reference, input.project, principal);
    this.assertExpectedVersion(workPackage, input.expectedLockVersion);
    const current = this.readText(workPackage, FIELD.claimedSession);
    if (!current) return this.summarize(workPackage);

    // Without this, a session that ends mid-work strands its thread forever.
    const takeover = current !== input.sessionId;
    if (takeover) {
      if (!input.takeover) {
        throw new RequirementConflictError(
          `Handoff is claimed by session ${current}; pass takeover to release it`
        );
      }
      this.assertOwnerOrAdmin(workPackage, principal);
    }

    const payload: Record<string, unknown> = {
      lockVersion: workPackage.lockVersion,
      description: {
        format: "markdown",
        raw: `${workPackage.description?.raw ?? ""}\n\n## 变更记录\n\n- ${input.releasedAt}：${
          takeover
            ? `接管释放，原认领 Session ${current}，由 ${principal.userId} 执行。`
            : "交还认领。"
        }${input.reason}`
      }
    };
    for (const name of [FIELD.claimedAgent, FIELD.claimedSession, FIELD.claimLabel, FIELD.claimedAt, FIELD.claimScope]) {
      this.writeField(payload, name, null);
    }
    this.writeField(payload, HANDOFF_FIELD.state, AWAITING);
    this.statusLink(payload, AWAITING);
    return this.summarize(await this.updateWithConflict(workPackage.id, payload));
  }

  /** Rewrites only the todo section, leaving every other section untouched. */
  async updateTodos(input: {
    project: string;
    reference: string | number;
    todos: string;
    note: string;
    changedAt: string;
    sessionId?: string;
    expectedLockVersion?: number;
  }, principal: Principal): Promise<{ item: HandoffSummary; total: number; done: number }> {
    const workPackage = await this.resolveHandoff(input.reference, input.project, principal);
    this.assertExpectedVersion(workPackage, input.expectedLockVersion);
    this.assertClaimOrOwner(workPackage, principal, input.sessionId);

    const entries = parseTodoSection(input.todos);
    const counts = countTodos(entries);
    const raw = this.writeMarkdownSection(
      workPackage.description?.raw ?? "",
      "待办",
      serializeTodoSection(entries)
    );

    const payload: Record<string, unknown> = {
      lockVersion: workPackage.lockVersion,
      description: {
        format: "markdown",
        raw: `${raw}\n\n## 变更记录\n\n- ${input.changedAt}：更新待办（${counts.done}/${counts.total}）。${input.note}`
      }
    };
    // Counts are recomputed here rather than trusted from the caller, so the number in
    // the list view can never disagree with the list itself.
    this.writeField(payload, HANDOFF_FIELD.todoTotal, counts.total);
    this.writeField(payload, HANDOFF_FIELD.todoDone, counts.done);
    const item = this.summarize(await this.updateWithConflict(workPackage.id, payload));
    return { item, total: counts.total, done: counts.done };
  }

  /** Rewrites one prose section, leaving the todo list and every other section alone. */
  async updateSection(input: {
    project: string;
    reference: string | number;
    section: HandoffSection;
    content: string;
    note: string;
    changedAt: string;
    sessionId?: string;
    expectedLockVersion?: number;
  }, principal: Principal): Promise<HandoffSummary> {
    if (!(HANDOFF_PROSE_SECTIONS as readonly string[]).includes(input.section)) {
      throw new RequirementValidationError("Use updateTodos to change the todo list");
    }
    const workPackage = await this.resolveHandoff(input.reference, input.project, principal);
    this.assertExpectedVersion(workPackage, input.expectedLockVersion);
    this.assertClaimOrOwner(workPackage, principal, input.sessionId);

    const raw = this.writeMarkdownSection(
      workPackage.description?.raw ?? "",
      input.section,
      input.content.trim() || "尚无。"
    );
    const payload: Record<string, unknown> = {
      lockVersion: workPackage.lockVersion,
      description: {
        format: "markdown",
        raw: `${raw}\n\n## 变更记录\n\n- ${input.changedAt}：编辑「${input.section}」。${input.note}`
      }
    };
    return this.summarize(await this.updateWithConflict(workPackage.id, payload));
  }

  async updateState(input: {
    project: string;
    reference: string | number;
    state: string;
    note: string;
    changedAt: string;
    sessionId?: string;
    expectedLockVersion?: number;
  }, principal: Principal): Promise<HandoffSummary> {
    const workPackage = await this.resolveHandoff(input.reference, input.project, principal);
    this.assertExpectedVersion(workPackage, input.expectedLockVersion);
    this.assertClaimOrOwner(workPackage, principal, input.sessionId);
    if (!this.map.handoffStatusHrefs?.[input.state]) {
      throw new RequirementValidationError(`Unknown handoff state: ${input.state}`);
    }
    return this.summarize(await this.transition(workPackage, input.state, input.note, input.changedAt));
  }

  async list(input: {
    project: string;
    thread?: string;
    state?: string;
    unclaimed?: boolean;
    cursor?: string;
    pageSize?: number;
  }, principal: Principal): Promise<{ items: HandoffSummary[]; nextCursor: string | null; total: number }> {
    const pageSize = Math.min(Math.max(input.pageSize ?? 20, 1), 50);
    const offset = input.cursor ? Number(input.cursor) : 1;
    if (!Number.isInteger(offset) || offset < 1) throw new RequirementValidationError("Invalid cursor");

    const scope = await this.visibleProject(input.project, principal);
    const filters: Array<Record<string, unknown>> = [
      { type: { operator: "=", values: [String(hrefId(this.typeHref()))] } }
    ];
    if (input.state) {
      filters.push({
        [this.field(HANDOFF_FIELD.state).key]: {
          operator: "=",
          values: [hrefId(this.option(HANDOFF_FIELD.state, input.state))]
        }
      });
    }

    const all: WorkPackage[] = [];
    let page = 1;
    let total = 0;
    do {
      const result = await this.client.listProjectWorkPackages(scope.id, {
        pageSize: "200",
        offset: String(page),
        sortBy: JSON.stringify([["updatedAt", "desc"]]),
        filters: JSON.stringify(filters)
      });
      total = result.total;
      all.push(...result._embedded.elements);
      page += 1;
    } while (all.length < total);

    let items = all.filter(item => this.canRead(item, principal));
    if (input.thread) items = items.filter(item => this.readText(item, HANDOFF_FIELD.thread) === input.thread);
    if (input.unclaimed) items = items.filter(item => !this.readText(item, FIELD.claimedSession));

    const visible = items.length;
    const start = (offset - 1) * pageSize;
    return {
      items: items.slice(start, start + pageSize).map(item => this.summarize(item)),
      nextCursor: start + pageSize < visible ? String(offset + 1) : null,
      total: visible
    };
  }

  /** Links the handoff to the requirements its todos point at, so a requirement page shows which handoffs touched it. */
  async linkRequirements(input: { project: string; reference: string | number }, principal: Principal): Promise<string[]> {
    const workPackage = await this.resolveHandoff(input.reference, input.project, principal);
    const todos = todoItems(this.todoEntries(workPackage));
    const references = [...new Set(todos.map(item => item.requirement).filter((value): value is string => Boolean(value)))];
    const linked: string[] = [];
    for (const reference of references) {
      try {
        const target = await this.resolve(reference, input.project, principal);
        if (!this.canRead(target, principal)) continue;
        await this.client.createRelation(workPackage.id, target.id, "relates");
        linked.push(reference);
      } catch (error) {
        // An existing relation is the desired end state, so a conflict is not a failure.
        if (error instanceof OpenProjectHttpError && error.status === 409) linked.push(reference);
      }
    }
    return linked;
  }
}
