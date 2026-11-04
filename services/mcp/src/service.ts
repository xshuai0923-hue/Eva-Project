import { principalLogin } from "./principal-login.js";
import { HANDOFF_FIELD } from "./handoff-service.js";
import { OpenProjectHttpError, type OpenProjectApi } from "./openproject.js";
import {
  FIELD,
  hrefId,
  linkTitle,
  OpenProjectRecordService,
  relationWorkPackageId,
  RequirementConflictError,
  RequirementValidationError
} from "./record-service.js";
import { parseSignature, signed } from "./signature.js";
import type {
  Attachment,
  FieldMap,
  HalLink,
  Principal,
  ProjectResource,
  Relation,
  RequirementSummary,
  UserResource,
  WorkPackage
} from "./types.js";

/** One API v3 filter, as `{ field: { operator, values } }`. */
export type ListFilter = Record<string, { operator: string; values: string[] }>;

/** Sorting a merge means comparing locally, so only fields readable off the record. */
const LIST_SORT_FIELDS = ["updatedAt", "createdAt", "id", "subject"] as const;
type ListSortField = (typeof LIST_SORT_FIELDS)[number];
type ListSort = { field: ListSortField; direction: "asc" | "desc" };

/** What a requirement list is narrowed and ordered by. */
type ListQuery = {
  project: string;
  typeId?: number;
  cursor?: string;
  pageSize?: number;
  module?: string;
  responsibleAgent?: string;
  state?: string;
  unclaimed?: boolean;
  ready?: boolean;
  /** Substring of the subject, matched by OpenProject rather than in memory. */
  subject?: string;
  /** Exact work package ids. An id is looked up, not searched: `~` on a number would
   *  match 157 while someone was after 57. */
  ids?: string[];
  /** Substring of the business id (EVAPROJECT-REQ-…), matched by OpenProject. Searched,
   *  unlike a work package id: a part of one is how it is remembered. */
  requirementId?: string;
  excludeStates?: string[];
  /** Logical field name to the values chosen for it; several values are an OR. */
  select?: Record<string, string[]>;
  filters?: ListFilter[];
  sortBy?: string;
};

/** One source request per round trip; OpenProject caps a page at 200. */
const LIST_SOURCE_PAGE_SIZE = 200;
/** Merging keeps a prefix in memory, so paging depth is bounded rather than unbounded. */
const LIST_DEPTH_LIMIT = 2000;
/** Ids and nothing else, for working out the shape of a match without its records. */
const ID_ONLY = "total,count,elements/id";
/** Ids per `id` or `parent` filter, which keeps each query string short. */
const ID_FILTER_CHUNK = 200;
/** A readiness check costs a request per candidate; refuse rather than crawl. */
const READY_SCAN_LIMIT = 500;
/** The home page reads every requirement of a project, so it is bounded the same way. */
const DASHBOARD_SCAN_LIMIT = LIST_DEPTH_LIMIT;
/** Work someone holds that has not moved for this long is called out as stalled. */
const DASHBOARD_STALE_DAYS = 7;
/** How many requirements a home page list shows; its total is always the whole count. */
const DASHBOARD_LIST_LIMIT = 6;
const DASHBOARD_RECENT_LIMIT = 8;
/** A trend is a row of periods; beyond this it stops being readable anyway. */
const DASHBOARD_MAX_BUCKETS = 40;

/** What the top bar searches (Brian 2026-09-24, #218), each field its own filter. */
const SEARCH_FIELDS = ["id", "title", "body", "comment"] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];
const SEARCH_GROUPS = ["requirements", "handoffs"] as const;
export type SearchGroupName = (typeof SEARCH_GROUPS)[number];
/** A query is a few words; past these it is a paste rather than a search. */
const SEARCH_MAX_WORDS = 5;
const SEARCH_MAX_LENGTH = 100;
const SEARCH_PAGE_SIZE_MAX = 50;
/** Every match of a word is read as ids, so this bounds the scan the way it bounds a list. */
const SEARCH_SCAN_LIMIT = LIST_DEPTH_LIMIT;
/** Which group a match goes in is all the scan has to carry. */
const SEARCH_SCAN_SELECT = "total,count,elements/id,elements/type";
/** Characters of body shown either side of the first match. */
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 90;

/** Requirements counted the ways the home page reports them. */
export type DashboardTally = {
  /** Everything counted, Bugs included. */
  total: number;
  bugs: number;
  /** Nobody has claimed it, and it is neither finished nor cancelled. */
  unclaimed: number;
  /** Current 需求状态 -> how many. A requirement without one is in none of these. */
  states: Record<string, number>;
};

/** By 负责 Agent as the records carry it, so a new Agent shows up without a change here. */
export type DashboardAgentTally = DashboardTally & { agent: string | null };

