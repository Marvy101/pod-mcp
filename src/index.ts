#!/usr/bin/env node
/**
 * Pod as a local MCP server.
 *
 * Pod is a hosted service, so this package is deliberately a proxy rather than a
 * reimplementation: it forwards `tools/list` and `tools/call` to the public
 * endpoint. Copying the tool schemas into this repository would mean they drift
 * out of date the moment Pod ships a change, and every consumer would be pinned
 * to whatever the schemas looked like on the day they installed.
 *
 * The default endpoint is anonymous and needs no key. Point POD_MCP_URL at the
 * authenticated endpoint, and set POD_MCP_TOKEN, to also get `write` and `edit`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const NAME = "pod";
const VERSION = "0.1.0";
const DEFAULT_ENDPOINT = "https://api.askpod.ai/mcp/read";

function endpoint(): URL {
  const raw = process.env.POD_MCP_URL ?? DEFAULT_ENDPOINT;
  try {
    return new URL(raw);
  } catch {
    throw new Error(`POD_MCP_URL is not a valid URL: ${raw}`);
  }
}

function requestInit(): RequestInit {
  const token = process.env.POD_MCP_TOKEN;
  return token ? { headers: { Authorization: `Bearer ${token}` } } : {};
}

async function main(): Promise<void> {
  const upstream = new Client({ name: "pod-mcp", version: VERSION });
  await upstream.connect(
    new StreamableHTTPClientTransport(endpoint(), { requestInit: requestInit() }),
  );

  const server = new Server({ name: NAME, version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: (await upstream.listTools()).tools };
  });

  // Errors are returned to the caller rather than thrown, so a failed upstream
  // call surfaces as a tool result the agent can read and retry, not as a
  // transport fault that tears down the session.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await upstream.callTool(request.params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, content: [{ type: "text" as const, text: `Pod request failed: ${message}` }] };
    }
  });

  const closeBoth = async () => {
    await Promise.allSettled([server.close(), upstream.close()]);
    process.exit(0);
  };
  process.on("SIGINT", closeBoth);
  process.on("SIGTERM", closeBoth);

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // stdout carries the protocol, so diagnostics must go to stderr.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
