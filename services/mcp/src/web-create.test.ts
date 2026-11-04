import { describe, expect, it } from "vitest";
import { webRequirement, webHandoff, prepareWebHandoff } from "./web-create.js";
import type { Principal } from "./types.js";

const alice: Principal = { userId: "alice", displayName: "Alice", role: "user" };
const requestId = "273d5914-5e75-4c96-85af-bab19f2fe880";
describe("web creation", () => {
  it("authorizes associated requirements and derives an existing thread without trusting client identity", async () => {
    const reads: Array<string | number> = [];
    const value = await prepareWebHandoff("eva-project", {
      requestId, title: "handoff", sections: {}, previous: "HO-1", todos: [
        { text: "finish", requirement: 38 }, { text: "verify", requirement: 38 }, { text: "investigate" }
      ]
    }, alice, {
      requirement: async reference => { reads.push(reference); },
      handoff: async reference => { reads.push(reference); return { thread: "REQ-38" }; }
    });
    expect(reads).toEqual([38, "HO-1"]);
    expect(value.thread).toBe("REQ-38");
    expect(value.sourceSessionId).toBe("web:alice");
    expect(value.supersede).toBe(false);
    expect(value.sections.待办).toContain("· 需求:38");
    expect(value.repository).toBe("");
  });
  it("refuses an unreadable association and refuses a predecessor without a thread", async () => {
    const body = { requestId, title: "handoff", sections: {}, previous: "HO-1", todos: [{ text: "work", requirement: 38 }] };
    let predecessorReads = 0;
    await expect(prepareWebHandoff("eva-project", body, alice, {
      requirement: async () => { throw new Error("not found"); },
      handoff: async () => { predecessorReads++; return { thread: "secret" }; }
    })).rejects.toThrow("not found");
    expect(predecessorReads).toBe(0);
    await expect(prepareWebHandoff("eva-project", { ...body, todos: [] }, alice, {
      requirement: async () => {}, handoff: async () => ({ thread: null })
    })).rejects.toThrow("工作线");
  });
  it("does not accept fabricated identity, thread or code baseline from a web form", () => {
    for (const extra of [{ ownerUserId: "bob" }, { sourceSessionId: "other" }, { thread: "other" }, { baseCommit: "a".repeat(40) }]) {
      expect(() => webHandoff("eva-project", { requestId, title: "handoff", sections: {}, ...extra }, alice)).toThrow();
    }
  });
  it("binds owner identity and safe defaults with a stable retry identifier", () => {
    const body = { requestId, title: " Title ", rawText: "original" };
    const first = webRequirement("eva-project", body, alice);
    expect(first.visibility).toBe("私有");
    expect(first.state).toBe("待认领");
    expect(first.requesterId).toBe("alice");
    expect(first.agentUnderstanding).toBe("");
    expect(first.title).toBe("Title");
    expect(webRequirement("eva-project", body, alice).id).toBe(first.id);
    expect(webRequirement("eva-project", body, { ...alice, userId: "bob" }).id).not.toBe(first.id);
  });
  it("rejects blank titles and client supplied ownership", () => {
    expect(() => webRequirement("eva-project", { requestId, title: " ", rawText: "a" }, alice)).toThrow();
    expect(() => webRequirement("eva-project", { requestId, title: "a", rawText: "a", ownerUserId: "bob" }, alice)).toThrow();
  });
  it("serializes handoff sections and ordinary todo text through the existing format", () => {
    const result = webHandoff("eva-project", {
      requestId, title: "handoff", sections: { 背景: "context", 现状: "ready" }, todos: ["check #38", "review"]
    }, alice);
    expect(result.sections.背景).toBe("context");
    expect(result.sections.待办).toBe("- [ ] (todo-1) check #38\n- [ ] (todo-2) review");
    expect(result.sourceSessionId).toBe("");
  });
});
