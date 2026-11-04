import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { McpHttpEndpoint, MCP_MAX_REQUEST_BYTES, MCP_MAX_TOOL_INPUT_ELEMENTS } from "./mcp-http.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function fixture(maxRequestBodySize = MCP_MAX_REQUEST_BYTES) {
  const instances: McpServer[] = [];
  const closed: number[] = [];
  const executed = vi.fn();
  const endpoint = new McpHttpEndpoint(() => {
    const instance = new McpServer({ name: "isolation-test", version: "1.0" }, {
      maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS
    });
    const index = instances.push(instance) - 1;
    const close = instance.close.bind(instance);
    instance.close = async () => { closed.push(index); await close(); };
    instance.registerTool("probe", {
      inputSchema: z.object({ marker: z.string(), delay: z.number().min(0).max(100).default(0) })
    }, async ({ marker, delay }, context) => {
      await new Promise(resolve => setTimeout(resolve, delay));
      return { content: [{ type: "text", text: JSON.stringify({ marker, user: context.http?.authInfo?.extra?.userId }) }] };
    });
    instance.registerTool("collection", { inputSchema: z.object({ items: z.array(z.unknown()) }) }, ({ items }) => {
      executed();
      return { content: [{ type: "text", text: String(items.length) }] };
    });
    instance.registerTool("attachment_probe", { inputSchema: z.object({ content: z.string() }) }, ({ content }) => ({
      content: [{ type: "text", text: String(Buffer.from(content, "base64").length) }]
    }));
    return instance;
  }, maxRequestBodySize);
  const http = createServer((req, res) => {
    const user = req.headers.authorization?.replace(/^Bearer /, "");
    if (user !== "alice" && user !== "bob") { res.writeHead(401).end(); return; }
    (req as IncomingMessage & { auth?: AuthInfo }).auth = {
      token: user, clientId: user, scopes: [], extra: { userId: user }
    };
    void endpoint.handle(req, res);
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  cleanups.push(async () => {
    await endpoint.close();
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${address.port}/mcp`, instances, closed, executed };
}

const headers = (user = "alice") => ({
  Authorization: `Bearer ${user}`, "Content-Type": "application/json",
  Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25"
});
const message = (name: string, args: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const post = (url: string, body: unknown, user = "alice") => fetch(url, {
  method: "POST", headers: headers(user), body: JSON.stringify(body), signal: AbortSignal.timeout(10_000)
});

describe("MCP HTTP request isolation and input limits", () => {
  it("keeps overlapping requests with identical RPC ids and different users separate", async () => {
    const f = await fixture();
    const jobs = Array.from({ length: 30 }, (_, index) => ({
      user: index % 2 ? "alice" : "bob", marker: `request-${index}`, delay: index % 3 * 10
    }));
    await Promise.all(jobs.map(async job => {
      const response = await post(f.url, message("probe", { marker: job.marker, delay: job.delay }), job.user);
      expect(response.status).toBe(200);
      const reply = await response.json();
      expect(reply.id).toBe(1);
      expect(JSON.parse(reply.result.content[0].text)).toEqual({ user: job.user, marker: job.marker });
    }));
    expect(f.instances).toHaveLength(jobs.length);
    await vi.waitFor(() => expect(new Set(f.closed).size).toBe(jobs.length));
  });

  it("supports initialize and subsequent stateless requests without sharing a server", async () => {
    const f = await fixture();
    const init = await post(f.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1.0" }
    } });
    expect((await init.json()).result.serverInfo.name).toBe("isolation-test");
    for (let i = 0; i < 3; i++) {
      const response = await post(f.url, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      expect((await response.json()).result.tools).toHaveLength(3);
    }
    await vi.waitFor(() => expect(new Set(f.closed).size).toBe(4));
  });

  it("rejects excessive tool input before executing the handler and remains available", async () => {
    const f = await fixture();
    const response = await post(f.url, message("collection", { items: Array(MCP_MAX_TOOL_INPUT_ELEMENTS + 1).fill(0) }));
    const result = (await response.json()).result;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("maximum");
    expect(f.executed).not.toHaveBeenCalled();
    const valid = await post(f.url, message("collection", { items: [1, 2, 3] }));
    expect((await valid.json()).result.content[0].text).toBe("3");
    expect(f.executed).toHaveBeenCalledOnce();
  });

  it("rejects batches over the SDK limit before tool execution", async () => {
    const f = await fixture();
    const response = await post(f.url, Array.from({ length: 101 }, (_, id) => ({ ...message("collection", { items: [] }), id })));
    expect(response.status).toBe(400);
    expect(f.executed).not.toHaveBeenCalled();
  });

  it("rejects both declared and chunked oversized bodies", async () => {
    const f = await fixture(1024);
    for (const declared of [true, false]) {
      const status = await new Promise<number>(resolve => {
        const req = httpRequest(f.url, { method: "POST", headers: {
          ...headers(), ...(declared ? { "Content-Length": "2048" } : {})
        } }, res => { res.resume(); resolve(res.statusCode!); });
        req.setTimeout(5000, () => req.destroy(new Error("Request timed out")));
        req.on("error", () => resolve(0));
        req.write(" ".repeat(1024));
        req.end(" ".repeat(1024));
      });
      expect(status).toBe(413);
    }
    expect(f.executed).not.toHaveBeenCalled();
  });

  it("keeps the existing 20 MiB binary attachment size within the HTTP bound", async () => {
    const f = await fixture();
    const bytes = 20 * 1024 * 1024;
    const response = await post(f.url, message("attachment_probe", { content: Buffer.alloc(bytes).toString("base64") }));
    expect(response.status).toBe(200);
    expect((await response.json()).result.content[0].text).toBe(String(bytes));
  });

  it("closes request resources after a client disconnect", async () => {
    const f = await fixture();
    const abort = new AbortController();
    const pending = fetch(f.url, { method: "POST", headers: headers(),
      body: JSON.stringify(message("probe", { marker: "aborted", delay: 100 })), signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.instances).toHaveLength(1));
    abort.abort();
    await rejected;
    await vi.waitFor(() => expect(new Set(f.closed).size).toBe(1));
    const next = await post(f.url, message("probe", { marker: "still-alive" }), "bob");
    expect(JSON.parse((await next.json()).result.content[0].text)).toEqual({ user: "bob", marker: "still-alive" });
  });

  it("rejects unauthenticated requests before constructing MCP objects", async () => {
    const f = await fixture();
    expect((await post(f.url, message("probe", { marker: "no-access" }), "invalid")).status).toBe(401);
    expect(f.instances).toHaveLength(0);
  });
});
