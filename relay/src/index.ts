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
/** The one address for everyone (the Claude app plugin's connector): sign-in says whose account it is. */
const SHARED_MCP_PATH = /^\/mcp\/?$/;
const SHARED_PRM_PATH = /^\/\.well-known\/oauth-protected-resource\/mcp\/?$/;
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
      if (SHARED_MCP_PATH.test(path)) return handleMcp(req, env, null, origin);
      if (SHARED_PRM_PATH.test(path)) return json(oauth.protectedResourceMetadata(origin, null));
      if (path === "/.well-known/oauth-authorization-server") return json(oauth.authServerMetadata(origin));

      if (path === "/oauth/register" && req.method === "POST") return oauth.register(req, env);
      if (path === "/oauth/authorize") return oauth.authorize(req, env, origin, pages.message);
      if (path === "/oauth/connect") return oauth.connect(req, env, origin, pages.message);
      if (path === "/oauth/approve" && req.method === "POST") return oauth.approve(req, env, origin, pages.message);
      if (path === "/oauth/token" && req.method === "POST") return oauth.token(req, env);
      if (path === "/oauth/revoke" && req.method === "POST") return oauth.revoke();

      // Each computer's device agent, and each Claude Code session's connector.
      if (path === "/chat/connect") return chatConnect(req, env);
      // A session that can't run the helper programs talks to its hub over plain HTTP instead.
      if (path === "/peer" && req.method === "POST") return peer(req, env);
      if (path === "/peer/answer" && req.method === "POST") return peerAnswer(req, env);
      // A new computer linking itself to an account: it offers a code, then waits for it to be approved.
      m = path.match(LINK_PATH);
      if (m) return link(req, env, m[1]);
      if (path === "/api/status") return status(req, env);
      if (path === "/api/diag") return diag(req, env);
      if (path === "/api/reports" || path.startsWith("/api/reports/")) return reports(req, env, path);
      if (path === "/api/instructions") return instructions(req, env);
      if (path === "/api/admin/census" && req.method === "POST") return census(req, env, "census");
      if (path === "/api/admin/purge" && req.method === "POST") return census(req, env, "purge");

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

/** GET /api/diag with the key: the hub's last 200 calls (tool, start, how long, how it ended). */
async function diag(req: Request, env: Env): Promise<Response> {
  const id = await keyFrom(req);
  if (!id) return json({ error: "Send the Claude Bridge key as a Bearer token." }, 401);
  return json({ calls: await env.HUBS.get(env.HUBS.idFromName(id)).diag() });
}

/** GET /api/reports with the key: every report kept; DELETE /api/reports/<id> removes one dealt with. */
async function reports(req: Request, env: Env, path: string): Promise<Response> {
  const id = await keyFrom(req);
  if (!id) return json({ error: "Send the Claude Bridge key as a Bearer token." }, 401);
  const hub = env.HUBS.get(env.HUBS.idFromName(id));
  const one = path.slice("/api/reports/".length);
  if (req.method === "DELETE" && one) return json({ removed: await hub.removeReport(decodeURIComponent(one)) });
  if (req.method === "GET" && path === "/api/reports") return json({ reports: await hub.reports() });
  return json({ error: "GET /api/reports, or DELETE /api/reports/<id>." }, 405);
}

/**
 * /api/instructions: the person's instructions for the Claude app's assistant. GET reads them; PUT
 * `{ text }` replaces them. The panel calls it with the account key or a linked computer's credential.
 */
async function instructions(req: Request, env: Env): Promise<Response> {
  const account = await peerAccount(req);
  if (!account) return json({ error: "Missing or malformed Claude Bridge key." }, 401);
  const hub = env.HUBS.get(env.HUBS.idFromName(account.id));
  if (req.method === "GET") {
    const out = await hub.instructions(account.device);
    return json(out, "error" in out ? 401 : 200);
  }
  if (req.method === "PUT") {
    const body = (await req.json().catch(() => ({}))) as { text?: unknown };
    const out = await hub.setInstructions(body.text, account.device);
    return json(out, "error" in out ? 400 : 200);
  }
  return json({ error: "GET or PUT { text }." }, 405);
}

