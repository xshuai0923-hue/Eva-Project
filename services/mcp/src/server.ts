import { requireLockVersion } from "./record-service.js";
import { webRequirement, prepareWebHandoff } from "./web-create.js";
import { readJson } from "./web-body.js";
import { AgentConnections } from "./agent-connect.js";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { hostHeaderValidation } from "@modelcontextprotocol/node";
import { McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { openProjectAdminAccess, openProjectSessionUser } from "./admin-auth.js";
import {
  BackupBusyError,
  BackupInputError,
  BackupNotFoundError,
  BackupService,
  flushMemcached
} from "./backup.js";
import { loadConfig } from "./config.js";
import { OpenProjectClient, OpenProjectHttpError } from "./openproject.js";
import { PrincipalAdmin } from "./principal-admin.js";
import { PrincipalConflictError, PrincipalStore } from "./principal-store.js";
import { channelFromRequest, WEB_CHANNEL } from "./signature.js";
import { HANDOFF_PROSE_SECTIONS, HANDOFF_SECTIONS, HandoffService } from "./handoff-service.js";
import {
  CLAIMED_STATES,
  type CreateRequirementInput,
  REQUIREMENT_SECTIONS,
  RequirementConflictError,
  RequirementService,
  RequirementValidationError
} from "./service.js";
import type { HandoffSummary, Principal, RequirementSummary } from "./types.js";
import { McpHttpEndpoint, MCP_MAX_TOOL_INPUT_ELEMENTS } from "./mcp-http.js";

const config = loadConfig();
const client = new OpenProjectClient(config.openProjectBaseUrl, config.openProjectApiToken);
const principalStore = new PrincipalStore(config.mcpPrincipalsFile, config.mcpPrincipals);
const principalAdmin = new PrincipalAdmin(principalStore, client);
const requirements = new RequirementService(client, config.fieldMap,
  userId => principalStore.openProjectLoginOf(userId));
const handoffs = new HandoffService(client, config.fieldMap);
const backupConfig = config.backup;
const backups = backupConfig ? new BackupService({
  paths: backupConfig.paths,
  databaseUrl: backupConfig.databaseUrl,
  // After a restore swaps the database, the instance has to answer an ordinary API call
  // with this service's own token: that reaches the database through the application,
  // and it would fail on a database from before the token existed.
  instanceHealthy: async () => {
    const result = await fetch(`${config.openProjectBaseUrl}/api/v3/users/me`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`apikey:${config.openProjectApiToken}`).toString("base64")}`,
        Accept: "application/hal+json"
      }
    });
    return result.ok;
  },
  flushCache: () => flushMemcached(backupConfig.cacheAddress),
  log: line => process.stdout.write(`${line}\n`)
}) : null;

function jsonResult(value: unknown) {
  const structuredContent = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(structuredContent ? { structuredContent } : {})
  };
}

function fieldEnum(name: string) {
  const values = Object.keys(config.fieldMap.fields[name]?.options ?? {});
  if (values.length === 0) throw new Error(`Field ${name} has no configured options`);
  return z.enum(values as [string, ...string[]]);
}

const moduleSchema = fieldEnum("modules");
const responsibleAgentSchema = fieldEnum("responsibleAgent");
const claimedAgentSchema = fieldEnum("claimedAgent");
const intakeStatusSchema = fieldEnum("intakeStatus");
const stateSchema = fieldEnum("state");
const nonCompletionStateSchema = z.enum(
  Object.keys(config.fieldMap.statusHrefs)
    .filter(value => !config.fieldMap.completionStates.includes(value)) as [string, ...string[]]
);
const initialStateSchema = z.enum(
  Object.keys(config.fieldMap.statusHrefs)
    .filter(value => !config.fieldMap.completionStates.includes(value) && !CLAIMED_STATES.includes(value)) as
    [string, ...string[]]
);
const requesterTypeSchema = fieldEnum("requesterType");
const visibilitySchema = fieldEnum("visibility");
const timePrecisionSchema = fieldEnum("proposedTimePrecision");
const handoffStateSchema = fieldEnum("handoffState");
const expectedAgentSchema = fieldEnum("handoffExpectedAgent");
const handoffSectionSchema = z.enum(HANDOFF_SECTIONS);
const handoffProseSectionSchema = z.enum(HANDOFF_PROSE_SECTIONS);
const handoffReference = z.union([z.string(), z.number().int().positive()]);
const requirementSectionSchema = z.enum(REQUIREMENT_SECTIONS);

function handoffReceipt(action: string, item: HandoffSummary, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    action,
    handoff: {
      id: item.id,
      workPackageId: item.workPackageId,
      thread: item.thread,
      state: item.handoffState,
      todo: { done: item.todoDone, total: item.todoTotal },
      lockVersion: item.lockVersion
    },
    ...extra
  };
}

const requirementFieldsSchema = z.object({
  id: z.string().min(1).describe("Stable requirement identifier unique within the selected project."),
  title: z.string().min(1),
  type_id: z.number().int().positive().optional().describe("Enabled OpenProject type ID from requirements_types; omit for the default Task type."),
  raw_text: z.string().min(1).describe("The requester's original wording; keep it separate from Agent interpretation."),
  agent_understanding: z.string().min(1),
  scope: z.string().min(1).nullable().optional(),
  acceptance_criteria: z.string().min(1).nullable().optional(),
  modules: z.array(moduleSchema).min(1),
  responsible_agent: responsibleAgentSchema,
  intake_status: intakeStatusSchema,
  state: initialStateSchema.describe("Initial lifecycle state. Work starts with requirements_claim, which moves it to 进行中."),
  priority: z.string().min(1).describe("User-provided priority label; this field is intentionally free text."),
  requester_type: requesterTypeSchema,
  requester_name: z.string().nullable().optional(),
  requester_id: z.string().nullable().optional(),
  visibility: visibilitySchema,
  recorded_at: z.string().nullable().optional(),
  source_updated_at: z.string().nullable().optional(),
  proposed_at: z.string().nullable().optional(),
  proposed_time_precision: timePrecisionSchema,
  source_session_id: z.string().nullable().optional(),
  source_message_id: z.string().nullable().optional(),
  source_label: z.string().min(1),
  request_id: z.string().min(1).describe("Idempotency label preserved in the requirement history."),
});

type RequirementFieldsInput = z.infer<typeof requirementFieldsSchema>;

function toCreateInput(
  project: string,
  input: RequirementFieldsInput & { required_for_parent?: boolean | undefined }
): CreateRequirementInput {
  return {
    project,
    id: input.id,
    title: input.title,
    ...(input.type_id !== undefined ? { typeId: input.type_id } : {}),
    rawText: input.raw_text,
    agentUnderstanding: input.agent_understanding,
    modules: input.modules,
    responsibleAgent: input.responsible_agent,
    intakeStatus: input.intake_status,
    state: input.state,
    priority: input.priority,
    requesterType: input.requester_type,
    visibility: input.visibility as "公开" | "私有",
    proposedTimePrecision: input.proposed_time_precision,
    sourceLabel: input.source_label,
    requestId: input.request_id,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.acceptance_criteria !== undefined ? { acceptanceCriteria: input.acceptance_criteria } : {}),
    ...(input.requester_name !== undefined ? { requesterName: input.requester_name } : {}),
    ...(input.requester_id !== undefined ? { requesterId: input.requester_id } : {}),
    ...(input.recorded_at !== undefined ? { recordedAt: input.recorded_at } : {}),
    ...(input.source_updated_at !== undefined ? { sourceUpdatedAt: input.source_updated_at } : {}),
    ...(input.required_for_parent !== undefined ? { requiredForParent: input.required_for_parent } : {}),
    ...(input.proposed_at !== undefined ? { proposedAt: input.proposed_at } : {}),
    ...(input.source_session_id !== undefined ? { sourceSessionId: input.source_session_id } : {}),
    ...(input.source_message_id !== undefined ? { sourceMessageId: input.source_message_id } : {})
  };
}

function compactRequirement(item: RequirementSummary) {
  return {
    id: item.id,
    workPackageId: item.workPackageId,
    project: item.project,
    title: item.title,
    typeId: item.typeId,
    typeName: item.typeName,
    state: item.state,
    lockVersion: item.lockVersion
  };
}

function requirementReceipt(action: string, item: RequirementSummary, extra: Record<string, unknown> = {}) {
  return { ok: true, action, requirement: compactRequirement(item), ...extra };
}

function relationWorkPackageId(href: string | null): number | null {
  if (!href) return null;
  const value = Number(href.split("/").filter(Boolean).at(-1));
  return Number.isInteger(value) ? value : null;
}

const compactRequirementOutputSchema = z.object({
  id: z.string().nullable(),
  workPackageId: z.number().int().positive(),
  project: z.string().nullable(),
  title: z.string(),
  typeId: z.number().int().positive().nullable(),
  typeName: z.string().nullable(),
  state: z.string().nullable(),
  lockVersion: z.number().int().nonnegative()
});

const requirementReceiptOutputSchema = z.object({
  ok: z.boolean(),
  action: z.string(),
  requirement: compactRequirementOutputSchema,
  replayed: z.boolean().optional(),
  parent: z.union([z.string(), z.number().int().positive()]).nullable().optional(),
  requiredForParent: z.boolean().optional()
});

const projectCreateOutputSchema = z.object({
  created: z.boolean(),
  project: z.object({ id: z.number().int().positive(), identifier: z.string(), name: z.string() }),
  types: z.array(z.object({ id: z.number().int().positive(), name: z.string() }))
    .describe("Types enabled on the project, so a successful bind shows what the pool can actually hold.")
});

const childrenCreateOutputSchema = z.object({
  ok: z.boolean(),
  action: z.literal("children_created"),
  parent: compactRequirementOutputSchema,
  results: z.array(z.record(z.string(), z.unknown()))
});

const dependencyReceiptOutputSchema = z.object({
  ok: z.boolean(),
  action: z.literal("dependency_added"),
  relation: z.object({
    id: z.number().int().positive(),
    type: z.string(),
    fromWorkPackageId: z.number().int().positive().nullable(),
    toWorkPackageId: z.number().int().positive().nullable()
  })
});

const attachmentReceiptOutputSchema = z.object({
  ok: z.boolean(),
  action: z.enum(["markdown_uploaded", "attachment_uploaded"]),
  attachment: z.object({
    id: z.number().int().positive(),
    fileName: z.string(),
    fileSize: z.number().nonnegative().nullable(),
    contentType: z.string().nullable()
  })
});

function principalFromContext(context: { http?: { authInfo?: AuthInfo } }): Principal {
  const extra = context.http?.authInfo?.extra;
  if (!extra || typeof extra.userId !== "string" || typeof extra.displayName !== "string" ||
      (extra.role !== "user" && extra.role !== "admin")) {
    throw new RequirementValidationError("Authenticated principal is missing");
  }
  return {
    userId: extra.userId,
    displayName: extra.displayName,
    role: extra.role,
    ...((typeof extra.openProjectLogin === "string" || extra.openProjectLogin === null) ? { openProjectLogin: extra.openProjectLogin } : {}),
    ...(typeof extra.via === "string" ? { via: extra.via } : {})
  };
}

async function toolResult<T>(operation: () => Promise<T>) {
  try {
    return jsonResult(await operation());
  } catch (error) {
    const expected = error instanceof RequirementConflictError || error instanceof RequirementValidationError;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          error: expected ? error.name : "InternalError",
          message: error instanceof Error ? error.message : "Unknown error"
        })
      }],
      isError: true
    };
  }
}

function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "eva-project-openproject", version: "0.2.0" },
    {
      maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS,
      instructions: "Always pass the project identifier recorded by the current project. Use list or tree for compact discovery and get only for full detail. Mutations return compact receipts, preserve OpenProject lockVersion conflicts and never replace another session's claim. requirements_* manage what should be built; handoff_* carry where a working session stopped. When continuing another session's work, call handoff_latest first and read full sections only if its digest is not enough. A handoff never stores requirement state, so a disagreement it reports is a prompt to update the requirement, not a conflict to resolve inside the handoff."
    }
  );

  server.registerTool(
    "eva_connection_info",
    { description: "Read the authenticated Eva identity and instance URL for connection verification.", inputSchema: z.object({}) },
    (_input, context) => toolResult(async () => {
      const principal = principalFromContext(context);
      return { userId: principal.userId, displayName: principal.displayName, role: principal.role, agent: principal.via ?? "未知 Agent", publicUrl: config.openProjectPublicUrl };
    })
  );

  server.registerTool(
    "requirements_projects",
    {
      description: "List OpenProject projects available as requirement scopes.",
      inputSchema: z.object({
        cursor: z.string().optional(),
        page_size: z.number().int().min(1).max(100).optional()
      })
    },
    (input, context) => toolResult(() => requirements.listProjects(principalFromContext(context), {
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.page_size ? { pageSize: input.page_size } : {})
    }))
  );

  server.registerTool(
    "requirements_project_create",
    {
      description: "Create a private OpenProject requirement project and grant the authenticated caller the explicit Member (成员) role, verifying membership and visibility before success. Reuse an existing project only if the caller already has access; reuse never grants or upgrades membership. Refuses a project whose enabled types cannot hold what a pool holds. A membership failure after creation reports the project for administrator review rather than claiming success.",
      inputSchema: z.object({
        project: z.string().min(1),
        name: z.string().min(1).optional()
      }),
      outputSchema: projectCreateOutputSchema
    },
    (input, context) => toolResult(() => requirements.createProject({
      project: input.project,
      ...(input.name ? { name: input.name } : {})
    }, principalFromContext(context)))
  );

  server.registerTool(
    "requirements_types",
    {
      description: "List requirement types enabled in the selected project. Use their IDs to create, update or filter requirements by type.",
      inputSchema: z.object({ project: z.string().min(1) })
    },
    (input, context) => toolResult(() => requirements.types(input.project, principalFromContext(context)))
  );

  server.registerTool(
    "requirements_list",
    {
      description: "List requirement summaries with filters and a pagination cursor.",
      inputSchema: z.object({
        project: z.string().min(1).describe("Stable project identifier, not the numeric project_id."),
        cursor: z.string().optional().describe("Opaque cursor returned by the previous page."),
        page_size: z.number().int().min(1).max(50).optional().describe("Number of visible summaries to return; maximum 50."),
        module: moduleSchema.optional(),
        type_id: z.number().int().positive().optional(),
        responsible_agent: responsibleAgentSchema.optional(),
        state: stateSchema.optional(),
        unclaimed: z.boolean().optional(),
        subject: z.string().min(1).optional()
          .describe("Substring of the subject; OpenProject matches it, so paging and totals stay correct."),
        ready: z.boolean().optional(),
        sort_by: z.string().optional().describe("field:direction, e.g. createdAt:asc. Fields: updatedAt, createdAt, id, subject. Defaults to updatedAt:desc.")
      })
    },
    (input, context) => toolResult(() => requirements.list({
      project: input.project,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.page_size ? { pageSize: input.page_size } : {}),
      ...(input.module ? { module: input.module } : {}),
      ...(input.type_id !== undefined ? { typeId: input.type_id } : {}),
      ...(input.responsible_agent ? { responsibleAgent: input.responsible_agent } : {}),
      ...(input.state ? { state: input.state } : {}),
      ...(input.unclaimed !== undefined ? { unclaimed: input.unclaimed } : {}),
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.ready !== undefined ? { ready: input.ready } : {}),
      ...(input.sort_by ? { sortBy: input.sort_by } : {})
    }, principalFromContext(context)))
  );

  server.registerTool(
    "requirements_search",
    {
      description: "Find requirements and handoffs by words in their title, business id, body or comments, as the top bar searches: every project the caller may see unless project narrows it, with the same visibility rules. Each word must appear in at least one of those fields. Answers a requirements group and a handoffs group, each with its total and a page of compact hits naming where the words matched and the text around a body match; read one in full with requirements_get or handoff_get.",
      inputSchema: z.object({
        query: z.string().min(1).max(100)
          .describe("Words separated by spaces. #218 or 218 also finds that work package."),
        project: z.string().min(1).optional()
          .describe("Search one project only, by its stable identifier."),
        group: z.enum(["requirements", "handoffs"]).optional()
          .describe("Page through one group; omit for the first page of both."),
        page: z.number().int().min(1).optional(),
        page_size: z.number().int().min(1).max(50).optional().describe("Hits per group; defaults to 10.")
      })
    },
    (input, context) => toolResult(() => requirements.search({
      query: input.query,
      ...(input.project ? { project: input.project } : {}),
      ...(input.group ? { group: input.group } : {}),
      ...(input.page ? { page: input.page } : {}),
      pageSize: input.page_size ?? 10
    }, principalFromContext(context)))
  );

  server.registerTool(
    "requirements_get",
    {
      description: "Read one requirement with editable content, claim, parent, visible children, compact dependencies, completion readiness and attachment metadata. Pass sections to read only what is needed; sectionNames always says what the body carries.",
      inputSchema: z.object({
        project: z.string().min(1),
        reference: z.union([z.string(), z.number().int().positive()]),
        sections: z.array(requirementSectionSchema).optional()
          .describe("Read only these sections and leave the body out. Omit for the whole record.")
      })
    },
    (input, context) => toolResult(() => requirements.get(
      input.reference, input.project, principalFromContext(context), input.sections))
  );

  server.registerTool(
    "requirements_history",
    {
      description: "Read a requirement's change history: who changed what, when, and the reason given. This is where 变更记录 lives — it is no longer kept in the body. Defaults to the ten most recent entries, oldest-first within the window; raise limit or page back with offset, and set notes_only to see just the reasons.",
      inputSchema: z.object({
        project: z.string().min(1),
        reference: z.union([z.string(), z.number().int().positive()]),
        limit: z.number().int().min(1).max(50).optional()
          .describe("How many of the most recent entries to return. Defaults to 10."),
        offset: z.number().int().min(0).optional()
          .describe("Skip this many from the newest end, to page further back."),
        notes_only: z.boolean().optional()
          .describe("Only entries that carry a reason, skipping bare field changes.")
      })
    },
    (input, context) => toolResult(() => requirements.activities(
      input.reference, input.project, principalFromContext(context), {
        limit: input.limit ?? 10,
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.notes_only !== undefined ? { notesOnly: input.notes_only } : {})
      }))
  );

  server.registerTool(
    "requirements_comment",
    {
      description: "Add an entry to a requirement's history without changing any field. Use it for a 变更记录 entry that no field carries — a decision reversed, a scope call recorded — and for leaving a message to whoever reads the requirement next. Session progress belongs in a handoff, not here. Reads back through requirements_history.",
      inputSchema: z.object({
        project: z.string().min(1),
        reference: z.union([z.string(), z.number().int().positive()]),
        text: z.string().min(1)
          .describe("Recorded verbatim. The history stamps the time and the author itself, so do not restate them.")
      })
    },
    (input, context) => toolResult(() => requirements.comment({
      project: input.project,
      reference: input.reference,
      text: input.text
    }, principalFromContext(context)))
  );

  server.registerTool(
    "requirements_tree",
    {
      description: "Read a compact requirement hierarchy with claim state and root completion blockers.",
      inputSchema: z.object({
        project: z.string().min(1),
        reference: z.union([z.string(), z.number().int().positive()]),
        depth: z.number().int().min(1).max(5).optional().describe("Hierarchy depth below the root; defaults to 2 and is capped at 5.")
      })
    },
    (input, context) => toolResult(() => requirements.tree({
      project: input.project,
      reference: input.reference,
      depth: input.depth ?? 2
    }, principalFromContext(context)))
  );

  server.registerTool(
    "requirements_create",
    {
      description: "Register a requirement while keeping user text, Agent understanding and source separate.",
      inputSchema: requirementFieldsSchema.extend({
        project: z.string().min(1),
        parent: z.union([z.string(), z.number().int().positive()]).optional()
          .describe("The requirement in the same project this one belongs under, such as the one it was split out of; it is created already bound there. Leave it out for a requirement that stands on its own."),
        required_for_parent: z.boolean().optional(),
      }),
      outputSchema: requirementReceiptOutputSchema
    },
    (input, context) => toolResult(async () => {
      const result = await requirements.create({
        ...toCreateInput(input.project, input),
        ...(input.parent !== undefined ? { parent: input.parent } : {})
      }, principalFromContext(context));
      return requirementReceipt(result.replayed ? "existing" : "created", result.item, { replayed: result.replayed });
    })
  );

  server.registerTool(
    "requirements_children_create",
    {
      description: "Create and bind up to 20 child requirements beneath an existing same-project parent; returns one compact result per child and does not roll back successful earlier children.",
      inputSchema: z.object({
        project: z.string().min(1),
        parent: z.union([z.string(), z.number().int().positive()]),
        children: z.array(requirementFieldsSchema.extend({
          required_for_parent: z.boolean()
        })).min(1).max(20)
      }),
      outputSchema: childrenCreateOutputSchema
    },
    (input, context) => toolResult(async () => {
      const result = await requirements.createChildren({
        project: input.project,
        parent: input.parent,
        children: input.children.map(child => {
          const mapped = toCreateInput(input.project, child);
          const { project: _project, requiredForParent: _required, ...fields } = mapped;
          return { ...fields, requiredForParent: child.required_for_parent };
        })
      }, principalFromContext(context));
      return {
        ok: result.results.every(item => item.ok === true),
        action: "children_created",
        parent: compactRequirement(result.parent),
        results: result.results
      };
    })
  );

  server.registerTool(
    "requirements_claim",
    {
      description: "Atomically claim an unclaimed, unblocked requirement for one Agent session.",
      inputSchema: z.object({
        project: z.string().min(1),
        reference: z.union([z.string(), z.number().int().positive()]),
        agent: claimedAgentSchema,
        session_id: z.string().min(1),
        label: z.string().min(1),
        scope: z.string().min(1),
        claimed_at: z.iso.datetime({ offset: true }),
        expected_lock_version: z.number().int().nonnegative()
      }),
      outputSchema: requirementReceiptOutputSchema
    },
    (input, context) => toolResult(async () => {
      const result = await requirements.claim({
      project: input.project,
      reference: input.reference,
      agent: input.agent,
      sessionId: input.session_id,
      label: input.label,
      scope: input.scope,
      claimedAt: input.claimed_at,
      expectedLockVersion: input.expected_lock_version
      }, principalFromContext(context));
      return requirementReceipt(result.replayed ? "already_claimed" : "claimed", result.item, { replayed: result.replayed });
    })
  );

  server.registerTool(
    "requirements_release",
    {
      description: "Release a claim owned by the same Agent session and preserve the reason in history. A claim left behind by a session that is gone can be taken over by the requirement owner with takeover, which is recorded in history.",
      inputSchema: z.object({
        project: z.string().min(1),
        reference: z.union([z.string(), z.number().int().positive()]),
        session_id: z.string().min(1),
        reason: z.string().min(1),
        released_at: z.iso.datetime({ offset: true }),
        expected_lock_version: z.number().int().nonnegative(),
        takeover: z.boolean().optional().describe("Release a claim held by a different session; requires requirement ownership and records the takeover. Use it when the claiming session is gone, never to preempt a live one.")
      }),
      outputSchema: requirementReceiptOutputSchema
    },
    (input, context) => toolResult(async () => requirementReceipt("claim_released", await requirements.release({
      project: input.project,
      reference: input.reference,
      sessionId: input.session_id,
      reason: input.reason,
      releasedAt: input.released_at,
      expectedLockVersion: input.expected_lock_version,
      ...(input.takeover !== undefined ? { takeover: input.takeover } : {})
    }, principalFromContext(context))))
  );

  server.registerTool(
    "requirements_update_state",
    {
      description: "Update a non-completion lifecycle state with a dated note.",
      inputSchema: z.object({
        project: z.string().min(1),
        reference: z.union([z.string(), z.number().int().positive()]),
        state: nonCompletionStateSchema,
        session_id: z.string().optional(),
        note: z.string().min(1),
        changed_at: z.iso.datetime({ offset: true }),
        expected_lock_version: z.number().int().nonnegative()
      }),
      outputSchema: requirementReceiptOutputSchema
    },
    (input, context) => toolResult(async () => requirementReceipt("state_updated", await requirements.updateState({
      project: input.project,
      reference: input.reference,
      state: input.state,
      note: input.note,
      changedAt: input.changed_at,
      ...(input.session_id ? { sessionId: input.session_id } : {}),
      expectedLockVersion: input.expected_lock_version
    }, principalFromContext(context))))
  );

  server.registerTool(
    "requirements_update",
    {
      description: "Update a requirement type, title, Agent understanding, scope or acceptance criteria while preserving the original user text and appending a dated change record.",
      inputSchema: z.object({
        project: z.string().min(1),
        reference: z.union([z.string(), z.number().int().positive()]),
        title: z.string().min(1).optional(),
        type_id: z.number().int().positive().optional().describe("Enabled type ID from requirements_types."),
        agent_understanding: z.string().min(1).optional(),
        scope: z.string().min(1).optional(),
        acceptance_criteria: z.string().min(1).optional(),
        note: z.string().min(1),
        changed_at: z.iso.datetime({ offset: true }),
        session_id: z.string().optional(),
        expected_lock_version: z.number().int().nonnegative()
      }).refine(input => input.title !== undefined || input.type_id !== undefined || input.agent_understanding !== undefined ||
        input.scope !== undefined || input.acceptance_criteria !== undefined, {
        message: "At least one editable content field is required"
      }),
      outputSchema: requirementReceiptOutputSchema
    },
    (input, context) => toolResult(async () => requirementReceipt("content_updated", await requirements.updateContent({
      project: input.project,
      reference: input.reference,
      note: input.note,
      changedAt: input.changed_at,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.type_id !== undefined ? { typeId: input.type_id } : {}),
      ...(input.agent_understanding !== undefined ? { agentUnderstanding: input.agent_understanding } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.acceptance_criteria !== undefined ? { acceptanceCriteria: input.acceptance_criteria } : {}),
      ...(input.session_id !== undefined ? { sessionId: input.session_id } : {}),
      expectedLockVersion: input.expected_lock_version
    }, principalFromContext(context))))
  );

  server.registerTool(
    "requirements_set_parent",
    {
      description: "Set or clear a same-project parent separately from execution dependencies.",
      inputSchema: z.object({
        project: z.string().min(1),
        child: z.union([z.string(), z.number().int().positive()]),
        parent: z.union([z.string(), z.number().int().positive()]).nullable(),
        required_for_parent: z.boolean(),
        expected_lock_version: z.number().int().nonnegative()
      }),
      outputSchema: requirementReceiptOutputSchema
    },
    (input, context) => toolResult(async () => requirementReceipt(
      input.parent === null ? "parent_cleared" : "parent_set",
      await requirements.setParent({
        project: input.project,
        child: input.child,
        parent: input.parent,
        requiredForParent: input.required_for_parent,
        expectedLockVersion: input.expected_lock_version
      }, principalFromContext(context)),
      { parent: input.parent, requiredForParent: input.required_for_parent }
    ))
  );

  server.registerTool(
    "requirements_add_dependency",
    {
      description: "Add a blocking execution dependency without changing parent hierarchy.",
      inputSchema: z.object({
        project: z.string().min(1),
        prerequisite: z.union([z.string(), z.number().int().positive()]),
        dependent: z.union([z.string(), z.number().int().positive()])
      }),
      outputSchema: dependencyReceiptOutputSchema
    },
    (input, context) => toolResult(async () => {
      const relation = await requirements.addDependency({
        project: input.project,
        prerequisite: input.prerequisite,
        dependent: input.dependent
      }, principalFromContext(context));
      return {
        ok: true,
        action: "dependency_added",
        relation: {
          id: relation.id,
          type: relation.type,
          fromWorkPackageId: relationWorkPackageId(relation._links.from.href),
          toWorkPackageId: relationWorkPackageId(relation._links.to.href)
        }
      };
    })
  );

  server.registerTool(
    "requirements_upload_attachment",
    {
      description: "Attach a file to an existing requirement, including images, PDFs, documents and archives (up to 20 MiB). Supply binary files as base64, text as utf8, and an optional MIME content_type. Create the requirement first when adding a new one.",
      inputSchema: z.object({
        project: z.string().min(1),
        reference: z.union([z.string(), z.number().int().positive()]),
        file_name: z.string().min(1),
        content: z.string(),
        encoding: z.enum(["base64", "utf8"]),
        content_type: z.string().optional(),
        description: z.string().optional()
      }),
      outputSchema: attachmentReceiptOutputSchema
    },
    (input, context) => toolResult(async () => {
      const attachment = await requirements.uploadAttachment({
        project: input.project,
        reference: input.reference,
        fileName: input.file_name,
        content: input.content,
        encoding: input.encoding,
        ...(input.content_type ? { contentType: input.content_type } : {}),
        ...(input.description ? { description: input.description } : {})
      }, principalFromContext(context));
      return {
        ok: true,
        action: "attachment_uploaded",
        attachment: {
          id: attachment.id,
          fileName: attachment.fileName,
          fileSize: attachment.fileSize ?? null,
          contentType: attachment.contentType ?? null
        }
      };
    })
  );

  server.registerTool(
    "requirements_upload_markdown",
    {
      description: "Attach one Markdown source file to a requirement.",
      inputSchema: z.object({
        project: z.string().min(1),
        reference: z.union([z.string(), z.number().int().positive()]),
        file_name: z.string().min(1),
        content: z.string(),
        description: z.string().optional()
      }),
      outputSchema: attachmentReceiptOutputSchema
    },
    (input, context) => toolResult(async () => {
      const attachment = await requirements.uploadMarkdown({
      project: input.project,
      reference: input.reference,
      fileName: input.file_name,
      content: input.content,
      ...(input.description ? { description: input.description } : {})
      }, principalFromContext(context));
      return {
        ok: true,
        action: "markdown_uploaded",
        attachment: {
          id: attachment.id,
          fileName: attachment.fileName,
          fileSize: attachment.fileSize ?? null,
          contentType: attachment.contentType ?? null
        }
      };
    })
  );

  server.registerTool(
    "requirements_read_markdown",
    {
      description: "Read one Markdown attachment body on demand.",
      inputSchema: z.object({
        project: z.string().min(1),
        reference: z.union([z.string(), z.number().int().positive()]),
        attachment_id: z.number().int().positive().optional(),
        file_name: z.string().optional()
      })
    },
    (input, context) => toolResult(() => requirements.readMarkdown({
      project: input.project,
      reference: input.reference,
      ...(input.attachment_id ? { attachmentId: input.attachment_id } : {}),
      ...(input.file_name ? { fileName: input.file_name } : {})
    }, principalFromContext(context)))
  );

  const acceptance = {
    verification: z.string().min(1),
    acceptance_status: z.enum(["已验收", "不适用"]),
    acceptance_source: z.string().min(1)
  };
  const gitEvidenceSchema = z.object({
    kind: z.literal("git").optional(),
    repository: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{40}$/i),
    paths: z.array(z.string().min(1)).min(1),
    ...acceptance
  });
  const fileEvidenceSchema = z.object({
    kind: z.literal("file").describe("Files delivered outside any repository, such as a global skill, a hook or local configuration; no commit is involved."),
    locations: z.array(z.string().min(1)).min(1).describe("Where the delivered files or artifacts actually are."),
    change: z.string().min(1).describe("What changed in them."),
    ...acceptance
  });
  const evidenceSchema = z.union([gitEvidenceSchema, fileEvidenceSchema]);
  server.registerTool(
    "requirements_complete",
    {
      description: "Complete a requirement only with delivery evidence and no incomplete blockers or required children.",
      inputSchema: z.object({
        project: z.string().min(1),
        reference: z.union([z.string(), z.number().int().positive()]),
        session_id: z.string().min(1),
        completed_at: z.iso.datetime({ offset: true }),
        evidence: z.array(evidenceSchema).min(1),
        expected_lock_version: z.number().int().nonnegative()
      }),
      outputSchema: requirementReceiptOutputSchema
    },
    (input, context) => toolResult(async () => requirementReceipt("completed", await requirements.complete({
      project: input.project,
      reference: input.reference,
      sessionId: input.session_id,
      completedAt: input.completed_at,
      evidence: input.evidence.map(item => item.kind === "file"
        ? {
            kind: "file" as const,
            locations: item.locations,
            change: item.change,
            verification: item.verification,
            acceptanceStatus: item.acceptance_status,
            acceptanceSource: item.acceptance_source
          }
        : {
            repository: item.repository,
            sha: item.sha,
            paths: item.paths,
            verification: item.verification,
            acceptanceStatus: item.acceptance_status,
            acceptanceSource: item.acceptance_source
          }),
      expectedLockVersion: input.expected_lock_version
    }, principalFromContext(context))))
  );

  server.registerTool(
    "handoff_save",
    {
      description: "Write a session handoff for one work thread. One handoff is written by one session and picked up by one session; a thread keeps at most one waiting to be picked up, so replacing an unclaimed one needs supersede. Requirement state is never copied in — point at requirements from todo lines instead.",
      inputSchema: z.object({
        project: z.string().min(1),
        id: z.string().min(1).describe("Stable handoff identifier, e.g. EVAPROJECT-HO-20260921-001."),
        title: z.string().min(1),
        thread: z.string().min(1).describe("The work line this continues: a requirement id for a single-requirement session, otherwise a stable label. Never derived from the branch name."),
        background: z.string().min(1).describe("Goal, constraints, decisions already made."),
        main_line: z.string().min(1).describe("What was done, which files or areas, current direction."),
        current_state: z.string().min(1).describe("Branch and git state, running services, validation already run, known blockers."),
        todos: z.string().describe("Markdown task list. One line per item: - [x] (T1) text · 需求:ID · 状态:进行中 · 提交:sha · 依赖:T2 · 说明:note. 需求 and 状态 are optional and independent of whether the box is ticked."),
        notes: z.string().min(1).describe("Agent-neutral only: no tool names, skill names or session-id formats, because the next session may be a different agent."),
        repository: z.string().min(1),
        branch: z.string().min(1),
        base_commit: z.string().min(1).describe("Full HEAD SHA when the handoff was written; the next session checks it is still in its history."),
        source_session_id: z.string().min(1),
        request_id: z.string().min(1),
        modules: z.array(moduleSchema).min(1),
        visibility: visibilitySchema,
        expected_agent: expectedAgentSchema.optional().describe("Defaults to 不限 so any agent may pick it up. A named agent is a guard rail, not an enforced rule."),
        previous: z.string().optional(),
        supersede: z.boolean().optional()
      })
    },
    (input, context) => toolResult(async () => {
      const principal = principalFromContext(context);
      const result = await handoffs.save({
        project: input.project,
        id: input.id,
        title: input.title,
        thread: input.thread,
        sections: {
          背景: input.background,
          主线: input.main_line,
          现状: input.current_state,
          待办: input.todos,
          注意事项: input.notes
        },
        repository: input.repository,
        branch: input.branch,
        baseCommit: input.base_commit,
        sourceSessionId: input.source_session_id,
        requestId: input.request_id,
        modules: input.modules,
        visibility: input.visibility as "公开" | "私有",
        ...(input.expected_agent ? { expectedAgent: input.expected_agent } : {}),
        ...(input.previous ? { previous: input.previous } : {}),
        ...(input.supersede !== undefined ? { supersede: input.supersede } : {})
      }, principal);
      const linked = result.replayed
        ? []
        : await handoffs.linkRequirements({ project: input.project, reference: result.item.workPackageId }, principal);
      return handoffReceipt(result.replayed ? "existing" : "saved", result.item, {
        replayed: result.replayed,
        linkedRequirements: linked
      });
    })
  );

  server.registerTool("requirements_reopen", {
    description: "Reopen a completed requirement with a reason. Preserves delivery history and resets claim and acceptance.",
    inputSchema: z.object({ project: z.string().min(1), reference: z.union([z.string(), z.number()]),
      reason: z.string().trim().min(1), lock_version: z.number().int().nonnegative() })
  }, (input, context) => toolResult(() => requirements.reopen({
    project: input.project, reference: input.reference, reason: input.reason,
    changedAt: new Date().toISOString(), expectedLockVersion: input.lock_version
  }, principalFromContext(context))));

  server.registerTool(
    "handoff_latest",
    {
      description: "First call when continuing someone else's work: the newest handoff on a thread that is still waiting to be picked up, as a compact digest. Returns the open todos and the live state of every requirement they reference, not the prose — read specific sections with handoff_get only if the digest is not enough.",
      inputSchema: z.object({
        project: z.string().min(1),
        thread: z.string().min(1),
        open_todo_limit: z.number().int().min(1).max(50).optional()
      })
    },
    (input, context) => toolResult(async () => {
      const result = await handoffs.latest({
        project: input.project,
        thread: input.thread,
        ...(input.open_todo_limit !== undefined ? { openTodoLimit: input.open_todo_limit } : {})
      }, principalFromContext(context));
      return result ?? { handoff: null, reason: `No handoff is waiting on thread ${input.thread}` };
    })
  );

  server.registerTool(
    "handoff_get",
    {
      description: "Read a handoff's prose sections and full todo list. Pass sections to read only what is needed; every todo comes back with the referenced requirement's current state and whether the two agree.",
      inputSchema: z.object({
        project: z.string().min(1),
        reference: handoffReference,
        sections: z.array(handoffSectionSchema).optional()
      })
    },
    (input, context) => toolResult(() => handoffs.get({
      project: input.project,
      reference: input.reference,
      ...(input.sections ? { sections: input.sections } : {})
    }, principalFromContext(context)))
  );

  server.registerTool(
    "handoff_claim",
    {
      description: "Atomically pick up a handoff for one session. Check the repository, branch and base commit first. A handoff already claimed by another session is refused, never preempted.",
      inputSchema: z.object({
        project: z.string().min(1),
        reference: handoffReference,
        agent: claimedAgentSchema,
        session_id: z.string().min(1),
        label: z.string().min(1),
        scope: z.string().min(1),
        claimed_at: z.iso.datetime({ offset: true }),
        expected_lock_version: z.number().int().nonnegative(),
        override: z.boolean().optional().describe("Claim despite a different expected agent; the override is recorded in history.")
      })
    },
    (input, context) => toolResult(async () => {
      const result = await handoffs.claim({
        project: input.project,
        reference: input.reference,
        agent: input.agent,
        sessionId: input.session_id,
        label: input.label,
        scope: input.scope,
        claimedAt: input.claimed_at,
        expectedLockVersion: input.expected_lock_version,
        ...(input.override !== undefined ? { override: input.override } : {})
      }, principalFromContext(context));
      return handoffReceipt(result.replayed ? "already_claimed" : "claimed", result.item, { replayed: result.replayed });
    })
  );

  server.registerTool(
    "handoff_release",
    {
      description: "Hand a claimed handoff back so the thread can be picked up again. A claim left behind by a session that is gone can be released by the handoff owner with takeover, which is recorded; without it the claim is preserved.",
      inputSchema: z.object({
        project: z.string().min(1),
        reference: handoffReference,
        session_id: z.string().min(1),
        reason: z.string().min(1),
        released_at: z.iso.datetime({ offset: true }),
        expected_lock_version: z.number().int().nonnegative(),
        takeover: z.boolean().optional().describe("Release a claim held by a different session. Use it when that session is gone, never to preempt a live one.")
      })
    },
    (input, context) => toolResult(async () => handoffReceipt("released", await handoffs.release({
      project: input.project,
      reference: input.reference,
      sessionId: input.session_id,
      reason: input.reason,
      releasedAt: input.released_at,
      expectedLockVersion: input.expected_lock_version,
      ...(input.takeover !== undefined ? { takeover: input.takeover } : {})
    }, principalFromContext(context))))
  );

  server.registerTool(
    "handoff_update_section",
    {
      description: "Rewrite one prose section of an existing handoff, leaving every other section and the todo list untouched. This is how a handoff gets corrected: saving the same id again never overwrites it. \u5f85\u529e belongs to handoff_update_todos.",
      inputSchema: z.object({
        project: z.string().min(1),
        reference: handoffReference,
        section: handoffProseSectionSchema,
        content: z.string().describe("The section's whole new body; it replaces what is there."),
        note: z.string().min(1).describe("Why it changed, recorded in the work package journal."),
        changed_at: z.iso.datetime({ offset: true }),
        session_id: z.string().optional(),
        expected_lock_version: z.number().int().nonnegative()
      })
    },
    (input, context) => toolResult(async () => handoffReceipt("section_updated", await handoffs.updateSection({
      project: input.project,
      reference: input.reference,
      section: input.section,
      content: input.content,
      note: input.note,
      changedAt: input.changed_at,
      ...(input.session_id ? { sessionId: input.session_id } : {}),
      expectedLockVersion: input.expected_lock_version
    }, principalFromContext(context))))
  );

  server.registerTool(
    "handoff_update_todos",
    {
      description: "Replace the todo list, leaving every other section untouched. Counts are recomputed from the list. Ticking a todo records progress on that step only: it never advances a requirement, which still needs requirements_complete with evidence.",
      inputSchema: z.object({
        project: z.string().min(1),
        reference: handoffReference,
        todos: z.string().describe("The whole list in the same line syntax handoff_save uses."),
        note: z.string().min(1),
        changed_at: z.iso.datetime({ offset: true }),
        session_id: z.string().optional(),
        expected_lock_version: z.number().int().nonnegative()
      })
    },
    (input, context) => toolResult(async () => {
      const result = await handoffs.updateTodos({
        project: input.project,
        reference: input.reference,
        todos: input.todos,
        note: input.note,
        changedAt: input.changed_at,
        ...(input.session_id ? { sessionId: input.session_id } : {}),
        expectedLockVersion: input.expected_lock_version
      }, principalFromContext(context));
      return handoffReceipt("todos_updated", result.item, { total: result.total, done: result.done });
    })
  );

  server.registerTool(
    "handoff_update_state",
    {
      description: "Move a handoff through its lifecycle: 草稿, 待接手, 已接手, 已归档, 已作废.",
      inputSchema: z.object({
        project: z.string().min(1),
        reference: handoffReference,
        state: handoffStateSchema,
        note: z.string().min(1),
        changed_at: z.iso.datetime({ offset: true }),
        session_id: z.string().optional(),
        expected_lock_version: z.number().int().nonnegative()
      })
    },
    (input, context) => toolResult(async () => handoffReceipt("state_updated", await handoffs.updateState({
      project: input.project,
      reference: input.reference,
      state: input.state,
      note: input.note,
      changedAt: input.changed_at,
      ...(input.session_id ? { sessionId: input.session_id } : {}),
      expectedLockVersion: input.expected_lock_version
    }, principalFromContext(context))))
  );

  server.registerTool(
    "handoff_list",
    {
      description: "List handoffs in a project, optionally narrowed to one thread or state. Filtering on 待接手 shows which threads are waiting for someone to continue them.",
      inputSchema: z.object({
        project: z.string().min(1),
        thread: z.string().optional(),
        state: handoffStateSchema.optional(),
        unclaimed: z.boolean().optional(),
        cursor: z.string().optional(),
        page_size: z.number().int().min(1).max(50).optional()
      })
    },
    (input, context) => toolResult(() => handoffs.list({
      project: input.project,
      ...(input.thread ? { thread: input.thread } : {}),
      ...(input.state ? { state: input.state } : {}),
      ...(input.unclaimed !== undefined ? { unclaimed: input.unclaimed } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.page_size ? { pageSize: input.page_size } : {})
    }, principalFromContext(context)))
  );

  return server;
}

const mcpEndpoint = new McpHttpEndpoint(buildMcpServer);

const validateHost = hostHeaderValidation(config.allowedHosts);

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function sendStatic(response: ServerResponse, contentType: string, body: string, status = 200): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer"
  });
  response.end(body);
}

function validMutationOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;
  return origin === `http://${host}` || origin === `https://${host}`;
}

function handoffLoginLocation(): string {
  const backUrl = `${config.openProjectPublicUrl}/handoff`;
  return `${config.openProjectPublicUrl}/login?back_url=${encodeURIComponent(backUrl)}`;
}

/**
 * Resolves the browser session to the same Principal the MCP would build from a token.
 *
 * A login with no MCP identity is refused rather than approximated. Treating the
 * OpenProject login as an MCP user id would silently diverge the moment the two naming
 * schemes differ, and permission bugs of that shape fail quietly.
 */
async function principalFromSession(
  request: IncomingMessage
): Promise<{ principal: Principal } | { error: { status: number; body: Record<string, unknown> } }> {
  const access = await openProjectSessionUser(request.headers.cookie, config.openProjectBaseUrl);
  if (access.status === "unauthenticated") {
    return { error: { status: 401, body: { error: "请先登录 Eva Project", login: handoffLoginLocation() } } };
  }
  if (access.status === "unavailable") {
    return { error: { status: 503, body: { error: "暂时无法验证身份，请稍后重试" } } };
  }
  const managed = principalStore.findByOpenProjectLogin(access.user.login);
  if (!managed) {
    return {
      error: {
        status: 403,
        body: {
          error: `网页账号 ${access.user.login} 没有唯一且已启用的 MCP 身份。请让管理员在 MCP 用户页面新增或编辑账号关联，并检查重复关联`,
          needsToken: true
        }
      }
    };
  }
  return {
    principal: {
      userId: managed.userId,
      displayName: managed.displayName,
      role: managed.role,
      // The login is already known here; carrying it avoids a second lookup later.
      openProjectLogin: access.user.login,
      // A signed-in person on the pool page, acting for themselves.
      via: WEB_CHANNEL
    }
  };
}

async function handleHandoffApi(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  const resolved = await principalFromSession(request);
  if ("error" in resolved) {
    sendJson(response, resolved.error.status, resolved.error.body);
    return;
  }
  if (request.method !== "GET" && !validMutationOrigin(request)) {
    sendJson(response, 403, { error: "请求来源无效" });
    return;
  }
  const principal = resolved.principal;
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const project = url.searchParams.get("project") ?? config.fieldMap.defaultProjectIdentifier;
  const now = () => new Date().toISOString();

  try {
    if (request.method === "GET" && pathname === "/handoff/api/session") {
      sendJson(response, 200, {
        user: principal,
        project,
        openProjectUrl: config.openProjectPublicUrl,
        projects: await requirements.everyVisibleProject(principal)
      });
      return;
    }

    if (request.method === "POST" && pathname === "/handoff/api/handoffs") {
      const input = await prepareWebHandoff(project, await readJson(request, 1024 * 1024), principal, {
        requirement: reference => requirements.get(reference, project, principal, ["用户原文"]),
        handoff: async reference => {
          const earlier = await handoffs.get({ project, reference }, principal);
          return { thread: (earlier.handoff as HandoffSummary).thread };
        }
      });
      const result = await handoffs.save(input, principal);
      sendJson(response, result.replayed ? 200 : 201, result);
      return;
    }

    if (request.method === "GET" && pathname === "/handoff/api/handoffs") {
      const state = url.searchParams.get("state");
      const thread = url.searchParams.get("thread");
      const query = url.searchParams.get("q");
      const cursor = url.searchParams.get("cursor");
      const records = await handoffs.list({
        project,
        ...(state ? { state } : {}),
        ...(thread ? { thread } : {}),
        ...(query ? { query } : {}),
        ...(cursor ? { cursor } : {}),
        pageSize: Number(url.searchParams.get("page_size") ?? 50)
      }, principal);
      sendJson(response, 200, { ...records, permissions: await handoffs.projectAccess(project, principal) });
      return;
    }

    const detail = pathname.match(/^\/handoff\/api\/handoffs\/([^/]+)$/);
    if (request.method === "GET" && detail) {
      const record = await handoffs.get({
        project,
        reference: decodeURIComponent(detail[1] ?? "")
      }, principal);
      sendJson(response, 200, { ...record, permissions: await handoffs.recordAccess(
        decodeURIComponent(detail[1] ?? ""), project, principal, `web:${principal.userId}`) });
      return;
    }

    const action = pathname.match(/^\/handoff\/api\/handoffs\/([^/]+)\/(todos|state|release|sections|claim)$/);
    if (request.method === "POST" && action) {
      const reference = decodeURIComponent(action[1] ?? "");
      const body = await readJson(request, 1024 * 1024);
      const lockVersion = { expectedLockVersion: requireLockVersion(body.lockVersion) };

      const webSession = `web:${principal.userId}`;
      if (action[2] === "claim" || (action[2] === "state" && body.state === "已接手")) {
        if (!Number.isInteger(body.lockVersion) || Number(body.lockVersion) < 0) {
          throw new RequirementValidationError("缺少记录版本，请刷新后再接手");
        }
        const result = await handoffs.claim({
          project, reference, agent: "", sessionId: webSession,
          label: principal.displayName, scope: "在网页接手交接", claimedAt: now(),
          override: body.override === true, ...lockVersion
        }, principal);
        sendJson(response, 200, { handoff: result.item, replayed: result.replayed });
        return;
      }

      if (action[2] === "todos") {
        if (typeof body.todos !== "string") throw new Error("待办内容无效");
        const result = await handoffs.updateTodos({
          project, reference, todos: body.todos,
          note: typeof body.note === "string" && body.note ? body.note : "在网页上更新待办",
          changedAt: now(), sessionId: webSession, ...lockVersion
        }, principal);
        sendJson(response, 200, { handoff: result.item, total: result.total, done: result.done });
        return;
      }
      if (action[2] === "sections") {
        if (typeof body.section !== "string" || typeof body.content !== "string") throw new Error("章节内容无效");
        sendJson(response, 200, {
          handoff: await handoffs.updateSection({
            project, reference,
            section: body.section as never,
            content: body.content,
            note: "在网页上编辑正文",
            changedAt: now(), sessionId: webSession, ...lockVersion
          }, principal)
        });
        return;
      }
      if (action[2] === "state") {
        if (typeof body.state !== "string") throw new Error("状态无效");
        sendJson(response, 200, {
          handoff: await handoffs.updateState({
            project, reference, state: body.state,
            note: typeof body.note === "string" && body.note ? body.note : "在网页上更新状态",
            changedAt: now(), sessionId: webSession, ...lockVersion
          }, principal)
        });
        return;
      }
      // The current person releases their own web claim; takeover retains the owner/admin check.
      sendJson(response, 200, {
        handoff: await handoffs.release({
          project, reference,
          sessionId: webSession,
          reason: typeof body.reason === "string" ? body.reason : "",
          releasedAt: now(), takeover: true, ...lockVersion
        }, principal)
      });
      return;
    }

    sendJson(response, 404, { error: "页面不存在" });
  } catch (error) {
    const conflict = error instanceof RequirementConflictError;
    sendJson(response, conflict ? 409 : 400, {
      error: browserError(error),
      ...(conflict ? { conflict: true } : {})
    });
  }
}

const PENDING_HANDOFF_LIMIT = 5;

type PendingHandoff = Pick<HandoffSummary,
  "id" | "workPackageId" | "title" | "thread" | "expectedAgent" | "todoTotal" | "todoDone" | "updatedAt"
> & { project: string };

/**
 * Handoffs waiting to be picked up, per project and in total, for the home page. They
 * are read the way the handoff page reads them, so their visibility rules hold here too.
 * A project whose handoffs cannot be read answers null: a count nobody knows is not zero.
 */
async function pendingHandoffs(projects: string[], principal: Principal): Promise<{
  all: { total: number; items: PendingHandoff[] };
  projects: Record<string, { total: number; items: PendingHandoff[] } | null>;
}> {
  const newestFirst = (a: PendingHandoff, b: PendingHandoff) =>
    (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0);
  const lists = await Promise.all(projects.map(async project => {
    try {
      const result = await handoffs.list({ project, state: "待接手", pageSize: PENDING_HANDOFF_LIMIT }, principal);
      const items = result.items.map(({ id, workPackageId, title, thread, expectedAgent, todoTotal, todoDone, updatedAt }) =>
        ({ id, workPackageId, project, title, thread, expectedAgent, todoTotal, todoDone, updatedAt }));
      return [project, { total: result.total, items }] as const;
    } catch {
      return [project, null] as const;
    }
  }));
  const known = lists.flatMap(([, list]) => (list ? [list] : []));
  return {
    all: {
      total: known.reduce((sum, list) => sum + list.total, 0),
      items: known.flatMap(list => list.items).sort(newestFirst).slice(0, PENDING_HANDOFF_LIMIT)
    },
    projects: Object.fromEntries(lists)
  };
}

/**
 * Read API behind the requirement pool page.
 *
 * Same shape as the handoff module: the browser reaches it through OpenProject, which
 * forwards the session cookie, so identity and per-record visibility are decided by the
 * same code that answers an agent. Reading OpenProject's own API from the page instead
 * would skip `canRead` entirely — 可见性 is a custom field OpenProject attaches no
 * meaning to — and hand every logged-in person everyone else's private requirements.
 */
async function handleRequirementsApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<void> {
  const resolved = await principalFromSession(request);
  if ("error" in resolved) {
    sendJson(response, resolved.error.status, resolved.error.body);
    return;
  }
  if (request.method !== "GET" && !validMutationOrigin(request)) {
    sendJson(response, 403, { error: "请求来源无效" });
    return;
  }
  const principal = resolved.principal;
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const project = url.searchParams.get("project") ?? config.fieldMap.defaultProjectIdentifier;

  try {
    if (request.method === "GET" && pathname === "/requirements/api/session") {
      sendJson(response, 200, {
        user: principal,
        project,
        openProjectUrl: config.openProjectPublicUrl,
        projects: await requirements.everyVisibleProject(principal)
      });
      return;
    }

    if (request.method === "POST" && pathname === "/requirements/api/requirements") {
      const input = webRequirement(project, await readJson(request, 1024 * 1024), principal);
      const result = await requirements.create(input, principal, { webCreation: true });
      sendJson(response, result.replayed ? 200 : 201, result);
      return;
    }

    if (request.method === "GET" && pathname === "/requirements/api/meta") {
      sendJson(response, 200, {
        ...(await requirements.types(project, principal)),
        options: requirements.fieldOptions(),
        permissions: await requirements.projectAccess(project, principal)
      });
      return;
    }

    // The home page. It counts across every project this person may see, so no project
    // parameter applies. The periods are the reader's, sent as timestamps: the chosen one
    // as from/to, the trend's as its comma-separated edges.
    if (request.method === "GET" && pathname === "/requirements/api/dashboard") {
      const dashboard = await requirements.dashboard({
        from: url.searchParams.get("from") ?? "",
        to: url.searchParams.get("to") ?? "",
        edges: (url.searchParams.get("edges") ?? "").split(",").map(value => value.trim()).filter(Boolean)
      }, principal);
      sendJson(response, 200, {
        ...dashboard,
        endedStates: [...config.fieldMap.completionStates, "取消"],
        handoffs: await pendingHandoffs(dashboard.projects.map(project => project.identifier), principal)
      });
      return;
    }

    // The top bar's search (#218). It looks across every project this person may see, so
    // no project parameter applies; without a group it answers both.
    if (request.method === "GET" && pathname === "/requirements/api/search") {
      const text = (name: string) => url.searchParams.get(name) ?? undefined;
      sendJson(response, 200, await requirements.search({
        query: text("q") ?? "",
        ...(text("group") ? { group: text("group") as string } : {}),
        ...(text("page") ? { page: Number(text("page")) } : {}),
        ...(text("page_size") ? { pageSize: Number(text("page_size")) } : {})
      }, principal));
      return;
    }

    // The pool page reads its list as a tree, so a child is never on a different page from
    // its parent (#201). The agent tool keeps the flat list.
    if (request.method === "GET" && pathname === "/requirements/api/requirements") {
      const text = (name: string) => url.searchParams.get(name) ?? undefined;
      const typeId = text("type_id");
      sendJson(response, 200, await requirements.listTree({
        project,
        pageSize: Number(text("page_size") ?? 50),
        ...(text("cursor") ? { cursor: text("cursor") as string } : {}),
        ...(text("state") ? { state: text("state") as string } : {}),
        ...(text("module") ? { module: text("module") as string } : {}),
        ...(text("responsible_agent") ? { responsibleAgent: text("responsible_agent") as string } : {}),
        ...(typeId ? { typeId: Number(typeId) } : {}),
        ...(url.searchParams.get("unclaimed") === "1" ? { unclaimed: true } : {}),
        ...(text("subject") ? { subject: text("subject") as string } : {}),
        ...(text("requirement_id") ? { requirementId: text("requirement_id") as string } : {}),
        // Repeatable, and a comma-separated value is split too, so "40,42" works.
        ...(() => {
          const raw = url.searchParams.getAll("ids").flatMap(value => value.split(","));
          const ids = raw.map(value => value.trim()).filter(Boolean);
          return ids.length ? { ids } : {};
        })(),
        ...(text("sort_by") ? { sortBy: text("sort_by") as string } : {}),
        // Repeatable. The page sends 已完成 unless the reader asks for it.
        ...(url.searchParams.getAll("exclude_state").length
          ? { excludeStates: url.searchParams.getAll("exclude_state") }
          : {}),
        // Column filters arrive as repeated `select.<field>=value`.
        ...(() => {
          const select: Record<string, string[]> = {};
          for (const [key, value] of url.searchParams.entries()) {
            if (!key.startsWith("select.")) continue;
            const field = key.slice("select.".length);
            (select[field] ??= []).push(value);
          }
          return Object.keys(select).length ? { select } : {};
        })()
      }, principal));
      return;
    }

    const detail = pathname.match(/^\/requirements\/api\/requirements\/([^/]+)$/);
    if (request.method === "GET" && detail?.[1]) {
      // The page reads whole records, so no sections means exactly what it always got.
      const wanted = url.searchParams.getAll("sections")
        .flatMap(value => value.split(","))
        .map(value => value.trim())
        .filter(Boolean);
      const record = await requirements.get(
        decodeURIComponent(detail[1]), project, principal,
        wanted.length ? wanted : undefined);
      sendJson(response, 200, { ...record, permissions: await requirements.recordAccess(
        decodeURIComponent(detail[1]), project, principal, `web:${principal.userId}`) });
      return;
    }

    const activities = pathname.match(/^\/requirements\/api\/requirements\/([^/]+)\/activities$/);
    if (request.method === "GET" && activities?.[1]) {
      sendJson(response, 200, await requirements.activities(
        decodeURIComponent(activities[1]), project, principal));
      return;
    }

    const action = pathname.match(
      /^\/requirements\/api\/requirements\/([^/]+)\/(state|content|comment|claim|release|complete|reopen|attachment|parent|dependency)$/);
    if (request.method === "POST" && action?.[1] && action[2]) {
      const reference = decodeURIComponent(action[1]);
      const body = await readJson(request, action[2] === "attachment" ? 32 * 1024 * 1024 : 1024 * 1024);
      const note = typeof body.note === "string" && body.note ? body.note : "在网页上修改";
      const lockVersion = ["comment", "attachment", "dependency"].includes(action[2]) ? {}
        : { expectedLockVersion: requireLockVersion(body.lockVersion) };
      const changedAt = new Date().toISOString();

      // Claiming, releasing and completing already exist on the service with their own
      // rules — atomicity, takeover, the evidence a completion has to carry. These pass
      // straight through rather than restating any of it.
      // A person is not a session, so the web acts under one named after them, the same
      // convention the handoff page uses.
      const webSession = `web:${principal.userId}`;
      if (action[2] === "attachment") {
        const input = z.object({ fileName: z.string(), content: z.string(), contentType: z.string().optional() }).strict().parse(body);
        const attachment = await requirements.uploadAttachment({ project, reference, fileName: input.fileName,
          content: input.content, ...(input.contentType ? { contentType: input.contentType } : {}), encoding: "base64" }, principal);
        sendJson(response, 201, { attachment });
        return;
      }
      if (action[2] === "parent") {
        const input = z.object({ parent: z.number().int().positive().nullable(), requiredForParent: z.boolean(), lockVersion: z.number().int().nonnegative() }).strict().parse(body);
        sendJson(response, 200, { requirement: await requirements.setParent({
          project, child: reference, parent: input.parent, requiredForParent: input.requiredForParent, ...lockVersion
        }, principal) });
        return;
      }
      if (action[2] === "dependency") {
        const input = z.object({ prerequisite: z.number().int().positive() }).strict().parse(body);
        sendJson(response, 201, { relation: await requirements.addDependency({
          project, prerequisite: input.prerequisite, dependent: reference
        }, principal) });
        return;
      }
      if (action[2] === "reopen") {
        if (typeof body.reason !== "string") throw new RequirementValidationError("请填写重新打开的原因");
        sendJson(response, 200, { requirement: await requirements.reopen({
          project, reference, reason: body.reason, changedAt, ...lockVersion
        }, principal) });
        return;
      }
      if (action[2] === "claim") {
        const result = await requirements.claim({
          project, reference,
          agent: typeof body.agent === "string" ? body.agent : "",
          sessionId: webSession,
          label: typeof body.label === "string" && body.label ? body.label : principal.displayName,
          scope: typeof body.scope === "string" ? body.scope : "",
          claimedAt: new Date().toISOString(),
          ...lockVersion
        }, principal);
        sendJson(response, 200, { requirement: result.item, replayed: result.replayed });
        return;
      }
      if (action[2] === "release") {
        sendJson(response, 200, {
          requirement: await requirements.release({
            project, reference,
            sessionId: webSession,
            reason: typeof body.reason === "string" && body.reason ? body.reason : "在网页上释放",
            releasedAt: new Date().toISOString(),
            // From the web this is always a takeover: the person is not the session that
            // holds it.
            takeover: true,
            ...lockVersion
          }, principal)
        });
        return;
      }
      if (action[2] === "complete") {
        sendJson(response, 200, {
          requirement: await requirements.complete({
            project, reference,
            sessionId: webSession,
            completedAt: new Date().toISOString(),
            evidence: Array.isArray(body.evidence) ? body.evidence as never : [],
            ...lockVersion
          }, principal, { byHand: true })
        });
        return;
      }
      if (action[2] === "comment") {
        if (typeof body.text !== "string") throw new Error("评论内容无效");
        sendJson(response, 200, await requirements.comment({ project, reference, text: body.text }, principal));
        return;
      }
      if (action[2] === "state") {
        if (typeof body.state !== "string") throw new Error("需求状态无效");
        // A signed-in person changing the state by hand, 已完成 included.
        sendJson(response, 200, {
          requirement: await requirements.updateState({
            project, reference, state: body.state, note, changedAt, ...lockVersion
          }, principal, { byHand: true })
        });
        return;
      }
      sendJson(response, 200, {
        requirement: await requirements.updateContent({
          project, reference, note, changedAt, ...lockVersion,
          sessionId: webSession,
          ...(typeof body.responsibleAgent === "string" ? { responsibleAgent: body.responsibleAgent } : {}),
          ...(typeof body.title === "string" ? { title: body.title } : {}),
          ...(typeof body.typeId === "number" ? { typeId: body.typeId } : {}),
          ...(typeof body.agentUnderstanding === "string" ? { agentUnderstanding: body.agentUnderstanding } : {}),
          ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
          ...(typeof body.acceptanceCriteria === "string" ? { acceptanceCriteria: body.acceptanceCriteria } : {})
        }, principal)
      });
      return;
    }

    sendJson(response, 404, { error: "页面不存在" });
  } catch (error) {
    const conflict = error instanceof RequirementConflictError;
    sendJson(response, conflict ? 409 : 400, {
      error: browserError(error),
      ...(conflict ? { conflict: true } : {})
    });
  }
}

function browserError(error: unknown): string {
  if (error instanceof RequirementConflictError) {
    if (/already claimed/i.test(error.message)) return "此记录已被其他会话接手，请刷新查看当前处理人";
    if (/lockVersion/i.test(error.message)) return "记录已被其他人修改，请刷新后重新确认";
  }
  if (error instanceof z.ZodError) return error.issues.map(issue => issue.message).join("；");
  if (error instanceof OpenProjectHttpError) {
    if (error.status === 409) return "记录已被其他人修改，请刷新后重新确认";
    if (error.status === 403) return "当前账号没有执行此操作的权限";
    if (error.status === 422) {
      const body = error.body as { message?: unknown } | null;
      return `保存未通过校验，请检查必填字段和状态工作流。${typeof body?.message === "string" ? body.message : ""}`;
    }
    return "任务服务暂时不可用，请稍后重试";
  }
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

async function handleAdminApi(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  const access = await openProjectAdminAccess(request.headers.cookie, config.openProjectBaseUrl);
  if (access === "unauthenticated") {
    sendJson(response, 401, { error: "请先登录 Eva Project 管理员帐号" });
    return;
  }
  if (access === "forbidden") {
    sendJson(response, 403, { error: "需要 Eva Project 管理员权限" });
    return;
  }
  if (access === "unavailable") {
    sendJson(response, 503, { error: "暂时无法验证 Eva Project 管理员身份" });
    return;
  }
  if (request.method !== "GET" && !validMutationOrigin(request)) {
    sendJson(response, 403, { error: "请求来源无效" });
    return;
  }

  try {
    if (request.method === "GET" && pathname === "/admin/api/users") {
      sendJson(response, 200, { users: principalStore.list() });
      return;
    }
    if (request.method === "POST" && pathname === "/admin/api/users") {
      const body = await readJson(request);
      if (typeof body.userId !== "string" || typeof body.displayName !== "string") {
        throw new Error("用户 ID 和显示名称不能为空");
      }
      if (typeof body.openProjectLogin !== "string") throw new Error("请选择关联网页账号");
      sendJson(response, 201, await principalAdmin.create(body.userId, body.displayName, body.openProjectLogin));
      return;
    }

    if (request.method === "GET" && pathname === "/admin/api/accounts") {
      sendJson(response, 200, { accounts: await principalAdmin.accounts() });
      return;
    }
    const linkMatch = pathname.match(/^\/admin\/api\/users\/([^/]+)\/link$/);
    if (request.method === "POST" && linkMatch) {
      const body = await readJson(request);
      if ((typeof body.openProjectLogin !== "string" && body.openProjectLogin !== null) || typeof body.lockVersion !== "string") {
        throw new Error("请提供关联网页账号和 lockVersion");
      }
      sendJson(response, 200, await principalAdmin.link(decodeURIComponent(linkMatch[1]!), body.openProjectLogin, body.lockVersion));
      return;
    }

    const match = pathname.match(/^\/admin\/api\/users\/([^/]+)\/(rotate|revoke)$/);
    if (request.method === "POST" && match) {
      const userId = decodeURIComponent(match[1] ?? "");
      const action = match[2];
      sendJson(response, 200, action === "rotate" ? principalStore.rotate(userId) : principalStore.revoke(userId));
      return;
    }
    sendJson(response, 404, { error: "页面不存在" });
  } catch (error) {
    sendJson(response, error instanceof PrincipalConflictError ? 409 : 400, { error: error instanceof Error ? error.message : "操作失败" });
  }
}

/**
 * The backup page's API (#237). Instance administration, so the same check as the user
 * management page: an OpenProject administrator's session, and same-origin writes.
 * Backup and restore run as jobs; starting one answers at once and the page follows the
 * job through the state it reads.
 */
async function handleBackupApi(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  const access = await openProjectAdminAccess(request.headers.cookie, config.openProjectBaseUrl);
  if (access === "unauthenticated") {
    sendJson(response, 401, { error: "请先登录 Eva Project 管理员帐号" });
    return;
  }
  if (access === "forbidden") {
    sendJson(response, 403, { error: "需要 Eva Project 管理员权限" });
    return;
  }
  if (access === "unavailable") {
    sendJson(response, 503, { error: "暂时无法验证 Eva Project 管理员身份" });
    return;
  }
  if (request.method !== "GET" && !validMutationOrigin(request)) {
    sendJson(response, 403, { error: "请求来源无效" });
    return;
  }
  if (!backups) {
    sendJson(response, 503, { error: "这个实例没有配置备份" });
    return;
  }

  try {
    if (request.method === "GET" && pathname === "/backup/api/state") {
      sendJson(response, 200, await backups.overview());
      return;
    }
    if (request.method === "POST" && pathname === "/backup/api/settings") {
      sendJson(response, 200, await backups.saveSettings(await readJson(request)));
      return;
    }
    if (request.method === "POST" && pathname === "/backup/api/run") {
      sendJson(response, 202, { job: backups.startBackup() });
      return;
    }

    const match = pathname.match(/^\/backup\/api\/backups\/([^/]+)\/([^/]+)(?:\/(download|delete|restore))?$/);
    if (match) {
      const kind = decodeURIComponent(match[1] ?? "");
      const name = decodeURIComponent(match[2] ?? "");
      const action = match[3];
      if (request.method === "GET" && !action) {
        sendJson(response, 200, { backup: await backups.entry(kind, name) });
        return;
      }
      if (request.method === "GET" && action === "download") {
        await streamBackup(request, response, await backups.archiveSource(kind, name));
        return;
      }
      if (request.method === "POST" && action === "delete") {
        await backups.remove(kind, name);
        sendJson(response, 200, await backups.overview());
        return;
      }
      if (request.method === "POST" && action === "restore") {
        const body = await readJson(request);
        sendJson(response, 202, { job: await backups.startRestore(kind, name, body.confirm) });
        return;
      }
    }
    sendJson(response, 404, { error: "页面不存在" });
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = error instanceof BackupInputError ? 400
      : error instanceof BackupBusyError ? 409
      : error instanceof BackupNotFoundError ? 404
      : 500;
    sendJson(response, status, { error: error instanceof Error ? error.message : "操作失败" });
  }
}

/** One backup directory as a tar stream, built as it is sent. */
function streamBackup(
  request: IncomingMessage,
  response: ServerResponse,
  source: { parent: string; name: string }
): Promise<void> {
  return new Promise(resolve => {
    const child = spawn("tar", ["-cf", "-", "-C", source.parent, source.name], { stdio: ["ignore", "pipe", "ignore"] });
    response.writeHead(200, {
      "Content-Type": "application/x-tar",
      "Content-Disposition": `attachment; filename="eva-project-backup-${source.name}.tar"`,
      "Cache-Control": "no-store"
    });
    // The response is ended by tar's exit, not by its output running out: a failure
    // part-way must break the download rather than end it as if it were whole.
    child.stdout.pipe(response, { end: false });
    child.on("error", () => {
      response.destroy();
      resolve();
    });
    child.on("close", code => {
      if (code === 0) response.end(); else response.destroy();
      resolve();
    });
    request.on("close", () => {
      if (!response.writableEnded) child.kill();
    });
  });
}

const agentConnections = new AgentConnections();
async function handleAgentConnect(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  try {
    if (request.method === "POST" && pathname === "/agent-connect/start") {
      const body = await readJson(request);
      if (typeof body.client !== "string" || !["Codex", "Claude Code", "Generic Agent"].includes(body.client)) { sendJson(response, 400, { error: "Select a supported Agent connection mode." }); return; }
      const result = agentConnections.start(body.client);
      sendJson(response, 200, { ...result, verification_uri: `${config.openProjectPublicUrl}/agent-access?code=${result.user_code}` }); return;
    }
    if (request.method === "POST" && pathname === "/agent-connect/token") {
      const body = await readJson(request);
      if (typeof body.device_code !== "string" || !/^[a-f0-9]{64}$/.test(body.device_code)) { sendJson(response, 400, { status: "expired" }); return; }
      const result = agentConnections.poll(body.device_code, login => principalStore.findByOpenProjectLogin(login)?.token ?? null);
      sendJson(response, result.status === "pending" || result.status === "connected" ? 200 : 410, result); return;
    }
    const access = await principalFromSession(request);
    if ("error" in access) { sendJson(response, access.error.status, access.error.body); return; }
    if (request.method === "GET" && pathname === "/agent-connect/request") {
      const code = new URL(request.url!, "http://localhost").searchParams.get("code") ?? "";
      const pending = agentConnections.inspect(code);
      sendJson(response, pending ? 200 : 404, pending ? { ...pending, identity: { userId: access.principal.userId, displayName: access.principal.displayName } } : { error: "连接请求已过期，请重新发起。" }); return;
    }
    if (request.method === "POST" && ["/agent-connect/approve", "/agent-connect/deny"].includes(pathname)) {
      if (!validMutationOrigin(request)) { sendJson(response, 403, { error: "Invalid origin" }); return; }
      const body = await readJson(request), code = typeof body.code === "string" ? body.code : "";
      const ok = pathname.endsWith("/approve") ? agentConnections.approve(code, access.principal.openProjectLogin!) : agentConnections.deny(code);
      sendJson(response, ok ? 200 : 409, ok ? { ok: true } : { error: "连接请求已处理或过期。" }); return;
    }
    sendJson(response, 404, { error: "Not found" });
  } catch { sendJson(response, 400, { error: "无法处理连接请求，请稍后重试。" }); }
}

async function handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.url === "/healthz") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (!validateHost(request, response)) {
    return;
  }

  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  // The page these paths used to serve now lives inside OpenProject, with its chrome,
  // its menus and its theme. Only the JSON API below stays here. The redirect is kept
  // rather than dropped because the old address is in people's bookmarks and in the
  // deployment notes, and a 404 there would read as the feature being gone.
  if (request.method === "GET" && (pathname === "/admin" || pathname === "/admin/" ||
      pathname === "/admin/style.css" || pathname === "/admin/app.js")) {
    response.writeHead(302, {
      Location: `${config.openProjectPublicUrl}/mcp-tokens`,
      "Cache-Control": "no-store"
    });
    response.end();
    return;
  }
  if (pathname.startsWith("/agent-connect/")) { await handleAgentConnect(request, response, pathname); return; }
  if (pathname.startsWith("/admin/api/")) {
    void handleAdminApi(request, response, pathname);
    return;
  }
  if (pathname.startsWith("/requirements/api/")) {
    void handleRequirementsApi(request, response, pathname);
    return;
  }

  if (pathname.startsWith("/handoff/api/")) {
    void handleHandoffApi(request, response, pathname);
    return;
  }
  if (pathname.startsWith("/backup/api/")) {
    void handleBackupApi(request, response, pathname);
    return;
  }
  if (pathname !== "/mcp") {
    response.writeHead(404).end();
    return;
  }

  const principal = principalStore.authenticate(request.headers.authorization);
  if (!principal) {
    response.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": "Bearer"
    });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  (request as typeof request & { auth?: AuthInfo }).auth = {
    token: principal.token,
    clientId: principal.userId,
    scopes: [principal.role === "admin" ? "requirements:admin" : "requirements:user"],
    extra: {
      userId: principal.userId,
      displayName: principal.displayName,
      role: principal.role,
      ...(principal.openProjectLogin !== undefined ? { openProjectLogin: principal.openProjectLogin } : {}),
      // Which agent is calling, from the User-Agent every MCP client sends.
      via: channelFromRequest(request.headers["user-agent"], typeof request.headers["x-eva-agent"] === "string" ? request.headers["x-eva-agent"] : undefined)
    }
  };
  await mcpEndpoint.handle(request, response);
}

const httpServer = createServer((request, response) => {
  void handleHttpRequest(request, response);
});

httpServer.listen(config.port, "0.0.0.0", () => {
  process.stdout.write(`Eva-Project MCP listening on ${config.port}\n`);
});

if (backups) {
  void backups.start().catch(error => {
    process.stderr.write(`backup service did not start: ${error instanceof Error ? error.message : String(error)}\n`);
  });
}

async function shutdown(): Promise<void> {
  backups?.stop();
  httpServer.close();
  await mcpEndpoint.close();
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
