import { describe, expect, it } from "vitest";

import { channelFromRequest, channelFromUserAgent, parseSignature, signed } from "./signature.js";

describe("telling the agents apart", () => {
  // What each client actually sent on every request, measured 2026-09-23.
  it("recognises Claude Code and Codex by the User-Agent they send", () => {
    expect(channelFromUserAgent("claude-code/2.1.272 (claude-desktop, agent-sdk/0.3.280)")).toBe("Claude");
    expect(channelFromUserAgent("codex-mcp-client/0.155.0-alpha.9.2")).toBe("Codex");
  });

  it("names an unrecognised client by what it calls itself rather than guessing", () => {
    expect(channelFromUserAgent("python-httpx/0.28.1")).toBe("python-httpx");
  });

  it("says so when a client gives no name at all", () => {
    expect(channelFromUserAgent(undefined)).toBe("未知 Agent");
    expect(channelFromUserAgent("   ")).toBe("未知 Agent");
  });

  it.each([
    ["codex-mcp-client", "Codex"],
    ["claude-code", "Claude"],
    ["Mila-Agent", "Mila"],
    ["custom-agent", "custom-agent"]
  ])("preserves %s through old and current bridges", (client, channel) => {
    expect(channelFromUserAgent(`EvaProjectPlugin/0.1.3 ${client}`)).toBe(channel);
    expect(channelFromUserAgent(`${client}/1.0 EvaProjectPlugin/0.1.4`)).toBe(channel);
  });

  it("does not infer an agent from unrelated suffixes or missing bridge identity", () => {
    expect(channelFromUserAgent("python-httpx/1.0 codex-helper")).toBe("python-httpx");
    expect(channelFromUserAgent("EvaProjectPlugin/0.1.4")).toBe("未知 Agent");
    expect(channelFromUserAgent("EvaProjectPlugin/0.1.3 client")).toBe("未知 Agent");
    expect(channelFromUserAgent("EvaProjectPlugin/0.1.3 WorkBuddy Desktop")).toBe("WorkBuddy Desktop");
  });

  it.each(["Qoder", "WorkBuddy", "Future Agent", "自定义助手", "similar-agent"])("preserves arbitrary declared names: %s", name => {
    expect(channelFromRequest("EvaProjectPlugin/0.1.4", encodeURIComponent(name))).toBe(name);
    expect(parseSignature(signed("updated", "alice", name)).channel).toBe(name);
  });

  it("rejects malformed or multiline labels and falls back to the real header", () => {
    expect(channelFromRequest("codex-mcp-client/1", "%invalid")).toBe("Codex");
    expect(channelFromRequest("python-httpx/1", encodeURIComponent("Claude\nother"))).toBe("python-httpx");
    expect(channelFromUserAgent("similar-agent/1")).toBe("similar-agent");
  });
});

describe("the signature on a note", () => {
  it("goes last, after a blank line, and comes back off whole", () => {
    const note = signed("- 2026-09-23：状态更新为「进行中」。\n\n第二段", "brian", "Claude");

    expect(note).toBe("- 2026-09-23：状态更新为「进行中」。\n\n第二段\n\n— 署名：brian · Claude");
    expect(parseSignature(note)).toEqual({
      text: "- 2026-09-23：状态更新为「进行中」。\n\n第二段",
      userId: "brian",
      channel: "Claude"
    });
  });

  it("can be the whole note, for a change that came with no reason", () => {
    expect(parseSignature(signed("", "brian", "网页"))).toEqual({ text: "", userId: "brian", channel: "网页" });
  });

  it("leaves a note written before signing began exactly as it was", () => {
    expect(parseSignature("留言\n— Brian")).toEqual({ text: "留言\n— Brian", userId: null, channel: null });
  });

  it("only counts on the last line, so a quoted signature inside a note stays text", () => {
    const raw = "上一条写着：\n— 署名：brian · Codex\n我补一句";
    expect(parseSignature(raw)).toEqual({ text: raw, userId: null, channel: null });
  });
});
