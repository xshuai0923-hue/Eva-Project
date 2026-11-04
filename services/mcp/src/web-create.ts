import { createHash } from "node:crypto";
import * as z from "zod/v4";
import type { CreateRequirementInput } from "./service.js";
import type { SaveHandoffInput } from "./handoff-service.js";
import type { Principal } from "./types.js";
import { RequirementValidationError } from "./record-service.js";

const common = {
  requestId: z.uuid(),
  title: z.string().trim().min(1, "请填写标题").max(255),
  visibility: z.enum(["公开", "私有"]).default("私有")
};
export const webRequirementSchema = z.object({
  ...common,
  rawText: z.string().trim().min(1, "请填写需求说明").max(100000),
  typeId: z.number().int().positive().optional(),
  parent: z.number().int().positive().optional(),
  responsibleAgent: z.string().optional(),
  priority: z.string().trim().min(1).max(100).default("普通"),
  acceptanceCriteria: z.string().max(20000).default("")
}).strict();
export const webHandoffSchema = z.object({
  ...common,
  sections: z.object({
    背景: z.string().max(20000).default(""),
    主线: z.string().max(20000).default(""),
    现状: z.string().max(20000).default(""),
    注意事项: z.string().max(20000).default("")
  }),
  todos: z.array(z.union([
    z.string().trim().min(1).max(2000),
    z.object({ text: z.string().trim().min(1).max(2000), requirement: z.number().int().positive().optional() }).strict()
  ])).max(100).default([]),
  previous: z.string().trim().min(1).max(255).optional(),
  supersede: z.boolean().default(false)
}).strict();

// Stable across retries and process restarts, scoped to the authenticated person.
function recordId(kind: string, principal: Principal, requestId: string): string {
  const owner = createHash("sha256").update(principal.userId).digest("hex").slice(0, 16);
  return `EVA-${kind}-${owner}-${requestId}`;
}

export function webRequirement(project: string, raw: unknown, principal: Principal): CreateRequirementInput {
  const body = webRequirementSchema.parse(raw);
  const now = new Date().toISOString();
  return {
    project, id: recordId("REQ", principal, body.requestId),
    title: body.title, rawText: body.rawText, priority: body.priority,
    acceptanceCriteria: body.acceptanceCriteria, visibility: body.visibility, requestId: body.requestId,
    ...(body.parent === undefined ? {} : { parent: body.parent }),
    ...(body.typeId === undefined ? {} : { typeId: body.typeId }),
    agentUnderstanding: "", modules: [], responsibleAgent: body.responsibleAgent ?? "待确认",
    intakeStatus: "待确认", state: "待认领", requesterType: "人",
    requesterId: principal.userId, requesterName: principal.displayName,
    recordedAt: now, proposedAt: now, proposedTimePrecision: "timestamp",
    sourceLabel: "网页新建", requiredForParent: body.parent !== undefined
  };
}

export function webHandoff(project: string, raw: unknown, principal: Principal): SaveHandoffInput {
  const body = webHandoffSchema.parse(raw);
  const id = recordId("HANDOFF", principal, body.requestId);
  return {
    project, id, title: body.title, thread: id, visibility: body.visibility,
    sections: {
      ...body.sections,
      待办: body.todos.map((todo, i) => {
        const text = typeof todo === "string" ? todo : todo.text;
        const reference = typeof todo === "string" ? undefined : todo.requirement;
        return `- [ ] (todo-${i + 1}) ${text.replace(/[\r\n]+/g, " ")}${reference ? ` · 需求:${reference}` : ""}`;
      }).join("\n")
    },
    repository: "", branch: "", baseCommit: "", sourceSessionId: "",
    requestId: body.requestId, modules: [], expectedAgent: "不限",
    ...(body.previous ? { previous: body.previous } : {}), supersede: body.supersede
  };
}

/** Authorize associations before the caller performs the first write. */
export async function prepareWebHandoff(project: string, raw: unknown, principal: Principal, readers: {
  requirement(reference: number): Promise<unknown>;
  handoff(reference: string): Promise<{ thread: string | null }>;
}): Promise<SaveHandoffInput> {
  const input = webHandoff(project, raw, principal);
  input.sourceSessionId = `web:${principal.userId}`;
  const references = new Set([...(input.sections.待办 ?? "").matchAll(/· 需求:(\d+)(?=\s|$|·)/g)].map(match => Number(match[1])));
  for (const reference of references) await readers.requirement(reference);
  if (input.previous) {
    const previous = await readers.handoff(input.previous);
    if (!previous.thread) throw new RequirementValidationError("上一份交接缺少工作线，请先核对记录");
    input.thread = previous.thread;
  }
  return input;
}
