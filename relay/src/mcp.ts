// Streamable HTTP MCP endpoint at /<id>/mcp, stateless: every POST carries JSON-RPC and gets a
// JSON response. The tool list (tools.ts) is fixed, so apps always see it; calls go through the
// BridgeHub to the chat they name, and can wait up to just under the app's 240 s limit.

import { errorResult, type BridgeHub } from "./hub";
import { validateAccessToken } from "./oauth";
import { INSTRUCTIONS, LONG_TIMEOUT_MS, LONG_TOOLS, SHORT_TIMEOUT_MS, TOOLS } from "./tools";
import { json } from "./util";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/** `address` is the account id in an account's own connector URL (`/<id>/mcp`), or null at the
 * shared one (`/mcp`, the Claude app plugin's), where the signed-in account is whichever the token names. */
export async function handleMcp(req: Request, env: Env, address: string | null, origin: string): Promise<Response> {
  const auth = req.headers.get("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const granted = token ? await validateAccessToken(env, token) : null;
  if (!granted || (address !== null && granted !== address)) {
    const where = address ? `${address}/mcp` : "mcp";
    const challenge = [`resource_metadata="${origin}/.well-known/oauth-protected-resource/${where}"`, `scope="mcp"`];
    if (token) challenge.unshift(`error="invalid_token"`);
    return json({ error: "unauthorized", error_description: "Connect this server from your MCP client to sign in." }, 401, {
      "WWW-Authenticate": `Bearer ${challenge.join(", ")}`,
    });
  }
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const id = granted;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const messages = (Array.isArray(body) ? body : [body]) as RpcRequest[];
  const requests = messages.filter((m) => m && typeof m.method === "string" && m.id !== undefined && m.id !== null);
  // The app gave up on a call: a wait it was holding is dropped without marking news heard.
  for (const m of messages) {
    if (m?.method === "notifications/cancelled" && m.params?.requestId !== undefined) {
      await env.HUBS.get(env.HUBS.idFromName(id)).cancelWait(`${id}:${String(m.params.requestId)}`);
    }
  }

  const version = req.headers.get("MCP-Protocol-Version");
  if (version && !SUPPORTED_VERSIONS.includes(version) && !requests.some((r) => r.method === "initialize")) {
    return new Response(null, { status: 400 });
  }
  if (requests.length === 0) return new Response(null, { status: 202 });

  const hub = env.HUBS.get(env.HUBS.idFromName(id));
  const pictureBase = `${origin}/p/${id}`;
  // Each conversation gets its own MCP session id at initialize (the app sends it on every call
  // after), so the rule "read the person's instructions first" holds per conversation.
  const opening = requests.some((r) => r.method === "initialize");
  const sent = req.headers.get("Mcp-Session-Id");
  const conversation = opening ? crypto.randomUUID() : sent && /^[A-Za-z0-9-]{8,80}$/.test(sent) ? sent : null;
  const responses = await Promise.all(requests.map((r) => handleRequest(r, hub, pictureBase, id, req.signal, conversation)));
  return json(Array.isArray(body) ? responses : responses[0], 200, {
    "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
    ...(opening && conversation ? { "Mcp-Session-Id": conversation } : {}),
  });
}

/** The server's version, from what the app sees: it changes whenever the tools or the
 * instructions do, so apps that cache the tool list know to fetch it again. */
let versionCache: string | undefined;
async function serverVersion(): Promise<string> {
  if (!versionCache) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ TOOLS, INSTRUCTIONS })));
    versionCache = `1.10.0+${[...new Uint8Array(digest)].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
  return versionCache;
}

async function handleRequest(msg: RpcRequest, hub: DurableObjectStub<BridgeHub>, pictureBase: string, id: string, signal: AbortSignal, conversation: string | null) {
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
      // A report reaches no computer, so it is taken even while paused.
      if (tool === "report_problem") return ok(await hub.report(args.paragraph));
      // The person's instructions reach no computer either.
      if (tool === "get_instructions") return ok(await hub.instructionsTool(conversation));
      // Nothing else runs in a conversation until the person's instructions have been read in it.
      // (A hub still on older code, for a few minutes after a deploy, can't say: let the call through.)
      if (!(await hub.instructionsRead(conversation).catch(() => true))) {
        return ok(
          errorResult(
            "Call get_instructions first: the person's own instructions must be read at the start of every conversation, before anything else. Then call this tool again.",
          ),
        );
      }
      if (await hub.isPaused()) {
        return ok(
          errorResult(
            "Claude Bridge is paused on the person's computer, so nothing can be read, sent, started or opened. Tell the person; they turn it back on in the Claude Bridge panel of any Claude Code session (it can't be turned on from here).",
          ),
        );
      }
      const timeout = LONG_TOOLS.has(tool) ? LONG_TIMEOUT_MS : SHORT_TIMEOUT_MS;
      const started = Date.now();
      const diagId = await hub.diagStart(tool);
      // The app hung up (Cloudflare tells us when it can: `enable_request_signal`): a held wait ends
      // without marking news heard.
      const waitId = `${id}:${String(msg.id)}`;
      const onAbort = () => void hub.cancelWait(waitId).catch(() => undefined);
      if (tool === "wait_for_updates") signal?.addEventListener("abort", onAbort);
      try {
        const out = await dispatch(tool, args, timeout, waitId);
        await hub.diagEnd(diagId, signal?.aborted ? "caller left" : out.isError ? "error" : "answered", Date.now() - started).catch(() => undefined);
        return ok(out);
      } catch (err) {
        await hub.diagEnd(diagId, `failed: ${String(err).slice(0, 200)}`, Date.now() - started).catch(() => undefined);
        throw err;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }

  async function dispatch(tool: string, args: Record<string, unknown>, timeout: number, waitId: string) {
      switch (tool) {
        case "list_sessions":
          return (await hub.listSessions(pictureBase));
        case "list_projects":
          return (await hub.listProjects(args.device, pictureBase));
        case "start_session":
          return (await hub.startSession(args, timeout, pictureBase));
        case "resume_session":
          return (await hub.resumeSession(args, pictureBase));
        case "fork_session":
          return (await hub.forkSession(args, timeout, pictureBase));
        case "rename":
          return (await hub.rename(args, pictureBase));
        case "link_computer":
          return (await hub.linkComputer(args.code, args.name, id, args.remove));
        case "watch_sessions":
          return (await hub.watchSessions(args.sessions, args.mode));
        case "wait_for_updates":
          return (await hub.waitForUpdates(args.seconds, pictureBase, args.heard, waitId));
        case "show_screen":
          return (await hub.showScreen(args, pictureBase));
        default:
          return await hub.call(tool === "answer" ? "answer_question" : tool, args, timeout, pictureBase);
      }
  }
}
