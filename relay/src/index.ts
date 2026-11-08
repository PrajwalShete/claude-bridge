// Claude Bridge: a Cloudflare Worker the Claude app talks to as an MCP connector, and that each
// computer's device agent and each open Claude Code session connect out to over WebSockets. The
// key proves ownership; OAuth state is signed, not stored.

import { handleMcp } from "./mcp";
import * as oauth from "./oauth";
import * as pages from "./pages";
import { DEVICE_CREDENTIAL, ID_PATTERN, LINK_CODE, idFromKey, json, looksLikeKey, origin as originOf, preflight, sha256Hex, text } from "./util";

export { BridgeHub } from "./hub";

const MCP_PATH = new RegExp(`^/(${ID_PATTERN})/mcp/?$`);
const PICTURE_PATH = new RegExp(`^/p/(${ID_PATTERN})/([a-f0-9]{32})\\.jpg$`);
const PRM_PATH = new RegExp(`^/\\.well-known/oauth-protected-resource/(${ID_PATTERN})/mcp/?$`);
const LINK_PATH = /^\/link\/([A-HJ-NP-Z2-9]{12})$/;

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
      // A new computer linking itself to an account: it offers a code, then waits for it to be approved.
      m = path.match(LINK_PATH);
      if (m) return link(req, env, m[1]);
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

/**
 * Whoever holds the account's key owns its id; a linked computer holds its own credential, which
 * names the account and is checked by its hub. Route the WebSocket to that account's hub.
 */
async function chatConnect(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return text("Expected a WebSocket upgrade", 426);
  const auth = req.headers.get("Authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const device = bearer.match(DEVICE_CREDENTIAL);
  const id = device ? device[1]! : await keyFrom(req);
  if (!id) return text("Missing or malformed Claude Bridge key.", 401);
  const headers = new Headers(req.headers);
  headers.delete("Authorization");
  // Only this Worker says which device credential came: a client's own header is dropped.
  headers.delete("X-Bridge-Device");
  if (device) headers.set("X-Bridge-Device", await sha256Hex(device[2]!));
  return env.HUBS.get(env.HUBS.idFromName(id)).fetch(new Request(req.url, { method: "GET", headers }));
}

/** GET /api/status with the key: the computers and the open sessions. */
async function status(req: Request, env: Env): Promise<Response> {
  const id = await keyFrom(req);
  if (!id) return json({ error: "Send the Claude Bridge key as a Bearer token." }, 401);
  const now = (await env.HUBS.get(env.HUBS.idFromName(id)).status()) as unknown as Record<string, unknown>;
  return json({ id, ...now });
}

/**
 * /link/<code>: POST offers the code (a new computer, before anyone approves it); GET waits up to
 * 25 s for the person to approve it from the Claude app, and answers the computer's credential
 * once, or `{ pending: true }`. A code lasts ten minutes.
 */
async function link(req: Request, env: Env, code: string): Promise<Response> {
  if (!LINK_CODE.test(code)) return text("Not a link code.", 400);
  const pairing = env.HUBS.get(env.HUBS.idFromName(`link:${code}`));
  if (req.method === "POST") return json(await pairing.linkOffer());
  if (req.method === "GET") return json(await pairing.linkWait());
  return text("Use POST to offer a code, GET to wait for it.", 405);
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
