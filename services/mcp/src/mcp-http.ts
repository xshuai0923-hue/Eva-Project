import type { IncomingMessage, ServerResponse } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";

// A 20 MiB attachment takes about 27 MiB as Base64 inside JSON. Bound the
// complete HTTP body without reducing that existing upload contract.
export const MCP_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 10_000;

/** Authentication happens before this endpoint. A transport and a server must
 * belong to just one HTTP request: clients routinely reuse JSON-RPC ids. */
export class McpHttpEndpoint {
  private readonly active = new Set<() => Promise<void>>();

  constructor(
    private readonly buildServer: () => McpServer,
    private readonly maxRequestBodySize = MCP_MAX_REQUEST_BYTES
  ) {}

  async handle(request: IncomingMessage & { auth?: AuthInfo }, response: ServerResponse): Promise<void> {
    const server = this.buildServer();
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: this.maxRequestBodySize
    });
    let connected = false;
    let closeRequested = false;
    let closing: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      closeRequested = true;
      // A disconnect during connect must also close the transport once connect
      // settles, rather than letting it be reattached after an early close.
      if (!connected) return Promise.resolve();
      return closing ??= Promise.allSettled([server.close(), transport.close()]).then(() => {
        this.active.delete(dispose);
        response.off("close", onClose);
      });
    };
    const onClose = () => { void dispose(); };
    this.active.add(dispose);
    response.once("close", onClose);
    try {
      await server.connect(transport);
      connected = true;
      if (closeRequested || response.destroyed) return;
      await transport.handleRequest(request, response);
    } catch {
      connected = true;
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "MCP request failed" } }));
      } else if (!response.writableEnded) {
        response.destroy();
      }
    } finally {
      if (closeRequested || response.writableEnded || response.destroyed) await dispose();
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.active].map(dispose => dispose()));
  }
}
