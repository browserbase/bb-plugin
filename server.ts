import type {
  BbPluginApi,
  PluginAgentToolContext,
  PluginAgentToolResult,
} from "@get-bb/plugin-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

type Connection = Pick<Client, "callTool" | "close">;
type Connector = (key: string, signal: AbortSignal) => Promise<Connection>;
type Session = { client: Connection; key: string; id?: string };
type ToolName = "start" | "navigate" | "observe" | "act" | "extract" | "end";
const OUTPUT_LIMIT = 48_000;

function reply(text: string, isError = false): PluginAgentToolResult {
  return { content: [{ type: "text", text }], isError };
}

function jsonParts(result: CallToolResult): unknown[] {
  const values: unknown[] = [result.structuredContent];
  for (const part of result.content) {
    if (part.type !== "text") continue;
    try { values.push(JSON.parse(part.text)); } catch { /* Plain text is valid. */ }
  }
  return values;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function failed(result: CallToolResult): boolean {
  return result.isError === true || jsonParts(result).some((value) => record(value)?.success === false);
}

function sessionId(result: CallToolResult): string | undefined {
  for (const value of jsonParts(result)) {
    const object = record(value);
    const id = object?.sessionId ?? record(object?.data)?.sessionId;
    if (typeof id === "string" && id.length > 0 && id.length < 256) return id;
  }
}

function formatResult(result: CallToolResult, key: string): PluginAgentToolResult {
  const parts = result.content.map((part) => part.type === "text"
    ? part.text : `[Browserbase returned ${part.type} content; this plugin returns text only.]`);
  if (result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  let text = parts.join("\n") || "Browserbase returned no text.";
  // The hosted server authenticates in its URL. Never echo the user's key.
  for (const secret of [key, encodeURIComponent(key), new URLSearchParams({ k: key }).toString().slice(2)]) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  if (text.length > OUTPUT_LIMIT) text = text.slice(0, OUTPUT_LIMIT) + "\n[Output truncated. Request a smaller extraction.]";
  return reply(text, failed(result));
}

async function connectHosted(key: string, signal: AbortSignal): Promise<Connection> {
  const url = new URL("https://mcp.browserbase.com/mcp");
  url.searchParams.set("browserbaseApiKey", key);
  const client = new Client({ name: "bb-plugin-browserbase", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(url);
  // Protocol/transport errors may contain a credential-bearing URL.
  client.onerror = () => {};
  try {
    await client.connect(transport, { signal, timeout: 15_000 });
    signal.throwIfAborted();
    return client;
  } catch {
    await client.close().catch(() => {});
    throw new Error("Browserbase connection failed. Check the API key, account access, and network.");
  }
}

// The connector argument permits isolated tests without creating paid sessions.
export function createBrowserbasePlugin(connect: Connector = connectHosted) {
  return function browserbase(bb: BbPluginApi) {
    const settings = bb.settings.define({
      apiKey: { type: "string", label: "Browserbase API key", secret: true },
    });
    const sessions = new Map<string, Session>();
    const queues = new Map<string, Promise<void>>();
    const lifecycle = new AbortController();

    // Serialize calls within one thread; separate threads use separate clients.
    async function serialized<T>(threadId: string, run: () => Promise<T>): Promise<T> {
      const previous = queues.get(threadId) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const tail = previous.then(() => gate);
      queues.set(threadId, tail);
      await previous;
      try { return await run(); }
      finally {
        release();
        if (queues.get(threadId) === tail) queues.delete(threadId);
      }
    }

    async function cleanup(threadId: string, state: Session): Promise<void> {
      if (sessions.get(threadId) === state) sessions.delete(threadId);
      try {
        const result = await state.client.callTool({
          name: "end", arguments: state.id ? { sessionId: state.id } : {},
        }, CallToolResultSchema, { timeout: 3_000, signal: AbortSignal.timeout(3_000) });
        if (result.isError || ("content" in result && failed(result as CallToolResult))) {
          bb.log.warn("Browserbase session cleanup failed; check Sessions in the Browserbase dashboard.");
        }
      } catch {
        bb.log.warn("Browserbase session cleanup could not be confirmed; check Sessions in the Browserbase dashboard.");
      } finally { await state.client.close().catch(() => {}); }
    }

    async function execute(name: ToolName, args: Record<string, unknown>, ctx: PluginAgentToolContext): Promise<PluginAgentToolResult> {
      return serialized(ctx.threadId, async () => {
        const signal = AbortSignal.any([ctx.signal, lifecycle.signal]);
        let state = sessions.get(ctx.threadId);
        try {
          signal.throwIfAborted();
          const key = (await settings.get()).apiKey?.trim();
          signal.throwIfAborted();
          if (name === "end" && !state) return reply("This thread has no browser session.");
          if (name !== "end" && !key) return reply("Set the Browserbase API key in Settings → Installed plugins → Browserbase.", true);
          if (name !== "end" && state && state.key !== key) {
            return reply("The API key changed. Call browserbase_end, then browserbase_start to use the new key.", true);
          }
          if (name === "start" && state?.id) return reply(JSON.stringify({ sessionId: state.id, reused: true }));
          if (name === "start" && !state) {
            const client = await connect(key!, signal);
            if (signal.aborted) { await client.close(); signal.throwIfAborted(); }
            state = { client, key: key! };
            sessions.set(ctx.threadId, state);
          }
          if (!state) return reply("Call browserbase_start before using the browser.", true);
          if (name !== "start" && name !== "end" && !state.id) {
            return reply("The browser session was not confirmed. Call browserbase_end before starting a replacement.", true);
          }
          const result = CallToolResultSchema.parse(await state.client.callTool({
            name, arguments: { ...args, ...(state.id ? { sessionId: state.id } : {}) },
          }, CallToolResultSchema, { signal, timeout: 60_000 }));
          if (name === "start" && !failed(result)) {
            state.id = sessionId(result);
            if (!state.id) {
              await cleanup(ctx.threadId, state);
              return reply("Browserbase did not return a recognized session ID. Cleanup was attempted; check the Browserbase dashboard before retrying.", true);
            }
          }
          const output = formatResult(result, state.key);
          if (name === "end" && !failed(result)) {
            sessions.delete(ctx.threadId);
            await state.client.close().catch(() => {});
          }
          return output;
        } catch {
          // Do not log raw MCP errors: they can include the authenticated URL.
          if (name === "start" && state) await cleanup(ctx.threadId, state);
          return reply(signal.aborted
            ? "Browserbase call cancelled. The remote action may have completed; inspect the page before retrying."
            : "Browserbase call failed or timed out. Check the API key, account, and network. An action may have completed: inspect before retrying; do not repeat submissions blindly.", true);
        }
      });
    }

    function register<S extends z.ZodType<Record<string, unknown>>>(name: ToolName, description: string, parameters: S) {
      bb.agents.registerTool({
        name: `browserbase_${name}`, description, parameters,
        execute: (args, ctx) => execute(name, args, ctx),
      });
    }
    const instruction = z.string().trim().min(1).max(12_000);
    register("start", "Create or reuse the browser session owned by this BB thread.", z.object({}).strict());
    register("navigate", "Navigate this thread's browser to an HTTP or HTTPS URL.", z.object({
      url: z.url().max(8_192).refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "Use an HTTP or HTTPS URL."),
    }).strict());
    register("observe", "Find actionable controls on the current page.", z.object({ instruction }).strict());
    register("act", "Perform one authorized action on the current page. Inspect afterward to verify the result.", z.object({ action: instruction }).strict());
    register("extract", "Extract text or structured data from the current page.", z.object({ instruction: instruction.optional() }).strict());
    register("end", "Close this thread's browser session when finished.", z.object({}).strict());

    for (const event of ["thread.archived", "thread.deleted"] as const) {
      bb.events.on(event, async ({ thread }) => {
        await serialized(thread.id, async () => {
          const state = sessions.get(thread.id);
          if (state) await cleanup(thread.id, state);
        });
      });
    }
    bb.onDispose(async () => {
      lifecycle.abort();
      await Promise.allSettled([...sessions].map(([id, state]) => cleanup(id, state)));
    });
  };
}

export default createBrowserbasePlugin();