/**
 * POST /api/admin/census `{ ids: [...] }` with the operator's ADMIN_TOKEN (a Worker secret): what each
 * Durable Object (by its id, as Cloudflare's API lists them) is, in counts only. Off unless the
 * secret is set.
 */
async function census(req: Request, env: Env, action: "census" | "purge"): Promise<Response> {
  const admin = (env as unknown as { ADMIN_TOKEN?: string }).ADMIN_TOKEN;
  const auth = req.headers.get("Authorization") ?? "";
  if (!admin || admin.length < 32 || auth !== `Bearer ${admin}`) return text("Not found", 404);
  const { ids } = (await req.json().catch(() => ({}))) as { ids?: unknown };
  if (!Array.isArray(ids) || ids.length > 200) return json({ error: "Send { ids: [...] }, at most 200." }, 400);
  const out = await Promise.all(
    ids.map(async (raw) => {
      const objectId = String(raw);
      try {
        const hub = env.HUBS.get(env.HUBS.idFromString(objectId));
        return { id: objectId, ...(action === "purge" ? await hub.purgeLeftover() : await hub.census()) };
      } catch (err) {
        return { id: objectId, kind: "unknown", error: String(err).slice(0, 120) };
      }
    }),
  );
  return json({ objects: out });
}

/** The account a polling session's credential names, and a linked computer's credential hash for its hub to check. */
async function peerAccount(req: Request): Promise<{ id: string; device: string | null } | null> {
  const auth = req.headers.get("Authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const device = bearer.match(DEVICE_CREDENTIAL);
  if (device) return { id: device[1]!, device: await sha256Hex(device[2]!) };
  return looksLikeKey(bearer) ? { id: await idFromKey(bearer), device: null } : null;
}

/** POST /peer: one exchange with a polling session (its hello, what it sends; held up to 25 s for what waits). */
async function peer(req: Request, env: Env): Promise<Response> {
  const account = await peerAccount(req);
  if (!account) return json({ error: "Missing or malformed Claude Bridge key." }, 401);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Expected JSON." }, 400);
  }
  const out = await env.HUBS.get(env.HUBS.idFromName(account.id)).exchange(body as never, account.device);
  return json(out, "error" in out ? 401 : 200);
}

/** POST /peer/answer: puts an answer to Claude Code's question (`value`), or waits up to `seconds` for one. */
async function peerAnswer(req: Request, env: Env): Promise<Response> {
  const account = await peerAccount(req);
  if (!account) return json({ error: "Missing or malformed Claude Bridge key." }, 401);
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; value?: unknown; seconds?: unknown };
  if (typeof body.id !== "string" || !body.id) return json({ error: "Name the question." }, 400);
  return json(await env.HUBS.get(env.HUBS.idFromName(account.id)).answerBox(body.id, body.value, Number(body.seconds ?? 8), account.device));
}

/**
 * /link/<code>: POST offers the code (a new computer, before anyone approves it); GET waits up to
 * 25 s for the person to approve it from the Claude app, and answers the computer's credential
 * once, or `{ pending: true }`. A code lasts ten minutes. Both carry the computer's own secret
 * (`X-Link-Secret`): the code is read aloud, so only the computer that offered it can collect.
 */
async function link(req: Request, env: Env, code: string): Promise<Response> {
  if (!LINK_CODE.test(code)) return text("Not a link code.", 400);
  const pairing = env.HUBS.get(env.HUBS.idFromName(`link:${code}`));
  const secret = req.headers.get("X-Link-Secret") ?? "";
  const secretHash = /^[A-Za-z0-9_-]{32,128}$/.test(secret) ? await sha256Hex(secret) : null;
  if (req.method === "POST") {
    const out = await pairing.linkOffer(secretHash);
    return json(out, "error" in out ? 409 : 200);
  }
  if (req.method === "GET") return json(await pairing.linkWait(secretHash));
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
