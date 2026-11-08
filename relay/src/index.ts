// Claude Bridge: a Cloudflare Worker the Claude app talks to as an MCP connector, and that each
// computer's device agent and each open Claude Code session connect out to over WebSockets. The
// key proves ownership; OAuth state is signed, not stored.

import { handleMcp } from "./mcp";
import * as oauth from "./oauth";
import * as pages from "./pages";
import { ID_PATTERN, idFromKey, json, looksLikeKey, origin as originOf, preflight, text } from "./util";

export { BridgeHub } from "./hub";

const MCP_PATH = new RegExp(`^/(${ID_PATTERN})/mcp/?$`);
const PICTURE_PATH = new RegExp(`^/p/(${ID_PATTERN})/([a-f0-9]{32})\\.jpg$`);
const PRM_PATH = new RegExp(`^/\\.well-known/oauth-protected-resource/(${ID_PATTERN})/mcp/?$`);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const origin = originOf(env, req);
    if (req.method === "OPTIONS") return preflight();

    try {
      let m = path.match(MCP_PATH);
      if (m) return handleMcp(req, env, m[1], origin);
      m = path.match(PRM_PATH);
      if (m) return json(oauth.protectedResourceMetadata(origin, m[1]));
      if (path === "/.well-known/oauth-authorization-server") return json(oauth.authServerMetadata(origin));

      if (path === "/oauth/register" && req.method === "POST") return oauth.register(req, env);
      if (path === "/oauth/authorize") return oauth.authorize(req, env, origin, pages.message);
      if (path === "/oauth/connect") return oauth.connect(req, env, origin, pages.message);
      if (path === "/oauth/approve" && req.method === "POST") return oauth.approve(req, env, origin, pages.message);
      if (path === "/oauth/token" && req.method === "POST") return oauth.token(req, env);
      if (path === "/oauth/revoke" && req.method === "POST") return oauth.revoke();

      // Each computer's device agent, and each Claude Code session's connector.
      if (path === "/chat/connect") return chatConnect(req, env);
      if (path === "/api/status") return status(req, env);

      m = path.match(PICTURE_PATH);
      if (m) return picture(env, m[1], m[2]);

      if (path === "/health") return text("ok");
      if (path === "/") return pages.home(origin);
      return text("Not found", 404);
    } catch (err) {
      console.error("unhandled", path, err);
      return text("Something went wrong on our side. Please try again.", 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function keyFrom(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization");
  const key = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return looksLikeKey(key) ? idFromKey(key) : null;
}

/** Whoever holds a key owns its id; route the chat's WebSocket to that id's hub. */
async function chatConnect(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return text("Expected a WebSocket upgrade", 426);
  const id = await keyFrom(req);
  if (!id) return text("Missing or malformed Claude Bridge key.", 401);
  const headers = new Headers(req.headers);
  headers.delete("Authorization");
  return env.HUBS.get(env.HUBS.idFromName(id)).fetch(new Request(req.url, { method: "GET", headers }));
}

/** GET /api/status with the key: the computers and the open sessions. */
async function status(req: Request, env: Env): Promise<Response> {
  const id = await keyFrom(req);
  if (!id) return json({ error: "Send the Claude Bridge key as a Bearer token." }, 401);
  const now = (await env.HUBS.get(env.HUBS.idFromName(id)).status()) as unknown as Record<string, unknown>;
  return json({ id, ...now });
}

/** GET /p/<id>/<token>.jpg: a picture a tool result linked to, while its hour lasts. The token is
 * 128 random bits, so the link itself is the permission. */
async function picture(env: Env, id: string, token: string): Promise<Response> {
  const kept = await env.HUBS.get(env.HUBS.idFromName(id)).picture(token);
  if (!kept) return text("This picture has expired or never existed.", 404);
  const bytes = Uint8Array.from(atob(kept.data), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      "Content-Type": kept.mimeType,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