/** Enough of a requirement to list it and link to it. */
export type DashboardItem = {
  id: string | null;
  workPackageId: number;
  project: string | null;
  title: string;
  typeName: string | null;
  state: string | null;
  responsibleAgent: string | null;
  claimedAgent: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type DashboardList = { total: number; items: DashboardItem[] };

/** One period of a trend: what was created in it, and what was completed in it. */
export type DashboardBucket = { created: number; createdBugs: number; completed: number };

/** Everything the home page shows for one project, or for all of them together. */
export type DashboardView = {
  /** The pool as it stands, whenever its requirements were created. */
  current: DashboardTally & {
    agents: DashboardAgentTally[];
    /** Unfinished requirements by 模块; one listing several modules counts in each. */
    modules: Array<{ module: string | null; open: number }>;
  };
  /** What was created in the chosen period, by its state now. */
  period: DashboardTally & { agents: DashboardAgentTally[] };
  trend: {
    buckets: DashboardBucket[];
    /** Finished, but with no 完成时间 on record, so in no bucket of the trend. */
    undatedCompletions: number;
  };
  attention: {
    /** Waiting for its requester to accept it. */
    acceptance: DashboardList;
    /** Waiting for the requirement itself to be confirmed. */
    confirmation: DashboardList;
    /** Held and in progress, yet untouched for DASHBOARD_STALE_DAYS or more. */
    stale: DashboardList;
  };
  recent: DashboardItem[];
};

export type DashboardProject = DashboardView & { identifier: string; name: string };

/** One requirement or handoff found by the search. */
export type SearchHit = {
  kind: "requirement" | "handoff";
  id: string | null;
  workPackageId: number;
  project: string | null;
  projectName: string | null;
  title: string;
  typeName: string | null;
  state: string | null;
  updatedAt: string | null;
  /** Where the words were found. */
  matched: SearchField[];
  /** The body around its first match, as plain text; null when the body did not match. */
  snippet: string | null;
};

export type SearchGroup = { total: number; page: number; pageSize: number; items: SearchHit[] };

export type SearchResult = {
  query: string;
  words: string[];
  groups: Partial<Record<SearchGroupName, SearchGroup>>;
};

function parseListSort(value?: string): ListSort {
  if (!value) return { field: "updatedAt", direction: "desc" };
  const [field = "", direction = "desc"] = value.split(":");
  if (!(LIST_SORT_FIELDS as readonly string[]).includes(field)) {
    throw new RequirementValidationError(
      `Cannot sort by ${field}; use one of ${LIST_SORT_FIELDS.join(", ")}`
    );
  }
  if (direction !== "asc" && direction !== "desc") {
    throw new RequirementValidationError(`Sort direction must be asc or desc, not ${direction}`);
  }
  return { field: field as ListSortField, direction };
}

const sortValue = (workPackage: WorkPackage, field: ListSortField): string | number =>
  field === "id" ? workPackage.id : String(workPackage[field] ?? "");

/** Must order records exactly as the server does, including the id tiebreak. */
function compareWorkPackages(sort: ListSort) {
  const sign = sort.direction === "asc" ? 1 : -1;
  return (a: WorkPackage, b: WorkPackage): number => {
    const left = sortValue(a, sort.field);
    const right = sortValue(b, sort.field);
    if (left < right) return -sign;
    if (left > right) return sign;
    return a.id - b.id;
  };
}

type ListCondition = ListFilter[string];

/**
 * One condition per field, which is all OpenProject takes: of two filters with the same
 * name it keeps the last rather than ANDing them (measured on 17.8.0). A reader's pick in
 * 可见性 or 需求提交人 was overwritten that way by the visibility condition added after it
 * (#207). `=` and `!` on one field fold into the single condition meaning both; null when
 * nothing can meet them all.
 */
function combineFilters(filters: ListFilter[]): ListFilter[] | null {
  const combined = new Map<string, ListCondition>();
  for (const filter of filters) {
    for (const [key, condition] of Object.entries(filter)) {
      const earlier = combined.get(key);
      if (!earlier) {
        combined.set(key, condition);
        continue;
      }
      const both = bothConditions(earlier, condition);
      if (both === undefined) {
        throw new RequirementValidationError(`Cannot combine two conditions on ${key}; filter it once`);
      }
      if (both === null) return null;
      combined.set(key, both);
    }
  }
  return [...combined].map(([key, condition]) => ({ [key]: condition }));
}

/** `a` AND `b` as one condition: null when nothing meets both, undefined when one cannot say it. */
function bothConditions(a: ListCondition, b: ListCondition): ListCondition | null | undefined {
  if (a.operator === "!" && b.operator === "!") {
    return { operator: "!", values: [...new Set([...a.values, ...b.values])] };
  }
  const [chosen, other] = a.operator === "=" ? [a, b] : [b, a];
  if (chosen.operator !== "=" || (other.operator !== "=" && other.operator !== "!")) return undefined;
  const values = chosen.values.filter(value => other.values.includes(value) === (other.operator === "="));
  return values.length ? { operator: "=", values } : null;
}

/** The words of a query: split on white space, a repeat dropped whatever its case. */
export function searchWords(query: string): string[] {
  const words: string[] = [];
  const seen = new Set<string>();
  for (const word of query.trim().split(/\s+/)) {
    const key = word.toLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  return words;
}

/** #218 or 218: a word that also names a work package by its number. */
function workPackageNumber(word: string): number | null {
  const match = /^#?(\d{1,9})$/.exec(word);
  return match ? Number(match[1]) : null;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A body as one line of plain text: markdown's marks dropped where they are only marks —
 * headings, quotes, bullets, checkboxes, callout labels, emphasis, code ticks — so what is
 * left reads as the sentence that was written.
 */
function plainText(markdown: string): string {
  return markdown
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, "")
    .replace(/\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/gi, "")
    .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The text around the first of the words a body contains, or null when it has none. */
export function searchSnippet(markdown: string, words: string[]): string | null {
  if (!words.length) return null;
  const text = plainText(markdown);
  const found = new RegExp(words.map(escapeRegExp).join("|"), "iu").exec(text);
  if (!found) return null;
  let start = Math.max(0, found.index - SNIPPET_BEFORE);
  let end = Math.min(text.length, found.index + found[0].length + SNIPPET_AFTER);
  // Never between the two halves of a character written as a surrogate pair, nor inside a
  // Latin word, where "…l e2e" reads as a typo for the word it cut.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(start))) start -= 1;
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text.charAt(end))) end += 1;
  const inWord = (at: number) => /[\w-]/.test(text.charAt(at - 1)) && /[\w-]/.test(text.charAt(at));
  while (start > 0 && start < found.index && inWord(start)) start += 1;
  while (end < text.length && end > found.index + found[0].length && inWord(end)) end -= 1;
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** The work package a requirement sits under, or null when it has no parent. */
const parentWorkPackageId = (workPackage: WorkPackage): number | null => {
  const link = Array.isArray(workPackage._links.parent) ? undefined : workPackage._links.parent;
  return link?.href ? Number(hrefId(link.href)) : null;
};

/** The numeric id behind a HAL user link, or null when the actor was anonymous. */
const linkUserId = (link: HalLink | undefined): number | null => {
  if (!link?.href) return null;
  const id = Number(hrefId(link.href));
  return Number.isInteger(id) ? id : null;
};

/**
 * The headings a requirement body carries, in the order the template writes them.
 *
 * Named so a reader can ask for part of a record instead of all of it; a body that grew
 * its own heading is still reachable by reading the whole thing.
 */
export const REQUIREMENT_SECTIONS = [
  "用户原文", "Agent 理解", "范围", "验收条件", "来源", "讨论", "交付证据", "变更记录"
] as const;

/**
 * The states that say someone is working on a requirement or has delivered it. An agent
 * gets there only by holding the claim, so 实际认领 Agent and the claim session always
 * say who: sessions carried on by handoffs used to move requirements through these
 * without ever claiming them, and the owner had to fill the agent in by hand afterwards
 * (Brian 2026-09-23, #199). Claiming is what moves a requirement to 进行中.
 */
export const CLAIMED_STATES: readonly string[] = ["进行中", "已实现待提交", "待验证/验收"];

export type CreateRequirementInput = {
  project: string;
  id: string;
  title: string;
  /** The requirement this one belongs under, in the same project; optional. */
  parent?: string | number;
  typeId?: number;
  rawText: string;
  agentUnderstanding: string;
  modules: string[];
  responsibleAgent: string;
  intakeStatus: string;
  state: string;
  priority: string;
  requesterType: string;
  requesterName?: string | null;
  requesterId?: string | null;
  visibility: "公开" | "私有";
  recordedAt?: string | null;
  sourceUpdatedAt?: string | null;
  proposedAt?: string | null;
  proposedTimePrecision: string;
  sourceSessionId?: string | null;
  sourceMessageId?: string | null;
  sourceLabel: string;
  requestId: string;
  claimedAgent?: string | null;
  claimedSession?: string | null;
  claimLabel?: string | null;
  claimedAt?: string | null;
  claimScope?: string | null;
  requiredForParent?: boolean;
  verificationStatus?: string;
  userAcceptance?: string;
  scope?: string | null;
  acceptanceCriteria?: string | null;
};

export type CreateChildRequirementInput = Omit<CreateRequirementInput, "project" | "requiredForParent"> & {
  requiredForParent: boolean;
};

/** A delivery that is a commit. Evidence with no kind is this one, as all of it was. */
export type GitEvidence = {
  kind?: "git";
  repository: string;
  sha: string;
  paths: string[];
  verification: string;
  acceptanceStatus: "已验收" | "不适用";
  acceptanceSource: string;
};

/**
 * A delivery that is files outside any repository: a global skill, a hook, local
 * configuration. No commit exists for them, so none is asked for -- the evidence is
 * where the files actually are and what changed in them. Before this, finishing such
 * work meant a placeholder SHA or leaving it at 已实现待提交 for good (#157).
 */
export type FileEvidence = {
  kind: "file";
  locations: string[];
  change: string;
  verification: string;
  acceptanceStatus: "已验收" | "不适用";
  acceptanceSource: string;
};

export type CompletionEvidence = GitEvidence | FileEvidence;

const filled = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";

// Re-exported so existing importers of ./service.js keep working.
export { RequirementConflictError, RequirementValidationError };

export class RequirementService extends OpenProjectRecordService {
  constructor(
    client: OpenProjectApi,
    map: FieldMap,
    /** The OpenProject login of an Eva-Project identity, to name who signed an entry. */
    private readonly loginOf: (userId: string) => string | null = userId => userId
  ) {
    super(client, map);
  }


  /**
   * Handoffs are work packages in the same project, so every requirement-side read has
   * to exclude them explicitly or the requirement pool fills up with handoff records.
   */
  private assertNotHandoff(workPackage: WorkPackage): void {
    const handoffTypeId = this.handoffTypeId();
    if (handoffTypeId !== null && this.workPackageTypeId(workPackage) === handoffTypeId) {
      throw new RequirementValidationError(
        "This work package is a handoff, not a requirement; use the handoff tools"
      );
    }
  }

  /**
   * Projects this caller may see, as OpenProject judges it: their memberships plus
   * whatever is public. Previously this returned every project on the instance, because
   * the MCP reads through a service token and the project's own rules never reached the
   * caller.
   */
  async listProjects(principal: Principal, input: { cursor?: string; pageSize?: number } = {}): Promise<{
    items: Array<{ id: number; identifier: string; name: string }>;
    nextCursor: string | null;
    total: number;
  }> {
    const pageSize = Math.min(Math.max(input.pageSize ?? 50, 1), 100);
    const offset = input.cursor ? Number(input.cursor) : 1;
    if (!Number.isInteger(offset) || offset < 1) {
      throw new RequirementValidationError("Invalid cursor");
    }
    // An archived project cannot serve as a pool -- OpenProject answers 403 for its
    // types -- so listing one offers a dead end that only announces itself after someone
    // has clicked it. Leaving `filters` off does not mean "no filtering" either: without
    // this the archived ones come back too.
    const visibility = await this.visibilityFilter(principal);
    const result = await this.client.listProjects({
      pageSize: String(pageSize),
      offset: String(offset),
      sortBy: JSON.stringify([["name", "asc"]]),
      filters: JSON.stringify([
        { active: { operator: "=", values: ["t"] } },
        ...(visibility ?? [])
      ])
    });
    return {
      items: result._embedded.elements.map(({ id, identifier, name }) => ({ id, identifier, name })),
      nextCursor: offset * pageSize < result.total ? String(offset + 1) : null,
      total: result.total
    };
  }

  /** The `visible` filter for this caller, or null when they are an admin. */
  private async visibilityFilter(principal: Principal): Promise<ListFilter[] | null> {
    if (principal.role === "admin") return null;
    const userId = await this.openProjectUserId(principal);
    if (userId === null) {
      throw new RequirementValidationError(
        `No OpenProject account matches ${principalLogin(principal) ?? "(unlinked)"}; ` +
        "ask an administrator to link a webpage account in MCP user management (openProjectLogin)"
      );
    }
    return [{ visible: { operator: "=", values: [String(userId)] } }];
  }

  async createProject(input: { project: string; name?: string }, principal: Principal): Promise<{
    created: boolean;
    project: { id: number; identifier: string; name: string };
    types: Array<{ id: number; name: string }>;
  }> {
    const identifier = input.project.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(identifier)) {
      throw new RequirementValidationError(
        "project must start with a lowercase letter or number and contain only lowercase letters, numbers, hyphens or underscores"
      );
    }
    let existing: ProjectResource | null = null;
    try {
      existing = await this.client.getProject(identifier);
    } catch (error) {
      if (!(error instanceof OpenProjectHttpError) || error.status !== 404) throw error;
    }

    // Reusing a project is a read, never a reason to grant or upgrade membership.
    if (existing) {
      const project = await this.visibleProject(identifier, principal);
      const types = await this.assertUsableAsPool(project);
      return { created: false, project: { id: project.id, identifier: project.identifier, name: project.name }, types };
    }

    const userId = await this.openProjectUserId(principal);
    if (userId === null) {
      throw new RequirementValidationError("No linked OpenProject account; ask an administrator to link an active webpage account before creating a project");
    }
    // Check the current account rather than relying on the cached login-to-ID mapping.
    const user = await this.client.getUser(userId);
    if (user.login !== principalLogin(principal) || user.status !== "active") {
      throw new RequirementValidationError("An active linked OpenProject account is required to create a project");
    }
    const roles = (await this.client.listProjectRoles())._embedded.elements
      .filter(role => role.name === "成员" || role.name === "Member");
    if (roles.length !== 1) {
      throw new RequirementValidationError("Configure exactly one grantable project role named 成员 or Member before creating a project; no administrator-role fallback is allowed");
    }
    const role = roles[0]!;
    const project = await this.client.createProject(identifier, input.name?.trim() || identifier);
    try {
      const membership = await this.client.createProjectMembership(project.id, userId, role.id);
      const saved = await this.client.getMembership(membership.id);
      if (saved._links.project.href !== `/api/v3/projects/${project.id}` ||
          saved._links.principal.href !== `/api/v3/users/${userId}` ||
          saved._links.roles.length !== 1 ||
          !saved._links.roles.some(link => link.href === `/api/v3/roles/${role.id}`)) {
        throw new Error("Creator membership did not match the requested project, user and role");
      }
      const visible = await this.client.listProjects({
        filters: JSON.stringify([
          { visible: { operator: "=", values: [String(userId)] } },
          { id: { operator: "=", values: [String(project.id)] } }
        ]),
        pageSize: "1"
      });
      if (!visible._embedded.elements.some(item => item.id === project.id)) {
        throw new Error("Creator still cannot see the new project");
      }
    } catch {
      // Do not delete a partially created project, or broaden access on the next call.
      throw new RequirementValidationError(
        `Project ${project.identifier} (ID ${project.id}) was created, but creator membership could not be verified. ` +
        "Ask an administrator to check its members; reusing an existing project will not grant access automatically."
      );
    }
    this.projects.set(identifier, project);
    this.projects.set(String(project.id), project);
    // Checked on the way out rather than assumed, and checked for a project that
    // already existed too: binding one as a pool is the same promise as making one.
    const types = await this.assertUsableAsPool(project);
    return {
      created: true,
      project: { id: project.id, identifier: project.identifier, name: project.name },
      types
    };
  }

  /**
   * Refuses to hand back a project that cannot hold what a pool holds.
   *
   * A project's enabled types cannot be set from here: the API v3 project form does
   * not list types as writable, and a PATCH carrying `_links.types` answers 200 and
   * changes nothing -- the same silent acceptance that once dropped every 认领范围.
   * So this reports instead of repairing. Reporting it here is the point: the damage
   * otherwise surfaces much later and far away, as a requirement that cannot be filed
   * as a Bug, or a handoff with no type to be written as.
   */
  private async assertUsableAsPool(
    project: ProjectResource
  ): Promise<Array<{ id: number; name: string }>> {
    const enabled = (await this.client.listProjectTypes(project.id))._embedded.elements;
    const present = new Set(enabled.map(type => type.id));
    const missing = this.poolTypeIds().filter(id => !present.has(id));
    if (missing.length > 0) {
      const handoff = this.handoffTypeId();
      const cost = missing.filter(id => id !== handoff).length > 0
        ? "requirements cannot be filed under every type the pool uses"
        : "handoffs cannot be written in it";
      throw new RequirementValidationError(
        `Project ${project.identifier} is missing type ${missing.join(", ")}, so ${cost}. ` +
        "A project's types come from the instance-wide defaults (Type#is_default) and cannot be set through this API, " +
        "so enable them on the project itself under 项目设置 > 工作包 > 类型, " +
        "and converge the defaults with deploy/bootstrap/openproject_bootstrap.rb so the next project does not repeat it " +
        "-- that script does not run on deploy."
      );
    }
    return enabled.map(type => ({ id: type.id, name: type.name }));
  }

  summarize(workPackage: WorkPackage): RequirementSummary {
    const projectLink = Array.isArray(workPackage._links.project) ? undefined : workPackage._links.project;
    const projectId = projectLink?.href ? hrefId(projectLink.href) : "";
    const typeLink = Array.isArray(workPackage._links.type) ? undefined : workPackage._links.type;
    const parentLink = Array.isArray(workPackage._links.parent) ? undefined : workPackage._links.parent;
    return {
      id: this.readText(workPackage, FIELD.requirementId),
      workPackageId: workPackage.id,
      project: this.projects.get(projectId)?.identifier ?? projectLink?.title ?? (projectId || null),
      title: workPackage.subject,
      typeId: typeLink?.href ? Number(hrefId(typeLink.href)) : null,
      typeName: typeLink?.title ?? null,
      state: this.readList(workPackage, FIELD.state)[0] ?? null,
      status: linkTitle(workPackage._links.status),
      modules: this.readList(workPackage, FIELD.modules),
      responsibleAgent: this.readList(workPackage, FIELD.responsibleAgent)[0] ?? null,
      claimedAgent: this.readList(workPackage, FIELD.claimedAgent)[0] ?? null,
      claimedSession: this.readText(workPackage, FIELD.claimedSession),
      priority: this.readText(workPackage, FIELD.priority),
      requesterType: this.readList(workPackage, FIELD.requesterType)[0] ?? null,
      requesterName: this.readText(workPackage, FIELD.requesterName),
      requesterId: this.readText(workPackage, FIELD.requesterId),
      visibility: (this.readList(workPackage, FIELD.visibility)[0] as "公开" | "私有" | undefined) ?? null,
      ownerUserId: this.readText(workPackage, FIELD.ownerUserId),
      updatedAt: workPackage.updatedAt ?? null,
      lockVersion: workPackage.lockVersion,
      // Enough for a list to nest rows whose parent is on the same page, and to say
      // "under X" for one whose parent is not, without a request per row.
      parentWorkPackageId: parentLink?.href ? Number(hrefId(parentLink.href)) : null,
      parentTitle: parentLink?.title ?? null
    };
  }

  /**
   * Requirements the caller may read, filtered and paged by OpenProject rather than in
   * memory.
   *
   * `canRead` is `公开 OR mine`, and API v3 ANDs its filters with no cross-field OR, so
   * one query cannot express it. Two disjoint queries can:
   *
   *   A: 可见性 = 公开
   *   B: 需求提交人 = me AND 可见性 ! 公开
   *
   * A ∪ B is `公开 ∪ mine` because a public record of mine is already in A, and A ∩ B is
   * empty because the two disagree on 可见性 — so the totals simply add up. `!` on a list
   * custom field also matches records with no value at all (measured on 17.8.0), which is
   * what keeps a 可见性-less record of mine in B instead of silently vanishing.
   *
   * The page is still passed through `canRead` at the end. If these filters and that
   * predicate ever drift apart, a page comes up short instead of leaking someone else's
   * requirement, and `visibility streams agree with canRead` in the tests fails.
   */
  async list(
    input: ListQuery,
    principal: Principal
  ): Promise<{ items: RequirementSummary[]; nextCursor: string | null; total: number }> {
    const pageSize = Math.min(Math.max(input.pageSize ?? 20, 1), 50);
    const offset = input.cursor ? Number(input.cursor) : 1;
    if (!Number.isInteger(offset) || offset < 1) {
      throw new RequirementValidationError("Invalid cursor");
    }
    const sort = parseListSort(input.sortBy);

    const project = await this.visibleProject(input.project, principal);
    const filters = await this.listFilters(input, project.id);
    if (!filters) return { items: [], nextCursor: null, total: 0 };
    const streams = this.visibilityStreams(filters, principal);

    // A readiness check costs a dependency lookup per requirement, so it cannot be a
    // filter OpenProject applies. It stays exhaustive, with a ceiling instead of an
    // unbounded scan.
    if (input.ready) {
      const scanned = await this.collectStreams(project.id, streams, sort, READY_SCAN_LIMIT + 1);
      if (scanned.length > READY_SCAN_LIMIT) {
        throw new RequirementValidationError(
          `ready scans every candidate and more than ${READY_SCAN_LIMIT} match; narrow the query first`
        );
      }
      const checks = await Promise.all(scanned.map(async workPackage => ({
        workPackage,
        ready: !this.readText(workPackage, FIELD.claimedSession) &&
          this.readList(workPackage, FIELD.intakeStatus)[0] === "已受理" &&
          (await this.blockingDependencies(workPackage)).length === 0
      })));
      const items = checks.filter(item => item.ready).map(item => item.workPackage);
      return this.pageOf(items, items.length, offset, pageSize, principal);
    }

    const start = (offset - 1) * pageSize;
    const need = start + pageSize;
    if (need > LIST_DEPTH_LIMIT) {
      throw new RequirementValidationError(
        `Cannot page beyond ${LIST_DEPTH_LIMIT} requirements; narrow the query instead`
      );
    }
    const { items, total } = await this.collectStreamsWithTotal(project.id, streams, sort, need);
    return this.pageOf(items, total, offset, pageSize, principal);
  }

  /**
   * The pool page's list: the whole match laid out as a tree, then cut into pages of
   * `pageSize` rows, children counted like any other row (Brian 2026-09-25, #258).
   *
   * Top-level requirements come in id order, each followed by everything under it that
   * matches, siblings in id order too, so a child filed long after its parent still sits
   * under it (#201). A family cut by a page boundary carries on at the top of the next
   * page, and every row says how deep it sits so the page can keep indenting it. #201
   * paged top-level requirements with their whole families instead and did not count the
   * children: mila-3's default view, 80 rows of which 40 top-level, was one page.
   *
   * A requirement is top-level when its parent is not among the matches — it has none, or
   * the filters or its visibility leave the parent out — and then it still names the parent.
   *
   * Only ids travel for the whole match. Which ones sit under another match, and under
   * which, takes their own records, since `select` cannot name the parent; beyond those,
   * whole records are read for this page's top-level rows alone.
   */
  async listTree(
    input: Omit<ListQuery, "ready">,
    principal: Principal
  ): Promise<{ items: Array<RequirementSummary & { depth: number }>; nextCursor: string | null; total: number }> {
    const pageSize = Math.min(Math.max(input.pageSize ?? 20, 1), 50);
    const offset = input.cursor ? Number(input.cursor) : 1;
    if (!Number.isInteger(offset) || offset < 1) {
      throw new RequirementValidationError("Invalid cursor");
    }
    const sort = parseListSort(input.sortBy ?? "id:asc");
    if (sort.field !== "id") {
      throw new RequirementValidationError("A tree is paged in id order; sort by id");
    }

    const project = await this.visibleProject(input.project, principal);
    const filters = await this.listFilters(input, project.id);
    if (!filters) return { items: [], nextCursor: null, total: 0 };
    const streams = this.visibilityStreams(filters, principal);

    const scan = await this.collectStreamsWithTotal(project.id, streams, sort, LIST_DEPTH_LIMIT, ID_ONLY);
    if (scan.total > LIST_DEPTH_LIMIT) {
      throw new RequirementValidationError(
        `More than ${LIST_DEPTH_LIMIT} requirements match; narrow the query instead`
      );
    }
    const matching = scan.items.map(item => item.id);
    // The matches whose parent is a match too; nothing else sits under anything here.
    const records = new Map(
      (await this.matchesWhere(project.id, streams, sort, "parent", matching)).map(record => [record.id, record])
    );
    const children = new Map<number, number[]>();
    for (const record of records.values()) {
      const parent = parentWorkPackageId(record);
      if (parent === null) continue;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent)?.push(record.id);
    }
    // The chunks of a `parent` query arrive one after another, not merged into one order.
    for (const siblings of children.values()) {
      siblings.sort((left, right) => sort.direction === "asc" ? left - right : right - left);
    }
    const rows: Array<{ id: number; depth: number }> = [];
    const placed = new Set<number>();
    // Nesting is as deep as OpenProject lets it be; `placed` keeps a malformed chain from
    // looping or showing a row twice.
    const walk = (id: number, depth: number) => {
      if (placed.has(id)) return;
      placed.add(id);
      rows.push({ id, depth });
      for (const child of children.get(id) ?? []) walk(child, depth + 1);
    };
    for (const id of matching) if (!records.has(id)) walk(id, 0);
    for (const id of matching) walk(id, 0);

    const start = (offset - 1) * pageSize;
    const page = rows.slice(start, start + pageSize);
    const unread = page.filter(row => !records.has(row.id)).map(row => row.id);
    for (const record of await this.matchesWhere(project.id, streams, sort, "id", unread)) {
      records.set(record.id, record);
    }

    return {
      items: page.flatMap(({ id, depth }) => {
        const record = records.get(id);
        return record && this.canRead(record, principal) ? [{ ...this.summarize(record), depth }] : [];
      }),
      nextCursor: start + pageSize < rows.length ? String(offset + 1) : null,
      total: scan.total
    };
  }

  /**
   * The matches whose `id` or `parent` is one of `ids` — ids taken from the match itself —
   * a chunk of them per query so the query string stays short however many there are.
   */
  private async matchesWhere(
    projectId: number | null,
    streams: ListFilter[][],
    sort: ListSort,
    field: "id" | "parent",
    ids: number[],
    select?: string
  ): Promise<WorkPackage[]> {
    const found: WorkPackage[] = [];
    for (let start = 0; start < ids.length; start += ID_FILTER_CHUNK) {
      const values = ids.slice(start, start + ID_FILTER_CHUNK).map(String);
      // OpenProject keeps one filter per name — a second `id` replaces an id search rather
      // than ANDing with it (measured on 17.8.0). The ids come from the match, so the
      // search has already had its say and this filter stands in for it.
      const narrowed = streams.map(filters => [
        ...filters.filter(filter => !(field in filter)),
        { [field]: { operator: "=", values } }
      ]);
      found.push(...(await this.collectStreamsWithTotal(projectId, narrowed, sort, LIST_DEPTH_LIMIT, select)).items);
    }
    return found;
  }

  /**
   * The ids asked for that are work packages of this project. OpenProject refuses an `id`
   * filter naming anything else — another project's work package, or a number not used
   * yet — with a 400 for the whole query, 「Id过滤器有无效值」 (measured on 17.8.0). The pool
   * page looks an id up as it is typed, so 3 and 36 on the way to 367 were each refused and
   * the reader got the raw request as an error (Brian 2026-09-28, #371). The set is asked
   * about whole, and one by one only when that is refused: a person names a handful.
   */
  private async idsInProject(projectId: number, ids: string[]): Promise<string[]> {
    const accepted = async (values: string[]) => {
      try {
        await this.client.listProjectWorkPackages(projectId, {
          pageSize: "1", offset: "1", select: "total",
          filters: JSON.stringify([{ id: { operator: "=", values } }])
        });
        return true;
      } catch (error) {
        if (error instanceof OpenProjectHttpError && error.status === 400) return false;
        throw error;
      }
    };
    if (await accepted(ids)) return ids;
    const known: string[] = [];
    for (const id of ids) if (await accepted([id])) known.push(id);
    return known;
  }

  /**
   * The filters a list query asks OpenProject for, before visibility is added; null when
   * nothing can match, which is when none of the ids asked for is in this project.
   */
  private async listFilters(input: Omit<ListQuery, "ready">, projectId: number): Promise<ListFilter[] | null> {
    const base: ListFilter[] = [];
    const handoffTypeId = this.handoffTypeId();
    if (input.typeId !== undefined) {
      if (handoffTypeId !== null && input.typeId === handoffTypeId) {
        throw new RequirementValidationError(
          "The handoff type is not a requirement type; use the handoff tools"
        );
      }
      base.push({ type: { operator: "=", values: [String(input.typeId)] } });
    } else if (handoffTypeId !== null && await this.typeEnabled(projectId, handoffTypeId)) {
      // Only when the project actually has that type. OpenProject rejects a filter whose
      // value is not among the project's own types with a 400, so on a project created
      // without the 交接 type -- which is every newly created one -- excluding it
      // unconditionally made every list read fail, tool and page alike. Nothing to
      // exclude there anyway.
      base.push({ type: { operator: "!", values: [String(handoffTypeId)] } });
    }
    // `~` is OpenProject's "contains", so this narrows the query rather than filtering a
    // page after it arrives: a match on page four would otherwise never be seen, and the
    // total would count rows the reader cannot have.
    const subject = input.subject?.trim();
    if (subject) {
      base.push({ subject: { operator: "~", values: [subject] } });
    }
    const ids = input.ids?.map(value => value.trim()).filter(value => /^\d+$/.test(value));
    if (ids?.length) {
      const known = await this.idsInProject(projectId, ids);
      if (!known.length) return null;
      base.push({ id: { operator: "=", values: known } });
    }
    const requirementId = input.requirementId?.trim();
    if (requirementId) {
      base.push({ [this.field(FIELD.requirementId).key]: { operator: "~", values: [requirementId] } });
    }
    if (input.module) {
      base.push({
        [this.field(FIELD.modules).key]: {
          operator: "=", values: [hrefId(this.option(FIELD.modules, input.module))]
        }
      });
    }
    if (input.responsibleAgent) {
      base.push({
        [this.field(FIELD.responsibleAgent).key]: {
          operator: "=", values: [hrefId(this.option(FIELD.responsibleAgent, input.responsibleAgent))]
        }
      });
    }
    if (input.state) {
      base.push({
        [this.field(FIELD.state).key]: {
          operator: "=", values: [hrefId(this.option(FIELD.state, input.state))]
        }
      });
    }
    // Used to keep 已完成 out of the default view while leaving it one filter away.
    // `!` also matches requirements carrying no 需求状态, which is what should happen:
    // an unset state is not a completed one.
    if (input.excludeStates?.length) {
      base.push({
        [this.field(FIELD.state).key]: {
          operator: "!",
          values: input.excludeStates.map(state => hrefId(this.option(FIELD.state, state)))
        }
      });
    }
    if (input.unclaimed) {
      base.push({ [this.field(FIELD.claimedSession).key]: { operator: "!*", values: [] } });
    }
    // Column filters: one filter per field, so values inside a column are an OR and the
    // columns AND together — which is what picking from several headers should mean.
    for (const [name, values] of Object.entries(input.select ?? {})) {
      if (!values.length) continue;
      if (name === "type") {
        base.push({ type: { operator: "=", values } });
        continue;
      }
      const field = this.field(name);
      base.push({
        [field.key]: {
          operator: "=",
          values: field.kind === "list" ? values.map(value => hrefId(this.option(name, value))) : values
        }
      });
    }
    // Caller-supplied filters are ANDed on top, so they can narrow the result but never
    // widen it past what the visibility streams allow.
    base.push(...(input.filters ?? []));
    return base;
  }

  /**
   * The disjoint queries whose union is exactly what this caller may read. Each names a
   * field once, with the caller's own condition on it folded in; one left with nothing to
   * match is not asked at all.
   */
  private visibilityStreams(base: ListFilter[], principal: Principal): ListFilter[][] {
    let streams = [base];
    if (principal.role !== "admin") {
      const visibility = this.field(FIELD.visibility).key;
      const publicOption = hrefId(this.option(FIELD.visibility, "公开"));
      streams = [
        [...base, { [visibility]: { operator: "=", values: [publicOption] } }],
        [
          ...base,
          { [this.field(FIELD.ownerUserId).key]: { operator: "=", values: [principal.userId] } },
          { [visibility]: { operator: "!", values: [publicOption] } }
        ]
      ];
    }
    return streams.map(combineFilters).filter((stream): stream is ListFilter[] => stream !== null);
  }

  private async collectStreams(
    projectId: number | null,
    streams: ListFilter[][],
    sort: ListSort,
    need: number
  ): Promise<WorkPackage[]> {
    return (await this.collectStreamsWithTotal(projectId, streams, sort, need)).items;
  }

  /**
   * The first `need` records of the merged streams, plus the exact total. The streams are
   * disjoint, so their totals add; each arrives already sorted by the same keys, so the
   * prefix of the merge only needs the first `need` of each. `select` narrows what each
   * record carries, as OpenProject's own parameter does. With no project the streams read
   * across projects, and their own `project` filter says which.
   */
  private async collectStreamsWithTotal(
    projectId: number | null,
    streams: ListFilter[][],
    sort: ListSort,
    need: number,
    select?: string
  ): Promise<{ items: WorkPackage[]; total: number }> {
    const fetched = await Promise.all(
      streams.map(filters => this.fetchStream(projectId, filters, sort, need, select))
    );
    const total = fetched.reduce((sum, stream) => sum + stream.total, 0);
    const single = fetched.length === 1 ? fetched[0] : undefined;
    if (single) return { items: single.items, total };
    // The streams are disjoint by construction, so this only ever removes something if a
    // filter did not apply as expected. Better a repeated record dropped than shown twice.
    const seen = new Set<number>();
    const merged = fetched
      .flatMap(stream => stream.items)
      .filter(item => !seen.has(item.id) && seen.add(item.id))
      .sort(compareWorkPackages(sort));
    return { items: merged.slice(0, need), total };
  }

  private async fetchStream(
    projectId: number | null,
    filters: ListFilter[],
    sort: ListSort,
    need: number,
    select?: string
  ): Promise<{ items: WorkPackage[]; total: number }> {
    const items: WorkPackage[] = [];
    let total = 0;
    // OpenProject's offset counts pages, not records, so every request of one scan has to
    // ask for the same page size. Cutting the last one down to what was still missing
    // brought back an earlier page of that smaller size: records 51–100 where 201–250 were
    // wanted (#206). `need` is spread evenly over as few requests as the cap allows.
    const pageSize = Math.ceil(need / Math.ceil(need / LIST_SOURCE_PAGE_SIZE));
    let page = 1;
    do {
      const parameters = {
        pageSize: String(pageSize),
        offset: String(page),
        // The id tiebreak has to be on the server too, or two records sharing a sort key
        // could land in a different order there than in the merge, and paging would then
        // repeat one and skip another.
        sortBy: JSON.stringify(sort.field === "id"
          ? [["id", sort.direction]]
          : [[sort.field, sort.direction], ["id", "asc"]]),
        // Always sent, even empty. Omitting it does not mean "no filters" to OpenProject:
        // it falls back to the instance's default work package query, which on this
        // instance is 「open status」 plus 「not 交接」. Measured on production — the same
        // project answers total=2 with the parameter left out and total=7 with an empty
        // one, so leaving it out silently drops closed requirements. It also made a
        // project without the 交接 type fail outright, because that default query filters
        // on a type the project does not have.
        filters: JSON.stringify(filters),
        ...(select ? { select } : {})
      };
      const result = projectId === null
        ? await this.client.listWorkPackages(parameters)
        : await this.client.listProjectWorkPackages(projectId, parameters);
      total = result.total;
      const batch = result._embedded.elements;
      // A page that comes back empty while the total still claims more would otherwise
      // spin forever.
      if (batch.length === 0) break;
      items.push(...batch);
      page += 1;
    } while (items.length < Math.min(need, total));
    return { items: items.slice(0, need), total };
  }

  private pageOf(
    items: WorkPackage[],
    total: number,
    offset: number,
    pageSize: number,
    principal: Principal
  ): { items: RequirementSummary[]; nextCursor: string | null; total: number } {
    const start = (offset - 1) * pageSize;
    const page = items.slice(start, start + pageSize).filter(item => this.canRead(item, principal));
    return {
      items: page.map(item => this.summarize(item)),
      nextCursor: start + pageSize < total ? String(offset + 1) : null,
      total
    };
  }

  /**
   * What the home page shows, for every project this caller may see and for all of them
   * together: the pool as it stands, what was created in [from, to), a trend over the
   * periods between consecutive `edges`, and the requirements waiting on someone.
   *
   * Read through the same visibility streams as `list`, so a private requirement is only
   * counted or listed for the person it belongs to. The numbers summarise the pool and
   * must never know more than the pool shows.
   */
  async dashboard(
    input: { from: string; to: string; edges?: string[]; now?: number },
    principal: Principal
  ): Promise<{
    generatedAt: string;
    from: string;
    to: string;
    edges: string[];
    staleDays: number;
    all: DashboardView;
    projects: DashboardProject[];
  }> {
    const from = Date.parse(input.from);
    const to = Date.parse(input.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      throw new RequirementValidationError("from and to must be timestamps, with from before to");
    }
    const edges = (input.edges ?? []).map(value => Date.parse(value));
    const ascending = edges.every((value, index) =>
      Number.isFinite(value) && (index === 0 || value > (edges[index - 1] as number)));
    if (edges.length === 1 || edges.length > DASHBOARD_MAX_BUCKETS + 1 || !ascending) {
      throw new RequirementValidationError(
        `edges must be 2 to ${DASHBOARD_MAX_BUCKETS + 1} ascending timestamps, or none`
      );
    }
    const now = input.now ?? Date.now();
    const handoffTypeId = this.handoffTypeId();

    // The whole pool is read once: the current numbers need every requirement anyway,
    // and the period, the trend and the lists are all cut from the same records.
    const read = await Promise.all((await this.everyVisibleProject(principal)).map(async project => {
      const base: ListFilter[] = [];
      if (handoffTypeId !== null && await this.typeEnabled(project.id, handoffTypeId)) {
        base.push({ type: { operator: "!", values: [String(handoffTypeId)] } });
      }
      const { items, total } = await this.collectStreamsWithTotal(
        project.id, this.visibilityStreams(base, principal), { field: "id", direction: "asc" }, DASHBOARD_SCAN_LIMIT
      );
      if (total > DASHBOARD_SCAN_LIMIT) {
        throw new RequirementValidationError(
          `More than ${DASHBOARD_SCAN_LIMIT} requirements in ${project.identifier}; the home page cannot count them all`
        );
      }
      return { project, items: items.filter(item => this.canRead(item, principal)) };
    }));

    // A record names its project by title; a link needs the identifier, which only the
    // project it was read from knows.
    const projectOf = new Map<number, string>();
    for (const { project, items } of read) for (const item of items) projectOf.set(item.id, project.identifier);
    const span = { from, to, edges, now, projectOf };
    return {
      generatedAt: new Date(now).toISOString(),
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      edges: edges.map(value => new Date(value).toISOString()),
      staleDays: DASHBOARD_STALE_DAYS,
      all: this.dashboardView(read.flatMap(entry => entry.items), span),
      projects: read.map(({ project, items }) => ({
        identifier: project.identifier,
        name: project.name,
        ...this.dashboardView(items, span)
      }))
    };
  }

  private dashboardView(
    items: WorkPackage[],
    span: { from: number; to: number; edges: number[]; now: number; projectOf: Map<number, string> }
  ): DashboardView {
    const created = (item: WorkPackage): number => Date.parse(item.createdAt ?? "");
    const updated = (item: WorkPackage): number => Date.parse(item.updatedAt ?? "") || 0;
    const stateOf = (item: WorkPackage): string => this.readList(item, FIELD.state)[0] ?? "";
    const inPeriod = items.filter(item => created(item) >= span.from && created(item) < span.to);

    const buckets: DashboardBucket[] = span.edges.slice(1).map(() => ({ created: 0, createdBugs: 0, completed: 0 }));
    const bucketAt = (time: number | null): DashboardBucket | undefined => {
      if (time === null || !Number.isFinite(time)) return undefined;
      const index = span.edges.findIndex((edge, at) => at + 1 < span.edges.length &&
        time >= edge && time < (span.edges[at + 1] as number));
      return index < 0 ? undefined : buckets[index];
    };
    let undatedCompletions = 0;
    for (const item of items) {
      const arrived = bucketAt(created(item));
      if (arrived) {
        arrived.created += 1;
        if (this.isBug(item)) arrived.createdBugs += 1;
      }
      if (!this.map.completionStates.includes(stateOf(item))) continue;
      const completedAt = this.completionTime(item);
      if (completedAt === null) undatedCompletions += 1;
      const finished = bucketAt(completedAt);
      if (finished) finished.completed += 1;
    }

    const toItem = (item: WorkPackage): DashboardItem => {
      const summary = this.summarize(item);
      return {
        id: summary.id,
        workPackageId: summary.workPackageId,
        project: span.projectOf.get(item.id) ?? summary.project,
        title: summary.title,
        typeName: summary.typeName,
        state: summary.state,
        responsibleAgent: summary.responsibleAgent,
        claimedAgent: summary.claimedAgent,
        createdAt: item.createdAt ?? null,
        updatedAt: summary.updatedAt
      };
    };
    // Longest waiting first: the one at the top is the one most overdue for attention.
    const waiting = (matching: WorkPackage[]): DashboardList => ({
      total: matching.length,
      items: [...matching]
        .sort((a, b) => updated(a) - updated(b) || a.id - b.id)
        .slice(0, DASHBOARD_LIST_LIMIT)
        .map(toItem)
    });
    const staleBefore = span.now - DASHBOARD_STALE_DAYS * 24 * 60 * 60 * 1000;

    return {
      current: { ...this.tally(items), agents: this.tallyByAgent(items), modules: this.openByModule(items) },
      period: { ...this.tally(inPeriod), agents: this.tallyByAgent(inPeriod) },
      trend: { buckets, undatedCompletions },
      attention: {
        acceptance: waiting(items.filter(item => stateOf(item) === "待验证/验收")),
        confirmation: waiting(items.filter(item => stateOf(item) === "待确认")),
        stale: waiting(items.filter(item =>
          (stateOf(item) === "进行中" || stateOf(item) === "已实现待提交") && updated(item) < staleBefore))
      },
      recent: [...items]
        .sort((a, b) => updated(b) - updated(a) || b.id - a.id)
        .slice(0, DASHBOARD_RECENT_LIMIT)
        .map(toItem)
    };
  }

  /**
   * When a requirement was completed, as its completion recorded it: every completion
   * writes 「完成时间：…」 into 交付证据, and a re-completion adds another, so the latest is
   * the one that counts. Null when none is on record -- a status changed in OpenProject
   * directly, say -- which leaves the time unknown rather than guessed from updatedAt.
   */
  private completionTime(item: WorkPackage): number | null {
    const evidence = this.readMarkdownSection(item.description?.raw ?? "", "交付证据") ?? "";
    let latest: number | null = null;
    for (const match of evidence.matchAll(/完成时间：\s*(\S+)/g)) {
      const time = Date.parse(match[1] ?? "");
      if (Number.isFinite(time) && (latest === null || time > latest)) latest = time;
    }
    return latest;
  }

  private isBug(item: WorkPackage): boolean {
    return linkTitle(item._links.type)?.toLowerCase() === "bug";
  }

  /** A finished or cancelled requirement is not waiting for anyone, claimed or not. */
  private endedStates(): Set<string> {
    return new Set([...this.map.completionStates, "取消"]);
  }

  /**
   * Values of a list field in the field's own option order, so a row keeps its place
   * while the numbers move; a value the field map does not list yet follows, and none
   * at all comes last.
   */
  private optionOrder(field: string): (a: string | null, b: string | null) => number {
    const known = Object.keys(this.field(field).options ?? {});
    const rank = (value: string | null): number =>
      value === null ? known.length + 2 : known.includes(value) ? known.indexOf(value) : known.length + 1;
    return (a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b));
  }

  private openByModule(items: WorkPackage[]): Array<{ module: string | null; open: number }> {
    const ended = this.endedStates();
    const counts = new Map<string | null, number>();
    for (const item of items) {
      if (ended.has(this.readList(item, FIELD.state)[0] ?? "")) continue;
      const modules = this.readList(item, FIELD.modules);
      for (const module of modules.length ? modules : [null]) counts.set(module, (counts.get(module) ?? 0) + 1);
    }
    const order = this.optionOrder(FIELD.modules);
    return [...counts.entries()].sort(([a], [b]) => order(a, b)).map(([module, open]) => ({ module, open }));
  }

  private async everyVisibleProject(principal: Principal): Promise<Array<{ id: number; identifier: string; name: string }>> {
    const projects: Array<{ id: number; identifier: string; name: string }> = [];
    let cursor: string | null = null;
    do {
      const page = await this.listProjects(principal, { pageSize: 100, ...(cursor ? { cursor } : {}) });
      projects.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return projects;
  }

  private tally(items: WorkPackage[]): DashboardTally {
    const ended = this.endedStates();
    const tally: DashboardTally = { total: 0, bugs: 0, unclaimed: 0, states: {} };
    for (const item of items) {
      const state = this.readList(item, FIELD.state)[0];
      tally.total += 1;
      if (this.isBug(item)) tally.bugs += 1;
      if (state) tally.states[state] = (tally.states[state] ?? 0) + 1;
      if (!this.readText(item, FIELD.claimedSession) && !(state && ended.has(state))) tally.unclaimed += 1;
    }
    return tally;
  }

  private tallyByAgent(items: WorkPackage[]): DashboardAgentTally[] {
    const groups = new Map<string | null, WorkPackage[]>();
    for (const item of items) {
      const agent = this.readList(item, FIELD.responsibleAgent)[0] ?? null;
      groups.set(agent, [...(groups.get(agent) ?? []), item]);
    }
    const order = this.optionOrder(FIELD.responsibleAgent);
    return [...groups.entries()]
      .sort(([a], [b]) => order(a, b))
      .map(([agent, group]) => ({ agent, ...this.tally(group) }));
  }

  /**
   * The top bar's search (Brian 2026-09-24, #218): the requirements and handoffs of every
   * project this caller may see, by business id, title, body and comments, in two groups.
   *
   * A record matches when each word is somewhere among those four fields, so every word
   * is asked of every field on its own. OpenProject's full-text filter answers neither
   * half: it wants all the words inside one field — a word from the title and another
   * from the body found nothing — and it also reads every text custom field, so "brian"
   * matched each record through its owner (measured on 17.8.0). A word that is a work
   * package number, #218 or 218, matches that work package as well.
   *
   * Only ids and types travel for the whole match, through the pool's visibility streams;
   * whole records are read for the page shown, and pass through canRead. A match on the
   * business id comes first, then one on the title, then the newest.
   */
  async search(
    input: { query: string; project?: string; group?: string; page?: number; pageSize?: number },
    principal: Principal
  ): Promise<SearchResult> {
    const query = input.query.trim();
    if (query.length > SEARCH_MAX_LENGTH) {
      throw new RequirementValidationError(`搜索内容最长 ${SEARCH_MAX_LENGTH} 个字`);
    }
    const words = searchWords(query);
    if (words.length > SEARCH_MAX_WORDS) {
      throw new RequirementValidationError(`一次最多搜 ${SEARCH_MAX_WORDS} 个词`);
    }
    const group = input.group;
    if (group !== undefined && !(SEARCH_GROUPS as readonly string[]).includes(group)) {
      throw new RequirementValidationError(`没有「${group}」这一组`);
    }
    const groups = group ? [group as SearchGroupName] : [...SEARCH_GROUPS];
    const page = input.page ?? 1;
    if (!Number.isInteger(page) || page < 1) throw new RequirementValidationError("页码无效");
    const pageSize = Math.min(Math.max(Math.trunc(input.pageSize ?? 20) || 20, 1), SEARCH_PAGE_SIZE_MAX);

    const result: SearchResult = { query, words, groups: {} };
    for (const name of groups) result.groups[name] = { total: 0, page, pageSize, items: [] };
    if (!words.length) return result;
    // One project when asked for — an agent checking its own pool — and otherwise every
    // project this caller may see, as the top bar searches.
    const projects = input.project
      ? [await this.visibleProject(input.project, principal)].map(({ id, identifier, name }) => ({ id, identifier, name }))
      : await this.everyVisibleProject(principal);
    if (!projects.length) return result;

    const inProjects: ListFilter = { project: { operator: "=", values: projects.map(project => String(project.id)) } };
    const streams = (...filters: ListFilter[]) => this.visibilityStreams([inProjects, ...filters], principal);
    const sort: ListSort = { field: "id", direction: "desc" };
    const keys: Record<SearchField, string> = {
      id: this.field(FIELD.requirementId).key,
      title: "subject",
      body: "description",
      comment: "comment"
    };

    // For each word, the fields every record it matched was found in. A word at a time, so
    // a query nothing can meet stops at the first word that proves it.
    const typeOf = new Map<number, number | null>();
    const perWord: Array<Map<number, Set<SearchField>>> = [];
    let candidates: number[] | null = null;
    for (const word of words) {
      const fields = new Map<number, Set<SearchField>>();
      const note = (items: WorkPackage[], field: SearchField) => {
        for (const item of items) {
          typeOf.set(item.id, this.workPackageTypeId(item));
          fields.set(item.id, (fields.get(item.id) ?? new Set<SearchField>()).add(field));
        }
      };
      const number = workPackageNumber(word);
      await Promise.all([
        ...SEARCH_FIELDS.map(async field => {
          const { items, total } = await this.collectStreamsWithTotal(
            null, streams({ [keys[field]]: { operator: "~", values: [word] } }), sort, SEARCH_SCAN_LIMIT, SEARCH_SCAN_SELECT
          );
          if (total > SEARCH_SCAN_LIMIT) {
            throw new RequirementValidationError(`「${word}」匹配的记录超过 ${SEARCH_SCAN_LIMIT} 条，请多加一个词缩小范围`);
          }
          note(items, field);
        }),
        ...(number === null ? [] : [
          this.collectStreamsWithTotal(
            null, streams({ id: { operator: "=", values: [String(number)] } }), sort, 1, SEARCH_SCAN_SELECT
          ).then(({ items }) => note(items, "id"))
        ])
      ]);
      perWord.push(fields);
      candidates = candidates === null ? [...fields.keys()] : candidates.filter(id => fields.has(id));
      if (candidates.length === 0) return result;
    }

    const handoffType = this.handoffTypeId();
    const ranked = new Map<SearchGroupName, Array<{ id: number; rank: number; matched: SearchField[] }>>(
      groups.map(name => [name, []])
    );
    for (const id of candidates ?? []) {
      const each = perWord.map(fields => fields.get(id) ?? new Set<SearchField>());
      const everyWordIn = (field: SearchField) => each.every(fields => fields.has(field));
      const kind: SearchGroupName = handoffType !== null && typeOf.get(id) === handoffType ? "handoffs" : "requirements";
      ranked.get(kind)?.push({
        id,
        rank: everyWordIn("id") ? 0 : everyWordIn("title") ? 1 : 2,
        matched: SEARCH_FIELDS.filter(field => each.some(fields => fields.has(field)))
      });
    }

    const shown: Array<[SearchGroupName, Array<{ id: number; matched: SearchField[] }>]> = [];
    for (const [name, matches] of ranked) {
      matches.sort((a, b) => a.rank - b.rank || b.id - a.id);
      result.groups[name]!.total = matches.length;
      shown.push([name, matches.slice((page - 1) * pageSize, page * pageSize)]);
    }
    const records = new Map((await this.matchesWhere(
      null, streams(), sort, "id", shown.flatMap(([, matches]) => matches.map(match => match.id))
    )).map(record => [record.id, record]));
    const projectById = new Map(projects.map(project => [String(project.id), project]));
    for (const [name, matches] of shown) {
      result.groups[name]!.items = matches.flatMap(match => {
        const record = records.get(match.id);
        return record && this.canRead(record, principal)
          ? [this.searchHit(record, name, match.matched, words, projectById)]
          : [];
      });
    }
    return result;
  }

  private searchHit(
    workPackage: WorkPackage,
    group: SearchGroupName,
    matched: SearchField[],
    words: string[],
    projects: Map<string, { identifier: string; name: string }>
  ): SearchHit {
    const projectLink = Array.isArray(workPackage._links.project) ? undefined : workPackage._links.project;
    const project = projectLink?.href ? projects.get(hrefId(projectLink.href)) : undefined;
    const typeLink = Array.isArray(workPackage._links.type) ? undefined : workPackage._links.type;
    const handoff = group === "handoffs";
    // A field map from before handoffs has no handoff state to read, and no handoffs either.
    const state = handoff
      ? (this.map.fields[HANDOFF_FIELD.state] ? this.readList(workPackage, HANDOFF_FIELD.state)[0] : undefined)
      : this.readList(workPackage, FIELD.state)[0];
    return {
      kind: handoff ? "handoff" : "requirement",
      id: this.readText(workPackage, FIELD.requirementId),
      workPackageId: workPackage.id,
      project: project?.identifier ?? null,
      projectName: project?.name ?? projectLink?.title ?? null,
      title: workPackage.subject,
      typeName: typeLink?.title ?? null,
      state: state ?? null,
      updatedAt: workPackage.updatedAt ?? null,
      matched,
      snippet: matched.includes("body") ? searchSnippet(workPackage.description?.raw ?? "", words) : null
    };
  }

  async get(
    reference: string | number,
    project: string,
    principal: Principal,
    sections?: string[]
  ): Promise<Record<string, unknown>> {
    const workPackage = await this.resolve(reference, project, principal);
    this.assertReadable(workPackage, principal);
    this.assertNotHandoff(workPackage);
    const [dependencies, attachments, children] = await Promise.all([
      this.dependencyOverview(workPackage, principal),
      this.client.listAttachments(workPackage),
      this.childWorkPackages(workPackage)
    ]);
    // Summarised like the children are. Handing back the raw link instead left callers
    // with a title and no id: the page could name the parent but not open it.
    let parent: RequirementSummary | null = null;
    const parentLink = Array.isArray(workPackage._links.parent) ? undefined : workPackage._links.parent;
    if (parentLink?.href) {
      const parentWorkPackage = await this.client.getWorkPackage(relationWorkPackageId(parentLink));
      if (this.canRead(parentWorkPackage, principal)) parent = this.summarize(parentWorkPackage);
    }
    const incompleteChildren = children
      .filter(child => this.readBool(child, FIELD.requiredForParent))
      .filter(child => {
        const state = this.readList(child, FIELD.state)[0];
        return !state || !this.map.completionStates.includes(state);
      });
    const state = this.readList(workPackage, FIELD.state)[0] ?? null;
    const body = workPackage.description?.raw ?? "";
    const wanted = sections?.map(name => name.trim()).filter(Boolean) ?? null;
    // Reading a record should not cost its whole history. Naming sections returns those
    // and leaves the body out; naming none is exactly what this always did, because
    // every existing caller -- the pool page included -- asks for the record as a whole.
    const content: Record<string, unknown> = wanted
      ? {
          sections: Object.fromEntries(wanted
            .map(name => [name, this.readMarkdownSection(body, name)] as const)
            .filter(([, value]) => value !== null))
        }
      : {
          description: body,
          agentUnderstanding: this.readMarkdownSection(body, "Agent 理解"),
          scope: this.readMarkdownSection(body, "范围"),
          acceptanceCriteria: this.readMarkdownSection(body, "验收条件")
        };

    return {
      summary: this.summarize(workPackage),
      ...content,
      // What there is to ask for, so choosing sections does not require reading
      // everything once to discover the names.
      sectionNames: this.markdownSectionNames(body),
      proposedAt: this.readText(workPackage, FIELD.proposedAt),
      proposedTimePrecision: this.readList(workPackage, FIELD.proposedTimePrecision)[0] ?? null,
      sourceSessionId: this.readText(workPackage, FIELD.sourceSessionId),
      sourceMessageId: this.readText(workPackage, FIELD.sourceMessageId),
      sourceLabel: this.readText(workPackage, FIELD.sourceLabel),
      claimLabel: this.readText(workPackage, FIELD.claimLabel),
      claimedAt: this.readText(workPackage, FIELD.claimedAt),
      claimScope: this.readText(workPackage, FIELD.claimScope),
      // Written on create and on completion, but never handed back until now, so the page
      // had no way to show them at all. 受理状态 was missing the same way and is the same
      // kind of attribute, so it comes along rather than waiting for its own round.
      intakeStatus: this.readList(workPackage, FIELD.intakeStatus)[0] ?? null,
      verificationStatus: this.readList(workPackage, FIELD.verificationStatus)[0] ?? null,
      userAcceptance: this.readList(workPackage, FIELD.userAcceptance)[0] ?? null,
      requiredForParent: this.readBool(workPackage, FIELD.requiredForParent),
      parent,
      children: children
        .filter(child => this.canRead(child, principal))
        .map(child => this.summarize(child)),
      dependencies: {
        blockedBy: dependencies.blockedBy,
        blocks: dependencies.blocks,
        related: dependencies.related
      },
      claim: {
        agent: this.readList(workPackage, FIELD.claimedAgent)[0] ?? null,
        session: this.readText(workPackage, FIELD.claimedSession),
        label: this.readText(workPackage, FIELD.claimLabel),
        claimedAt: this.readText(workPackage, FIELD.claimedAt),
        scope: this.readText(workPackage, FIELD.claimScope)
      },
      completion: {
        complete: state !== null && this.map.completionStates.includes(state),
        ready: dependencies.blockers.length === 0 && incompleteChildren.length === 0,
        blockingDependencies: dependencies.blockers,
        incompleteRequiredChildren: incompleteChildren.map(child => this.canRead(child, principal)
          ? this.compactSummary(this.summarize(child))
          : { id: "不可见必需子需求" })
      },
      attachments: attachments.map(item => ({
        id: item.id,
        fileName: item.fileName,
        fileSize: item.fileSize ?? null,
        contentType: item.contentType ?? null,
        createdAt: item.createdAt ?? null
      }))
    };
  }

  async tree(input: {
    project: string;
    reference: string | number;
    depth: number;
  }, principal: Principal): Promise<Record<string, unknown>> {
    const root = await this.resolve(input.reference, input.project, principal);
    this.assertReadable(root, principal);
    this.assertNotHandoff(root);
    const [node, dependencies, incompleteChildren] = await Promise.all([
      this.treeNode(root, 0, input.depth, principal, { count: 0 }),
      this.dependencyOverview(root, principal),
      this.requiredIncompleteChildren(root, principal)
    ]);
    return {
      project: input.project,
      depth: input.depth,
      root: node,
      dependencies: {
        blockedBy: dependencies.blockedBy,
        blocks: dependencies.blocks,
        related: dependencies.related
      },
      completion: {
        ready: dependencies.blockers.length === 0 && incompleteChildren.length === 0,
        blockingDependencies: dependencies.blockers,
        incompleteRequiredChildren: incompleteChildren
      }
    };
  }

  async create(
    input: CreateRequirementInput,
    principal: Principal,
    options: { sign?: boolean } = {}
  ): Promise<{ replayed: boolean; item: RequirementSummary }> {
    const project = await this.visibleProject(input.project, principal);
    const existing = await this.findByRequirementId(input.id, project.identifier, principal);
    if (existing) {
      this.assertReadable(existing, principal);
      return { replayed: true, item: this.summarize(existing) };
    }
    if (principal.role !== "admin" && input.requesterId && input.requesterId !== principal.userId) {
      throw new RequirementValidationError("requesterId must match the authenticated user");
    }
    if (CLAIMED_STATES.includes(input.state) && !input.claimedSession) {
      throw new RequirementValidationError(
        `A new requirement cannot start as ${input.state}: register it as 待认领 and claim it with requirements_claim, which moves it to 进行中`
      );
    }
    const requesterId = principal.role === "admin" ? input.requesterId ?? null : principal.userId;
    const requesterName = principal.role === "admin" ? input.requesterName ?? null : principal.displayName;
    // Bound in the create itself, so a requirement split out of another is never left
    // at the top level by a second call that did not happen (#148, #192). Optional: a
    // requirement can stand on its own.
    const parent = input.parent === undefined ? null : await this.resolve(input.parent, input.project, principal);
    if (parent) this.assertOwnerOrAdmin(parent, principal);

    const payload: Record<string, unknown> = {
      subject: input.title,
      description: {
        format: "markdown",
        raw: this.initialDescription(input)
      },
      _links: {
        type: { href: input.typeId === undefined ? this.map.typeHref : await this.typeHref(input.project, input.typeId, principal) },
        status: { href: this.statusHref(input.state) },
        ...(parent ? { parent: { href: `/api/v3/work_packages/${parent.id}` } } : {})
      }
    };
    this.writeField(payload, FIELD.requirementId, input.id);
    this.writeField(payload, FIELD.requesterType, input.requesterType);
    this.writeField(payload, FIELD.requesterName, requesterName);
    this.writeField(payload, FIELD.requesterId, requesterId);
    this.writeField(payload, FIELD.visibility, input.visibility);
    this.writeField(payload, FIELD.ownerUserId, principal.userId);
    this.writeField(payload, FIELD.recordedAt, input.recordedAt ?? null);
    this.writeField(payload, FIELD.sourceUpdatedAt, input.sourceUpdatedAt ?? null);
    this.writeField(payload, FIELD.modules, input.modules);
    this.writeField(payload, FIELD.responsibleAgent, input.responsibleAgent);
    this.writeField(payload, FIELD.intakeStatus, input.intakeStatus);
    this.writeField(payload, FIELD.state, input.state);
    this.writeField(payload, FIELD.priority, input.priority);
    this.writeField(payload, FIELD.proposedAt, input.proposedAt ?? null);
    this.writeField(payload, FIELD.proposedTimePrecision, input.proposedTimePrecision);
    this.writeField(payload, FIELD.sourceSessionId, input.sourceSessionId ?? null);
    this.writeField(payload, FIELD.sourceMessageId, input.sourceMessageId ?? null);
    this.writeField(payload, FIELD.sourceLabel, input.sourceLabel);
    this.writeField(payload, FIELD.claimedAgent, input.claimedAgent ?? null);
    this.writeField(payload, FIELD.claimedSession, input.claimedSession ?? null);
    this.writeField(payload, FIELD.claimLabel, input.claimLabel ?? null);
    this.writeField(payload, FIELD.claimedAt, input.claimedAt ?? null);
    this.writeField(payload, FIELD.claimScope, input.claimScope ?? null);
    this.writeField(payload, FIELD.requiredForParent, input.requiredForParent ?? false);
    this.writeField(payload, FIELD.verificationStatus, input.verificationStatus ?? "未验证");
    this.writeField(payload, FIELD.userAcceptance, input.userAcceptance ?? "待确认");

    const created = await this.client.createWorkPackage(project.id, payload);
    // A note posted right after a create is aggregated into the creation's own entry
    // (measured 2026-09-23), so a new requirement is signed without a second entry.
    if (options.sign !== false) await this.journalNote(created.id, "", principal);
    return { replayed: false, item: this.summarize(created) };
  }

  async createChildren(input: {
    project: string;
    parent: string | number;
    children: CreateChildRequirementInput[];
  }, principal: Principal): Promise<{
    parent: RequirementSummary;
    results: Array<Record<string, unknown>>;
  }> {
    const parent = await this.resolve(input.parent, input.project, principal);
    this.assertOwnerOrAdmin(parent, principal);
    const results: Array<Record<string, unknown>> = [];
    for (const child of input.children) {
      try {
        // Signed once, by setParent below: its note lands in the creation's entry
        // together with the parent it binds, rather than a second entry of its own.
        const created = await this.create({
          ...child,
          project: input.project,
          requiredForParent: child.requiredForParent
        }, principal, { sign: false });
        const bound = await this.setParent({
          project: input.project,
          child: created.item.workPackageId,
          parent: parent.id,
          requiredForParent: child.requiredForParent
        }, principal);
        results.push({
          id: child.id,
          ok: true,
          created: !created.replayed,
          requirement: this.compactSummary(bound)
        });
      } catch (error) {
        results.push({
          id: child.id,
          ok: false,
          error: error instanceof Error ? error.name : "InternalError",
          message: error instanceof Error ? error.message : "Unknown error"
        });
      }
    }
    return { parent: this.summarize(parent), results };
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
  }, principal: Principal): Promise<{ replayed: boolean; item: RequirementSummary }> {
    const workPackage = await this.resolve(input.reference, input.project, principal);
    this.assertReadable(workPackage, principal);
    this.assertExpectedVersion(workPackage, input.expectedLockVersion);
    const currentSession = this.readText(workPackage, FIELD.claimedSession);
    if (currentSession === input.sessionId) {
      return { replayed: true, item: this.summarize(workPackage) };
    }
    if (currentSession) {
      throw new RequirementConflictError(`Already claimed by session ${currentSession}`);
    }
    const blockers = await this.blockingDependencies(workPackage, principal);
    if (blockers.length > 0) {
      throw new RequirementConflictError(`Blocked by incomplete requirements: ${blockers.join(", ")}`);
    }

    const payload: Record<string, unknown> = { lockVersion: workPackage.lockVersion };
    this.writeField(payload, FIELD.claimedAgent, input.agent);
    this.writeField(payload, FIELD.claimedSession, input.sessionId);
    this.writeField(payload, FIELD.claimLabel, input.label);
    this.writeField(payload, FIELD.claimedAt, input.claimedAt);
    this.writeField(payload, FIELD.claimScope, input.scope);
    this.writeField(payload, FIELD.state, "进行中");
    this.addStatusLink(payload, "进行中");
    await this.journalNote(workPackage.id, "", principal);
    const updated = await this.updateWithConflict(workPackage.id, payload);
    return { replayed: false, item: this.summarize(updated) };
  }

  async release(input: {
    project: string;
    reference: string | number;
    sessionId: string;
    reason: string;
    releasedAt: string;
    expectedLockVersion?: number;
    takeover?: boolean;
  }, principal: Principal): Promise<RequirementSummary> {
    const workPackage = await this.resolve(input.reference, input.project, principal);
    this.assertReadable(workPackage, principal);
    this.assertExpectedVersion(workPackage, input.expectedLockVersion);
    const currentSession = this.readText(workPackage, FIELD.claimedSession);
    if (!currentSession) {
      return this.summarize(workPackage);
    }
    // A session that ends without releasing would otherwise hold its claim forever:
    // the owner could not clear it either, leaving the requirement permanently stuck.
    // Taking over stays deliberate — it needs an explicit flag and is kept in history.
    const takeover = currentSession !== input.sessionId;
    if (takeover) {
      if (!input.takeover) {
        throw new RequirementConflictError(
          `Claim belongs to session ${currentSession}; pass takeover to release another session's claim`
        );
      }
      this.assertOwnerOrAdmin(workPackage, principal);
    }
    const record = takeover
      ? `- ${input.releasedAt}：接管释放认领，原认领 Session ${currentSession}，由 ${principal.userId} 执行。${input.reason}`
      : `- ${input.releasedAt}：释放认领。${input.reason}`;
    const payload: Record<string, unknown> = { lockVersion: workPackage.lockVersion };
    for (const name of [FIELD.claimedAgent, FIELD.claimedSession, FIELD.claimLabel, FIELD.claimedAt, FIELD.claimScope]) {
      this.writeField(payload, name, null);
    }
    this.writeField(payload, FIELD.state, "待认领");
    this.addStatusLink(payload, "待认领");
    await this.journalNote(workPackage.id, record, principal);
    return this.summarize(await this.updateWithConflict(workPackage.id, payload));
  }

  async updateState(input: {
    project: string;
    reference: string | number;
    state: string;
    sessionId?: string;
    note: string;
    changedAt: string;
    expectedLockVersion?: number;
  }, principal: Principal, { byHand = false }: { byHand?: boolean } = {}): Promise<RequirementSummary> {
    // An agent finishes a requirement through requirements_complete, with its evidence. A
    // person on the pool page finishes one by hand like any other change of state, and that
    // is their acceptance (Brian 2026-09-23, #188).
    const finishing = this.map.completionStates.includes(input.state);
    if (finishing && !byHand) {
      throw new RequirementValidationError("Use requirements_complete for completion");
    }
    const workPackage = await this.resolve(input.reference, input.project, principal);
    this.assertReadable(workPackage, principal);
    this.assertExpectedVersion(workPackage, input.expectedLockVersion);
    this.assertClaimOrOwner(workPackage, principal, input.sessionId);
    if (!byHand && CLAIMED_STATES.includes(input.state)) {
      this.assertClaimed(workPackage, `move it to ${input.state}`);
    }
    const payload: Record<string, unknown> = { lockVersion: workPackage.lockVersion };
    this.writeField(payload, FIELD.state, input.state);
    this.addStatusLink(payload, input.state);
    if (finishing) {
      // The home page dates a completion by the 完成时间 in 交付证据, so one finished by hand
      // leaves its time there too, saying plainly that no evidence came with it.
      payload.description = this.withEvidence(workPackage,
        `完成时间：${input.changedAt}\n\n${principal.userId} 在网页上手动改为「${input.state}」，未附交付证据。`);
      if (input.state === "已完成") this.writeField(payload, FIELD.userAcceptance, "已验收");
    }
    await this.journalNote(
      workPackage.id,
      `- ${input.changedAt}：状态更新为「${input.state}」${finishing ? "，未附交付证据" : ""}。${input.note}`,
      principal
    );
    return this.summarize(await this.updateWithConflict(workPackage.id, payload));
  }

  async updateContent(input: {
    project: string;
    reference: string | number;
    title?: string;
    typeId?: number;
    responsibleAgent?: string;
    agentUnderstanding?: string;
    scope?: string;
    acceptanceCriteria?: string;
    note: string;
    changedAt: string;
    sessionId?: string;
    expectedLockVersion?: number;
  }, principal: Principal): Promise<RequirementSummary> {
    if (input.title === undefined && input.typeId === undefined && input.responsibleAgent === undefined &&
        input.agentUnderstanding === undefined &&
        input.scope === undefined && input.acceptanceCriteria === undefined) {
      throw new RequirementValidationError("At least one content field must be provided");
    }
    const workPackage = await this.resolve(input.reference, input.project, principal);
    this.assertReadable(workPackage, principal);
    this.assertExpectedVersion(workPackage, input.expectedLockVersion);
    this.assertClaimOrOwner(workPackage, principal, input.sessionId);
    let description = workPackage.description?.raw ?? "";
    if (input.agentUnderstanding !== undefined) {
      description = this.writeMarkdownSection(description, "Agent 理解", input.agentUnderstanding);
    }
    if (input.scope !== undefined) {
      description = this.writeMarkdownSection(description, "范围", input.scope);
    }
    if (input.acceptanceCriteria !== undefined) {
      description = this.writeMarkdownSection(description, "验收条件", input.acceptanceCriteria);
    }
    const payload: Record<string, unknown> = {
      lockVersion: workPackage.lockVersion,
      description: { format: "markdown", raw: description.trimEnd() }
    };
    if (input.title !== undefined) payload.subject = input.title;
    if (input.typeId !== undefined) {
      payload._links = { type: { href: await this.typeHref(input.project, input.typeId, principal) } };
    }
    // Who is meant to do the work is an ordinary editable field. Who actually claimed it
    // is not: that goes through claim and release, which enforce the atomicity.
    if (input.responsibleAgent !== undefined) {
      this.writeField(payload, FIELD.responsibleAgent, input.responsibleAgent);
    }
    await this.journalNote(
      workPackage.id,
      `- ${input.changedAt}：更新需求正文。${input.note}`,
      principal
    );
    return this.summarize(await this.updateWithConflict(workPackage.id, payload));
  }

  /**
   * The values each list field accepts, read from the field map.
   *
   * The page used to carry its own copy of the agent and state lists. Adding an agent
   * then meant editing the front-end, and forgetting to left a value that exists in
   * OpenProject unusable from the page with no sign anything was missing.
   */
  fieldOptions(): Record<string, string[]> {
    const wanted = ["state", "responsibleAgent", "claimedAgent", "visibility", "modules",
                    "intakeStatus", "requesterType", "verificationStatus", "userAcceptance"];
    const out: Record<string, string[]> = {};
    for (const name of wanted) {
      const options = this.map.fields[name]?.options;
      if (options) out[name] = Object.keys(options);
    }
    return out;
  }

  /**
   * The change history of one requirement, comments included.
   *
   * Carried here so nobody has to leave for OpenProject's own page to find out what
   * happened to a requirement (Brian 2026-09-22). Read through the same `resolve`, so a
   * requirement the caller may not see has no history either.
   */
  /**
   * A requirement's history, which is where its 变更记录 now lives.
   *
   * Moving the change log off the description only pays if it can still be read back, and
   * for an Agent that means this. The page wants the whole stream and reverses it itself,
   * so no options is still everything; a caller that only wants the recent reasons asks
   * for a window instead of pulling a record's entire life into its context.
   *
   * The window is taken from the newest end because that is the question people actually
   * ask, but the items come back oldest-first inside it, so a history always reads
   * forwards no matter which slice was requested.
   */
  async activities(
    reference: string | number,
    project: string,
    principal: Principal,
    options: { limit?: number; offset?: number; notesOnly?: boolean } = {}
  ): Promise<{ total: number; returned: number; items: Array<Record<string, unknown>> }> {
    const workPackage = await this.resolve(reference, project, principal);
    this.assertReadable(workPackage, principal);
    this.assertNotHandoff(workPackage);
    const result = await this.client.listActivities(workPackage.id);

    // The signature is taken off before anything else looks at the note: a note that is
    // only a signature carries no reason, and asking for notes is asking for 变更记录.
    let entries = result._embedded.elements.map(activity => ({
      activity,
      ...parseSignature(activity.comment?.raw ?? "")
    }));
    if (options.notesOnly) entries = entries.filter(entry => entry.text.trim());
    const total = entries.length;

    const offset = Math.max(0, options.offset ?? 0);
    const limit = options.limit;
    if (limit !== undefined) {
      const end = Math.max(0, total - offset);
      entries = entries.slice(Math.max(0, end - limit), end);
    } else if (offset) {
      entries = entries.slice(0, Math.max(0, total - offset));
    }

    // One lookup per account for this read, not one per entry: a history is written by a
    // handful of accounts, and the same one wrote most of it.
    const accounts = new Map<string, Promise<UserResource | null>>();
    const once = (key: string, load: () => Promise<UserResource | null>) => {
      let account = accounts.get(key);
      if (!account) accounts.set(key, account = load());
      return account;
    };

    return {
      total,
      returned: entries.length,
      items: await Promise.all(entries.map(async ({ activity, text, userId: signer, channel }) => {
        const link = activity._links?.user;
        const author = await once(`id:${link?.href ?? ""}`, () => this.account(link));
        const person = signer ? await this.signerAccount(signer, author, once) : author;
        return {
          id: activity.id,
          createdAt: activity.createdAt ?? null,
          // Unsigned entries are named by the account OpenProject journalled them under.
          // Signed ones by the identity in the signature, since every signed entry was
          // journalled under the service's account whoever asked for it.
          user: signer
            ? person?.name ?? person?.login ?? signer
            : linkTitle(link) ?? author?.name ?? author?.login ?? null,
          // OpenProject serves the avatar at /users/:id/avatar, so the id travels with the
          // name and the page shows the same likeness the native activity does.
          userId: signer ? person?.id ?? null : linkUserId(link),
          // Which agent wrote it, or 网页 for the pool page itself. Null for everything
          // written before signing began and for OpenProject's own screens: not known,
          // so not made up.
          agent: channel,
          comment: text,
          // OpenProject already renders each change as a sentence; reusing them keeps one
          // wording rather than inventing a second.
          details: (activity.details ?? []).map(detail => detail.raw).filter(Boolean)
        };
      }))
    };
  }

  /**
   * The account behind an activity's user link, as OpenProject has it now.
   *
   * The activity stream gives the link with no title, so every entry read as "未知" until
   * the id was resolved. The account is read afresh on every history read. It used to be
   * kept for the life of the process, on the grounds that a name rarely changes -- and
   * when Brian corrected his own on 2026-09-23 the history went on saying
   * "Brian Brian Tan" while OpenProject's own change sentences already said "Brian Tan",
   * and would have until something restarted the service.
   */
  private async account(link: HalLink | undefined): Promise<UserResource | null> {
    if (!link?.href) return null;
    const id = Number(hrefId(link.href));
    if (!Number.isInteger(id)) return null;
    try {
      return await this.client.getUser(id);
    } catch {
      return null;
    }
  }

  /**
   * The OpenProject account of the identity a signature names. Usually the account the
   * entry was journalled under -- the service writes with its owner's token -- so that
   * one is reused; anyone else is looked up by login.
   */
  private async signerAccount(
    userId: string,
    author: UserResource | null,
    once: (key: string, load: () => Promise<UserResource | null>) => Promise<UserResource | null>
  ): Promise<UserResource | null> {
    const login = this.loginOf(userId) ?? userId;
    if (author?.login === login) return author;
    return once(`login:${login}`, async () => {
      try {
        const found = await this.client.listUsers({
          filters: JSON.stringify([{ login: { operator: "=", values: [login] } }]),
          pageSize: "2"
        });
        return found._embedded.elements.find(user => user.login === login) ?? null;
      } catch {
        return null;
      }
    });
  }

  /**
   * Records why something changed on the work package's own journal.
   *
   * These notes used to be appended to the description, which is what turned a
   * requirement into a development log: one record reached 42,000 characters with 94% of
   * it change log, and every reader paid for all of it on every read, forever. Every
   * change is already journalled by OpenProject, and the pool page's 历史 tab reads that
   * journal, so the note belongs there.
   *
   * It cannot ride along with the update: API v3 offers no way to attach a note to a
   * work package PATCH -- neither the payload nor its _meta carries one (checked on
   * 17.8.0) -- so it is a separate call.
   *
   * ⛔ It has to go FIRST, and that order is load-bearing rather than arbitrary.
   * Journal aggregation lets an entry carrying notes absorb the notes-free entry that
   * follows it, and not the other way round. Posting the note afterwards therefore pairs
   * each note with the NEXT change instead of its own: measured on 17.8.0, ten state
   * flips produced a history reading 「状态更新为「进行中」」 beside details saying
   * 进行中 → 待认领, the opposite change. Note first gives one entry carrying the reason
   * and the change it explains, which is also what the native UI produces when someone
   * comments while editing fields.
   *
   * The cost of that order is that a note can outlive a failed update. It is posted after
   * every precondition has passed, so the window is the PATCH itself; an orphan is rare,
   * truthful about what was attempted, and visibly carries no changes -- where the
   * mispairing it replaces was wrong on every single call.
   *
   * Two more things measured rather than assumed: a comment does not move lockVersion, so
   * the summary handed back after the update stays usable; and a note with no field
   * change still produces an entry, so nothing is silently dropped.
   */
  private async journalNote(workPackageId: number, note: string, principal: Principal): Promise<void> {
    // Signed when the caller's channel is known, which every entry point sets; a write
    // that changes fields without a reason still gets a note, the signature alone, so the
    // change is not left to be aggregated into somebody else's signed entry.
    const text = principal.via ? signed(note, principal.userId, principal.via) : note.trim();
    if (!text) return;
    await this.client.createActivity(workPackageId, text);
  }

  /** Adds a comment to a requirement's history. */
  async comment(input: {
    project: string;
    reference: string | number;
    text: string;
  }, principal: Principal): Promise<{ ok: true }> {
    const text = input.text.trim();
    if (!text) throw new RequirementValidationError("Comment must not be empty");
    const workPackage = await this.resolve(input.reference, input.project, principal);
    this.assertReadable(workPackage, principal);
    this.assertNotHandoff(workPackage);
    await this.journalNote(workPackage.id, text, principal);
    return { ok: true };
  }

  /**
   * Whether a type is enabled on a project.
   *
   * Cached because a project's type set changes far less often than its list is read, and
   * this sits in front of every list call.
   */
  private readonly projectTypeIds = new Map<number, Set<number>>();

  private async typeEnabled(projectId: number, typeId: number): Promise<boolean> {
    let ids = this.projectTypeIds.get(projectId);
    if (!ids) {
      const result = await this.client.listProjectTypes(projectId);
      ids = new Set(result._embedded.elements.map(type => type.id));
      this.projectTypeIds.set(projectId, ids);
    }
    return ids.has(typeId);
  }

  async types(projectIdentifier: string, principal: Principal) {
    const project = await this.visibleProject(projectIdentifier, principal);
    const types = await this.client.listProjectTypes(project.id);
    // The handoff type is enabled in the same project but is not a requirement
    // classification; leaving it out keeps a requirement from being filed as one.
    const handoffTypeId = this.handoffTypeId();
    return {
      project: project.identifier,
      types: types._embedded.elements
        .filter(type => handoffTypeId === null || type.id !== handoffTypeId)
        .map(type => ({ id: type.id, name: type.name, isMilestone: type.isMilestone ?? false }))
    };
  }

  private async typeHref(project: string, typeId: number, principal: Principal): Promise<string> {
    const available = await this.types(project, principal);
    if (!available.types.some(type => type.id === typeId)) {
      throw new RequirementValidationError(`Type ${typeId} is not enabled in project ${project}; use requirements_types`);
    }
    return `/api/v3/types/${typeId}`;
  }

  async setParent(input: {
    project: string;
    child: string | number;
    parent: string | number | null;
    requiredForParent: boolean;
    expectedLockVersion?: number;
  }, principal: Principal): Promise<RequirementSummary> {
    const child = await this.resolve(input.child, input.project, principal);
    this.assertOwnerOrAdmin(child, principal);
    this.assertExpectedVersion(child, input.expectedLockVersion);
    const parent = input.parent === null ? null : await this.resolve(input.parent, input.project, principal);
    if (parent) this.assertOwnerOrAdmin(parent, principal);
    if (parent?.id === child.id) {
      throw new RequirementValidationError("A requirement cannot be its own parent");
    }
    if (parent) await this.assertNoParentCycle(child.id, parent);
    const payload: Record<string, unknown> = {
      lockVersion: child.lockVersion,
      _links: {
        parent: { href: parent ? `/api/v3/work_packages/${parent.id}` : null }
      }
    };
    this.writeField(payload, FIELD.requiredForParent, input.requiredForParent);
    await this.journalNote(child.id, "", principal);
    return this.summarize(await this.updateWithConflict(child.id, payload));
  }

  async addDependency(input: {
    project: string;
    prerequisite: string | number;
    dependent: string | number;
  }, principal: Principal): Promise<Relation> {
    const [prerequisite, dependent] = await Promise.all([
      this.resolve(input.prerequisite, input.project, principal),
      this.resolve(input.dependent, input.project, principal)
    ]);
    this.assertOwnerOrAdmin(prerequisite, principal);
    this.assertOwnerOrAdmin(dependent, principal);
    if (prerequisite.id === dependent.id) {
      throw new RequirementValidationError("A requirement cannot depend on itself");
    }
    try {
      return await this.client.createRelation(prerequisite.id, dependent.id, "blocks");
    } catch (error) {
      if (error instanceof OpenProjectHttpError && error.status === 409) {
        throw new RequirementConflictError("A relation already exists or conflicts");
      }
      throw error;
    }
  }

  async uploadAttachment(input: {
    project: string;
    reference: string | number;
    fileName: string;
    content: string;
    encoding: "base64" | "utf8";
    contentType?: string;
    description?: string;
  }, principal: Principal): Promise<Attachment> {
    if (!input.fileName.trim() || /[\\/\u0000-\u001f\u007f]/.test(input.fileName) || input.fileName === "." || input.fileName === "..") {
      throw new RequirementValidationError("Provide a file name without directory components or control characters");
    }
    const maxBytes = 20 * 1024 * 1024;
    if (input.encoding === "base64" &&
        input.content.length > 4 * Math.ceil(maxBytes / 3)) {
      throw new RequirementValidationError("Expected valid base64 for a file of at most 20 MiB");
    }
    const content = Buffer.from(input.content, input.encoding);
    if (input.encoding === "base64" && content.toString("base64") !== input.content) {
      throw new RequirementValidationError("Expected valid standard base64 content");
    }
    if (content.length > maxBytes) {
      throw new RequirementValidationError("Attachment exceeds 20 MiB");
    }
    const contentType = input.contentType ?? "application/octet-stream";
    if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(contentType)) {
      throw new RequirementValidationError("Provide a MIME type such as image/png or application/pdf");
    }
    const workPackage = await this.resolve(input.reference, input.project, principal);
    this.assertOwnerOrAdmin(workPackage, principal);
    await this.journalNote(workPackage.id, "", principal);
    return this.client.uploadAttachment(workPackage.id, input.fileName, content, contentType, input.description);
  }

  async uploadMarkdown(input: {
    project: string;
    reference: string | number;
    fileName: string;
    content: string;
    description?: string;
  }, principal: Principal): Promise<Attachment> {
    if (!input.fileName.toLowerCase().endsWith(".md")) {
      throw new RequirementValidationError("Only .md attachments are accepted");
    }
    if (Buffer.byteLength(input.content, "utf8") > 2 * 1024 * 1024) {
      throw new RequirementValidationError("Markdown attachment exceeds 2 MiB");
    }
    const workPackage = await this.resolve(input.reference, input.project, principal);
    this.assertOwnerOrAdmin(workPackage, principal);
    await this.journalNote(workPackage.id, "", principal);
    return this.client.uploadMarkdown(workPackage.id, input.fileName, input.content, input.description);
  }

  async readMarkdown(input: {
    project: string;
    reference: string | number;
    attachmentId?: number;
    fileName?: string;
  }, principal: Principal): Promise<{ attachment: Attachment; content: string }> {
    const workPackage = await this.resolve(input.reference, input.project, principal);
    this.assertReadable(workPackage, principal);
    const attachments = await this.client.listAttachments(workPackage);
    const markdown = attachments.filter(item => item.fileName.toLowerCase().endsWith(".md"));
    const attachment = input.attachmentId
      ? markdown.find(item => item.id === input.attachmentId)
      : input.fileName
        ? markdown.find(item => item.fileName === input.fileName)
        : markdown.at(-1);
    if (!attachment) {
      throw new RequirementValidationError("Markdown attachment not found");
    }
    return { attachment, content: await this.client.readAttachment(attachment) };
  }

  async complete(input: {
    project: string;
    reference: string | number;
    sessionId: string;
    completedAt: string;
    evidence: CompletionEvidence[];
    expectedLockVersion?: number;
  }, principal: Principal, { byHand = false }: { byHand?: boolean } = {}): Promise<RequirementSummary> {
    if (input.evidence.length === 0) {
      throw new RequirementValidationError("Completion evidence is required");
    }
    // Checked here as well as by the tool's schema: the pool page posts evidence straight
    // through, and a missing piece has to be refused whichever door it came in by.
    for (const evidence of input.evidence as Array<CompletionEvidence & { kind?: string }>) {
      if (!filled(evidence.verification) || !filled(evidence.acceptanceSource)) {
        throw new RequirementValidationError("Verification and acceptance source are required");
      }
      if (evidence.acceptanceStatus !== "已验收" && evidence.acceptanceStatus !== "不适用") {
        throw new RequirementValidationError("Acceptance status must be 已验收 or 不适用");
      }
      if (evidence.kind === "file") {
        if (!Array.isArray(evidence.locations) || !evidence.locations.some(filled) || !filled(evidence.change)) {
          throw new RequirementValidationError(
            "Files outside a repository need where they are (locations) and what changed (change)"
          );
        }
      } else if (evidence.kind === undefined || evidence.kind === "git") {
        const git = evidence as GitEvidence;
        if (typeof git.sha !== "string" || !/^[0-9a-f]{40}$/i.test(git.sha)) {
          throw new RequirementValidationError(`Commit SHA must be 40 hex characters: ${String(git.sha)}`);
        }
        if (!filled(git.repository) || !Array.isArray(git.paths) || !git.paths.some(filled)) {
          throw new RequirementValidationError("Repository and paths are required for a commit");
        }
      } else {
        throw new RequirementValidationError(`Unknown evidence kind: ${evidence.kind}`);
      }
    }

    const workPackage = await this.resolve(input.reference, input.project, principal);
    this.assertReadable(workPackage, principal);
    this.assertExpectedVersion(workPackage, input.expectedLockVersion);
    this.assertClaimOrOwner(workPackage, principal, input.sessionId);
    if (!byHand) this.assertClaimed(workPackage, "complete it");
    const blockers = await this.blockingDependencies(workPackage, principal);
    if (blockers.length > 0) {
      throw new RequirementConflictError(`Blocked by incomplete requirements: ${blockers.join(", ")}`);
    }
    const children = await this.requiredIncompleteChildren(workPackage, principal);
    if (children.length > 0) {
      throw new RequirementConflictError(`Required children are incomplete: ${children.join(", ")}`);
    }

    const payload: Record<string, unknown> = {
      lockVersion: workPackage.lockVersion,
      description: this.withEvidence(workPackage,
        `完成时间：${input.completedAt}\n\n\`\`\`json\n${JSON.stringify(input.evidence, null, 2)}\n\`\`\``)
    };
    this.writeField(payload, FIELD.state, "已完成");
    this.writeField(payload, FIELD.verificationStatus, "已验证");
    this.writeField(payload, FIELD.userAcceptance, input.evidence.every(item => item.acceptanceStatus === "已验收") ? "已验收" : "不适用");
    this.addStatusLink(payload, "已完成");
    // Completing is the single most interesting thing that happens to a requirement, and
    // it left no trace in the history at all -- which is why the 历史 tab read as nothing
    // but bare state changes. The entry points at the evidence rather than repeating it.
    const commits = input.evidence.flatMap(item => item.kind === "file" ? [] : [item.sha.slice(0, 12)]);
    const outside = input.evidence.reduce((count, item) => count + (item.kind === "file" ? item.locations.length : 0), 0);
    const delivered = [
      ...(commits.length ? [`提交 ${commits.join("、")}`] : []),
      ...(outside ? [`仓库外文件 ${outside} 处`] : [])
    ];
    await this.journalNote(
      workPackage.id,
      `- ${input.completedAt}：完成。交付证据 ${input.evidence.length} 条，${delivered.join("；")}`,
      principal
    );
    return this.summarize(await this.updateWithConflict(workPackage.id, payload));
  }

  /**
   * The description with one more completion entry in 交付证据.
   *
   * Evidence is part of the record rather than a log line, so it belongs in the section
   * the template already reserves for it. This used to paste a fresh 「## 交付证据」
   * heading on every call, so a requirement reopened and completed again grew a second
   * and a third, and a section read stopped at the first. Earlier evidence is kept and
   * added to, which is what a re-completion is supposed to do.
   */
  /**
   * An agent works on or delivers a requirement only while it holds the claim (see
   * CLAIMED_STATES). A claim held by another session still counts: the owner carries on
   * across sessions without taking it over. A person on the pool page is not asked.
   */
  private assertClaimed(workPackage: WorkPackage, action: string): void {
    if (this.readText(workPackage, FIELD.claimedSession)) return;
    throw new RequirementConflictError(
      `Nobody has claimed this requirement: claim it with requirements_claim before you ${action}`
    );
  }

  private withEvidence(workPackage: WorkPackage, entry: string): { format: "markdown"; raw: string } {
    const body = workPackage.description?.raw ?? "";
    const previous = this.readMarkdownSection(body, "交付证据");
    const kept = previous && previous !== "尚无。" ? `${previous}\n\n${entry}` : entry;
    return { format: "markdown", raw: this.writeMarkdownSection(body, "交付证据", kept) };
  }

  private compactSummary(summary: RequirementSummary): Record<string, unknown> {
    return {
      id: summary.id,
      workPackageId: summary.workPackageId,
      project: summary.project,
      title: summary.title,
      typeId: summary.typeId,
      typeName: summary.typeName,
      state: summary.state,
      responsibleAgent: summary.responsibleAgent,
      claimedAgent: summary.claimedAgent,
      lockVersion: summary.lockVersion
    };
  }

  private async treeNode(
    workPackage: WorkPackage,
    level: number,
    maxDepth: number,
    principal: Principal,
    budget: { count: number }
  ): Promise<Record<string, unknown>> {
    budget.count += 1;
    if (budget.count > 200) {
      throw new RequirementValidationError("Requirement tree exceeds the 200-node response limit");
    }
    const children = (await this.childWorkPackages(workPackage))
      .filter(child => this.canRead(child, principal));
    const nested = level < maxDepth
      ? await Promise.all(children.map(child => this.treeNode(child, level + 1, maxDepth, principal, budget)))
      : [];
    return {
      ...this.compactSummary(this.summarize(workPackage)),
      requiredForParent: this.readBool(workPackage, FIELD.requiredForParent),
      claim: {
        session: this.readText(workPackage, FIELD.claimedSession),
        label: this.readText(workPackage, FIELD.claimLabel),
        claimedAt: this.readText(workPackage, FIELD.claimedAt),
        scope: this.readText(workPackage, FIELD.claimScope)
      },
      childCount: children.length,
      children: nested,
      childrenTruncated: level >= maxDepth && children.length > 0
    };
  }

  private initialDescription(input: CreateRequirementInput): string {
    const quoted = input.rawText.split("\n").map(line => `> ${line}`).join("\n");
    return [
      "## 用户原文",
      quoted,
      "## Agent 理解",
      input.agentUnderstanding,
      "## 范围",
      input.scope?.trim() || "待确认",
      "## 验收条件",
      input.acceptanceCriteria?.trim() || "待确认",
      "## 来源",
      `- 项目：${input.project}`,
      `- 提出者：${input.requesterType} / ${input.requesterName ?? "未知"} / ${input.requesterId ?? "未知"}`,
      `- 可见性：${input.visibility}`,
      `- 所属用户：由认证身份记录`,
      `- 原记录时间：${input.recordedAt ?? "未知"}`,
      `- 原更新时间：${input.sourceUpdatedAt ?? "未知"}`,
      `- 提出时间：${input.proposedAt ?? "未知"}（${input.proposedTimePrecision}）`,
      `- 来源 Session：${input.sourceSessionId ?? "未知"}`,
      `- 来源消息：${input.sourceMessageId ?? "未知"}`,
      `- 来源说明：${input.sourceLabel}`,
      "## 讨论",
      "尚无。",
      "## 交付证据",
      "尚无。",
      "## 变更记录",
      `- 登记请求：${input.requestId}`
    ].join("\n\n");
  }

  private async dependencyOverview(workPackage: WorkPackage, principal: Principal): Promise<{
    blockedBy: Record<string, unknown>[];
    blocks: Record<string, unknown>[];
    related: Record<string, unknown>[];
    blockers: string[];
  }> {
    const relations = await this.client.listRelations(workPackage.id);
    const blockedBy: Record<string, unknown>[] = [];
    const blocks: Record<string, unknown>[] = [];
    const related: Record<string, unknown>[] = [];
    const blockers: string[] = [];
    for (const relation of relations._embedded.elements) {
      const fromId = relationWorkPackageId(relation._links.from);
      const toId = relationWorkPackageId(relation._links.to);
      const otherId = fromId === workPackage.id ? toId : fromId;
      const other = await this.client.getWorkPackage(otherId);
      const blocksCurrent = (relation.type === "blocks" && toId === workPackage.id) ||
        (relation.type === "blocked" && fromId === workPackage.id);
      if (blocksCurrent) {
        const state = this.readList(other, FIELD.state)[0];
        if (!state || !this.map.completionStates.includes(state)) {
          blockers.push(this.canRead(other, principal)
            ? this.readText(other, FIELD.requirementId) ?? `#${other.id}`
            : "不可见前置需求");
        }
      }
      if (!this.canRead(other, principal)) continue;
      const item = { ...this.compactSummary(this.summarize(other)), relationType: relation.type };
      if ((relation.type === "blocks" && fromId === workPackage.id) ||
          (relation.type === "blocked" && toId === workPackage.id)) {
        blocks.push(item);
      } else if (blocksCurrent) {
        blockedBy.push(item);
      } else {
        related.push(item);
      }
    }
    return { blockedBy, blocks, related, blockers };
  }

  private async blockingDependencies(workPackage: WorkPackage, principal?: Principal): Promise<string[]> {
    const relations = await this.client.listRelations(workPackage.id);
    const prerequisiteIds = new Set<number>();
    for (const relation of relations._embedded.elements) {
      const fromId = relationWorkPackageId(relation._links.from);
      const toId = relationWorkPackageId(relation._links.to);
      if (relation.type === "blocks" && toId === workPackage.id) {
        prerequisiteIds.add(fromId);
      } else if (relation.type === "blocked" && fromId === workPackage.id) {
        prerequisiteIds.add(toId);
      }
    }
    const blockers: string[] = [];
    for (const id of prerequisiteIds) {
      const prerequisite = await this.client.getWorkPackage(id);
      const state = this.readList(prerequisite, FIELD.state)[0];
      if (!state || !this.map.completionStates.includes(state)) {
        blockers.push(principal && !this.canRead(prerequisite, principal)
          ? "不可见前置需求"
          : this.readText(prerequisite, FIELD.requirementId) ?? `#${id}`);
      }
    }
    return blockers;
  }

  private async requiredIncompleteChildren(parent: WorkPackage, principal: Principal): Promise<string[]> {
    const children = await this.childWorkPackages(parent);
    return children
      .filter(child => this.readBool(child, FIELD.requiredForParent))
      .filter(child => {
        const state = this.readList(child, FIELD.state)[0];
        return !state || !this.map.completionStates.includes(state);
      })
      .map(child => this.canRead(child, principal)
        ? this.readText(child, FIELD.requirementId) ?? `#${child.id}`
        : "不可见必需子需求");
  }

  private async childWorkPackages(parent: WorkPackage): Promise<WorkPackage[]> {
    const projectLink = parent._links.project;
    const href = Array.isArray(projectLink) ? undefined : projectLink?.href;
    const projectId = href ? Number(hrefId(href)) : NaN;
    if (!Number.isInteger(projectId)) {
      throw new RequirementValidationError(`Requirement #${parent.id} has no valid project link`);
    }
    const filters = JSON.stringify([
      { parent: { operator: "=", values: [String(parent.id)] } }
    ]);
    const children: WorkPackage[] = [];
    let page = 1;
    let total = 0;
    do {
      const result = await this.client.listProjectWorkPackages(projectId, {
        filters,
        pageSize: "200",
        offset: String(page)
      });
      total = result.total;
      children.push(...result._embedded.elements);
      page += 1;
    } while (children.length < total);
    return children;
  }

  private async assertNoParentCycle(childId: number, parent: WorkPackage): Promise<void> {
    const visited = new Set<number>();
    let current: WorkPackage | null = parent;
    while (current) {
      if (current.id === childId) {
        throw new RequirementValidationError("Parent hierarchy would create a cycle");
      }
      if (visited.has(current.id)) {
        throw new RequirementValidationError("Existing parent hierarchy contains a cycle");
      }
      visited.add(current.id);
      const parentLink: HalLink | undefined = Array.isArray(current._links.parent)
        ? undefined
        : current._links.parent;
      current = parentLink?.href
        ? await this.client.getWorkPackage(relationWorkPackageId(parentLink))
        : null;
    }
  }
}
