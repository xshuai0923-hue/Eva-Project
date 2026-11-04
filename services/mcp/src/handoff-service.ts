// Session-to-session handoffs. A handoff records where one working session stopped so
// the next one can continue without re-deriving it, and is always one writer to one
// reader: parallelism comes from having several handoffs, never from several sessions
// claiming one.
//
// Requirement state is never copied in here. Todo lines may point at a requirement, and
// that pointer is resolved on read, so the two can only ever be reported as disagreeing
// — never silently stored twice.

import { OpenProjectHttpError } from "./openproject.js";
import { WEB_CHANNEL } from "./signature.js";
import {
  FIELD,
  boundClaimSession,
  requireLockVersion,
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
      claimLabel: this.readText(workPackage, FIELD.claimLabel),
      claimedAt: this.readText(workPackage, FIELD.claimedAt),
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
    const scope = await this.visibleProject(input.project, principal);
    return this.serializeOperation(["handoff-thread", scope.id, input.thread], () =>
      this.serializeCreation(String(scope.id), input.id, () => this.saveUnlocked(input, principal)));
  }

  private async saveUnlocked(input: SaveHandoffInput, principal: Principal): Promise<{ replayed: boolean; item: HandoffSummary }> {
    if (!input.title.trim() || !input.id.trim()) throw new RequirementValidationError("标题和交接 ID 不能为空");
    const existing = await this.findByHandoffId(input.id, input.project, principal);
    if (existing) {
      this.assertOwnerOrAdmin(existing, principal);
      // Resending the same record is an idempotent retry. Resending the same id with
      // different content is someone trying to correct a handoff, and silently handing
      // back the old record would throw their correction away without saying so.
      const changed = this.changedSections(existing, input);
      if (changed.length) {
        throw new RequirementConflictError(
          `Handoff ${input.id} already exists and ${changed.join(", ")} differ; use handoff_update_section to edit it, or save a new id and declare it the successor`
        );
      }
      if (this.readText(existing, HANDOFF_FIELD.thread) !== input.thread) {
        throw new RequirementConflictError("交接线程与已保存记录不同");
      }
      if (this.readList(existing, HANDOFF_FIELD.state)[0] !== "草稿") {
        return { replayed: true, item: this.summarize(existing) };
      }
    }

    const pending = await this.awaitingOnThread(input.thread, input.project, principal);
    if (pending && !input.supersede) {
      throw new RequirementConflictError(
        `Thread ${input.thread} already has an unclaimed handoff ${this.readText(pending, FIELD.requirementId) ?? pending.id}; pass supersede to replace it`
      );
    }

    const targets = new Map<number, WorkPackage>();
    if (pending && pending.id !== existing?.id) {
      this.assertOwnerOrAdmin(pending, principal);
      targets.set(pending.id, pending);
    }
    const previous = input.previous ?? (existing ? this.readText(existing, HANDOFF_FIELD.previous) : null);
    if (previous) {
      const earlier = await this.resolveHandoff(previous, input.project, principal);
      if (this.readText(earlier, HANDOFF_FIELD.thread) !== input.thread || earlier.id === existing?.id) {
        throw new RequirementValidationError("上一任交接必须属于同一线程且不能指向自身");
      }
      const state = this.readList(earlier, HANDOFF_FIELD.state)[0];
      if (state !== "已归档" && state !== "已作废") {
        this.assertClaimOrOwner(earlier, principal, input.sourceSessionId);
        targets.set(earlier.id, earlier);
      }
    }
    if (targets.size) await this.assertEditPermission(input.project, principal);

    const entries = parseTodoSection(input.sections.待办 ?? "");
    const todos = serializeTodoSection(entries);
    const counts = countTodos(entries);

    const scope = await this.visibleProject(input.project, principal);
    await this.assertCreatePermission(scope, principal);
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
    this.writeField(payload, HANDOFF_FIELD.state, targets.size ? "草稿" : AWAITING);
    this.writeField(payload, HANDOFF_FIELD.repository, input.repository);
    this.writeField(payload, HANDOFF_FIELD.branch, input.branch);
    this.writeField(payload, HANDOFF_FIELD.baseCommit, input.baseCommit);
    this.writeField(payload, HANDOFF_FIELD.todoTotal, counts.total);
    this.writeField(payload, HANDOFF_FIELD.todoDone, counts.done);
    const predecessor = previous ?? (pending ? this.readText(pending, FIELD.requirementId) : null);
    if (predecessor) this.writeField(payload, HANDOFF_FIELD.previous, predecessor);
    this.writeField(payload, HANDOFF_FIELD.expectedAgent, input.expectedAgent ?? "不限");
    this.statusLink(payload, targets.size ? "草稿" : AWAITING);

    let created = existing ?? await this.client.createWorkPackage(scope.id, payload);
    const now = new Date().toISOString();
    try {
      for (const earlier of targets.values()) {
        await this.transition(earlier, "已归档", `被 ${input.id} 接续，自动归档。`, now);
      }
      if (this.readList(created, HANDOFF_FIELD.state)[0] === "草稿") {
        created = await this.transition(created, AWAITING, "前任交接已归档，开放接手。", now);
      }
    } catch (error) {
      throw new RequirementConflictError(
        `交接 ${input.id}（#${created.id}）已保存为草稿，接续未完成。刷新核对后可用相同创建请求继续；${error instanceof Error ? error.message : "保存失败"}`
      );
    }
    return { replayed: existing !== null, item: this.summarize(created) };
  }

  /** Which parts of an existing handoff a repeated save would have changed. */
  private changedSections(existing: WorkPackage, input: SaveHandoffInput): string[] {
    const normalise = (value: string | null | undefined) => (value ?? "").trim();
    const raw = existing.description?.raw ?? "";
    const changed: string[] = [];
    if (normalise(existing.subject) !== normalise(input.title)) changed.push("标题");
    for (const name of HANDOFF_PROSE_SECTIONS) {
      if ((normalise(this.readMarkdownSection(raw, name)) || "尚无。") !== (normalise(input.sections[name]) || "尚无。")) changed.push(name);
    }
    const todos = serializeTodoSection(parseTodoSection(input.sections.待办 ?? ""));
    if ((normalise(this.readMarkdownSection(raw, "待办")) || "尚无。") !== (normalise(todos) || "尚无。")) changed.push("待办");
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
    await this.assertEditPermission(input.project, principal);
    const workPackage = await this.resolveHandoff(input.reference, input.project, principal);
    const state = this.readList(workPackage, HANDOFF_FIELD.state)[0];
    if (state === "已归档" || state === "已作废") {
      throw new RequirementValidationError("已归档或已作废的交接无法接手");
    }
    // A same-session replay may return without writing, even after its original
    // version was consumed, but the caller must still supply a valid version.
    requireLockVersion(input.expectedLockVersion);
    const current = this.readText(workPackage, FIELD.claimedSession);
    if (this.matchesClaim(workPackage, principal, input.sessionId)) return { replayed: true, item: this.summarize(workPackage) };
    this.assertExpectedVersion(workPackage, input.expectedLockVersion);
    if (current) {
      throw new RequirementConflictError(`Handoff is already claimed by session ${current}`);
    }
    const human = principal.via === WEB_CHANNEL && input.sessionId === `web:${principal.userId}` && !input.agent;
    if (!input.agent && !human) throw new RequirementValidationError("请指定接手 Agent");

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
        raw: `${workPackage.description?.raw ?? ""}\n\n## 变更记录\n\n- ${input.claimedAt}：由 ${principal.displayName}（${principal.userId}）${human ? "在网页接手" : `${input.agent} Session ${input.sessionId} 领取`}。${
          expected && expected !== "不限" && expected !== input.agent ? `覆盖期望接手 Agent ${expected}。` : ""
        }${input.scope}`
      }
    };
    this.writeField(payload, FIELD.claimedAgent, input.agent || null);
    this.writeField(payload, FIELD.claimedSession, boundClaimSession(principal.userId, input.sessionId));
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
    await this.assertEditPermission(input.project, principal);
    const workPackage = await this.resolveHandoff(input.reference, input.project, principal);
    this.assertExpectedVersion(workPackage, input.expectedLockVersion);
    const current = this.readText(workPackage, FIELD.claimedSession);
    if (!current) return this.summarize(workPackage);
    if (!input.reason.trim()) throw new RequirementValidationError("请填写释放原因");
    const state = this.readList(workPackage, HANDOFF_FIELD.state)[0];
    if (state === "已归档" || state === "已作废") throw new RequirementValidationError("归档或作废后不能释放接手");

    // Without this, a session that ends mid-work strands its thread forever.
    const takeover = !this.matchesClaim(workPackage, principal, input.sessionId);
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
    await this.assertEditPermission(input.project, principal);
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
    await this.assertEditPermission(input.project, principal);
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
    await this.assertEditPermission(input.project, principal);
    const workPackage = await this.resolveHandoff(input.reference, input.project, principal);
    this.assertExpectedVersion(workPackage, input.expectedLockVersion);
    this.assertClaimOrOwner(workPackage, principal, input.sessionId);
    if (!this.map.handoffStatusHrefs?.[input.state]) {
      throw new RequirementValidationError(`Unknown handoff state: ${input.state}`);
    }
    const currentSession = this.readText(workPackage, FIELD.claimedSession);
    if (input.state === "已接手" && !currentSession) {
      throw new RequirementValidationError("请使用接手交接操作，登记接手人后进入已接手");
    }
    if ((input.state === "待接手" || input.state === "草稿") && currentSession) {
      throw new RequirementValidationError("请先释放接手，再调整为待接手或草稿");
    }
    return this.summarize(await this.transition(workPackage, input.state, input.note, input.changedAt));
  }

  async list(input: {
    project: string;
    thread?: string;
    query?: string;
    state?: string;
    unclaimed?: boolean;
    cursor?: string;
    pageSize?: number;
  }, principal: Principal): Promise<{ items: HandoffSummary[]; nextCursor: string | null; total: number }> {
    const pageSize = Math.min(Math.max(input.pageSize ?? 20, 1), 50);
    if (!Number.isSafeInteger(pageSize)) throw new RequirementValidationError("Invalid page size");
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
    const query = input.query?.trim().toLocaleLowerCase();
    if (query) items = items.filter(item => [item.subject, this.readText(item, FIELD.requirementId),
      this.readText(item, HANDOFF_FIELD.thread)].some(value => value?.toLocaleLowerCase().includes(query)));
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
