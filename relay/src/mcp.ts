// Streamable HTTP MCP endpoint at /<id>/mcp, stateless: every POST carries JSON-RPC and gets a
// JSON response. The tool list (tools.ts) is fixed, so apps always see it; calls go through the
// BridgeHub to the chat they name, and can wait up to just under the app's 240 s limit.

import { errorResult, type BridgeHub } from "./hub";
import { validateAccessToken } from "./oauth";
import { INSTRUCTIONS, LONG_TIMEOUT_MS, LONG_TOOLS, SHORT_TIMEOUT_MS, TOOLS } from "./tools";
import { json } from "./util";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export async function handleMcp(req: Request, env: Env, id: string, origin: string): Promise<Response> {
  const auth = req.headers.get("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const granted = token ? await validateAccessToken(env, token) : null;
  if (granted !== id) {
    const challenge = [`resource_metadata="${origin}/.well-known/oauth-protected-resource/${id}/mcp"`, `scope="mcp"`];
    if (token) challenge.unshift(`error="invalid_token"`);
    return json({ error: "unauthorized", error_description: "Connect this server from your MCP client to sign in." }, 401, {
      "WWW-Authenticate": `Bearer ${challenge.join(", ")}`,
    });
  }
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const messages = (Array.isArray(body) ? body : [body]) as RpcRequest[];
  const requests = messages.filter((m) => m && typeof m.method === "string" && m.id !== undefined && m.id !== null);

  const version = req.headers.get("MCP-Protocol-Version");
  if (version && !SUPPORTED_VERSIONS.includes(version) && !requests.some((r) => r.method === "initialize")) {
    return new Response(null, { status: 400 });
  }
  if (requests.length === 0) return new Response(null, { status: 202 });

  const hub = env.HUBS.get(env.HUBS.idFromName(id));
  const pictureBase = `${origin}/p/${id}`;
  const responses = await Promise.all(requests.map((r) => handleRequest(r, hub, pictureBase, id)));
  return json(Array.isArray(body) ? responses : responses[0], 200, { "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id" });
}

/** The server's version, from what the app sees: it changes whenever the tools or the
 * instructions do, so apps that cache the tool list know to fetch it again. */
let versionCache: string | undefined;
async function serverVersion(): Promise<string> {
  if (!versionCache) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ TOOLS, INSTRUCTIONS })));
    versionCache = `1.6.0+${[...new Uint8Array(digest)].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
  return versionCache;
}

async function handleRequest(msg: RpcRequest, hub: DurableObjectStub<BridgeHub>, pictureBase: string, id: string) {
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion as string | undefined;
      // What a client asks for, never what it sends in calls: to see which apps refresh the tool list.
      console.log(JSON.stringify({ rpc: "initialize", protocolVersion: requested, client: msg.params?.clientInfo }));
      return ok({
        protocolVersion: requested && SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "claude-bridge", title: "Claude Bridge", version: await serverVersion() },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      console.log(JSON.stringify({ rpc: "tools/list", version: await serverVersion() }));
      return ok({ tools: TOOLS });
    case "tools/call": {
      const tool = msg.params?.name;
      if (typeof tool !== "string") return fail(-32602, "params.name is required");
      if (!TOOLS.some((t) => t.name === tool)) return ok(errorResult(`Unknown tool ${tool}. Call list_sessions to see what is open.`));
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      console.log(JSON.stringify({ rpc: "tools/call", tool }));
      // Paused from the computer: every call is refused, and only the computer can resume it.
      if (await hub.isPaused()) {
        return ok(
          errorResult(
            "Claude Bridge is paused on the person's computer, so nothing can be read, sent, started or opened. Tell the person; they turn it back on with the Bridge dot below the prompt in any Claude Code session (it can't be turned on from here).",
          ),
        );
      }
      const timeout = LONG_TOOLS.has(tool) ? LONG_TIMEOUT_MS : SHORT_TIMEOUT_MS;
      switch (tool) {
        case "list_sessions":
          return ok(await hub.listSessions(pictureBase));
        case "list_projects":
          return ok(await hub.listProjects(args.device, pictureBase));
        case "start_session":
          return ok(await hub.startSession(args, timeout, pictureBase));
        case "resume_session":
          return ok(await hub.resumeSession(args, pictureBase));
        case "fork_session":
          return ok(await hub.forkSession(args, timeout, pictureBase));
        case "rename_session":
          return ok(await hub.renameSession(args, pictureBase));
        case "link_computer":
          return ok(await hub.linkComputer(args.code, args.name, id));
        case "rename_device":
          return ok(await hub.renameDevice(args));
        case "watch_sessions":
          return ok(await hub.watchSessions(args.sessions, args.mode));
        case "wait_for_updates":
          return ok(await hub.waitForUpdates(args.seconds, pictureBase));
        case "show_screen":
          return ok(await hub.showScreen(args, pictureBase));
        default:
          return ok(await hub.call(tool, args, timeout, pictureBase));
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}
