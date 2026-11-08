// End-to-end test of the no-helper mode: a session that talks to the relay over HTTP (POST /peer,
// long-polled) and answers for its computer too, as plugin/hooks/inside.ts does on a Mac that
// won't run the helper programs. Against a local relay:
//   cd relay && npx wrangler dev --port 8811 --var PUBLIC_ORIGIN:http://localhost:8811
//   bun test/peer.e2e.ts
const BASE = process.env.RELAY ?? "http://localhost:8811";
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const key = "cbrg_" + b64url(crypto.getRandomValues(new Uint8Array(32)));
const id = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))).toString("hex").slice(0, 20);
const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
let failures = 0; const check = (ok: boolean, what: string) => { console.log(`${ts()} ${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures++; };

// OAuth as the Claude app does it.
const reg = await (await fetch(`${BASE}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://example.com/cb"], token_endpoint_auth_method: "none" }) })).json() as any;
const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
const a = await fetch(`${BASE}/oauth/authorize?` + new URLSearchParams({ client_id: reg.client_id, redirect_uri: "https://example.com/cb", response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "s", resource: `${BASE}/${id}/mcp` }), { redirect: "manual" });
const pending = new URL(a.headers.get("location")!, BASE).searchParams.get("req")!;
const ap = await fetch(`${BASE}/oauth/approve`, { method: "POST", body: new URLSearchParams({ pending, token: key, action: "allow" }), redirect: "manual" });
const code = new URL(ap.headers.get("location")!).searchParams.get("code")!;
const tok = await (await fetch(`${BASE}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: "https://example.com/cb" }) })).json() as any;
let n = 0;
const rpc = async (method: string, params: any = {}) => (await (await fetch(`${BASE}/${id}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) })).json() as any);
const call = async (name: string, args: any = {}) => { const r = await rpc("tools/call", { name, arguments: args }); return (r.result?.content ?? []).map((c: any) => c.text ?? "").join("\n"); };
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });

const DEVICE = "dev-locked-mini";
const peerPost = (body: any, credential = key) =>
  fetch(`${BASE}/peer`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify(body) });

/** A session in the no-helper mode: it long-polls, answers the app's calls and its computer's. */
function poller(session: string, project: string) {
  const hello = { type: "hello", protocol: 4, session, project, folder: `/Users/m/${project}`, device: DEVICE, serveDevice: true, name: "Locked Mini" };
  const seen: any[] = [];
  const calls: any[] = [];
  let running = true;
  const send = async (messages: any[]) => (await (await peerPost({ hello, messages, wait: 0 })).json() as any).messages.forEach(handle);
  const handle = (m: any) => {
    seen.push(m);
    if (m.type !== "call") return;
    calls.push(m);
    const raw =
      m.tool === "projects" ? { projects: [{ folder: `/Users/m/${project}`, name: project, lastActive: Date.now(), sessions: 2 }] }
      : m.tool === "sessions" ? { sessions: [{ id: session, name: "Kiosk build", lastActive: Date.now() }] }
      : m.tool === "names" ? { names: { [session]: "Kiosk build" } }
      : m.tool === "screenshot" ? { data: Buffer.from("locked-screen").toString("base64"), mimeType: "image/jpeg" }
      : null;
    // A session's own tool gets an MCP result (as the connector builds it); a computer's job, its raw answer.
    const result = raw ?? { content: [{ type: "text", text: JSON.stringify(m.tool === "send_message" ? { status: "sent", message: "m-locked-1" } : { tool: m.tool }) }], isError: false };
    setTimeout(() => send([{ type: "result", id: m.id, result }]), 100);
  };
  (async () => {
    while (running) {
      const r = await peerPost({ hello, messages: [], wait: 25 }).catch(() => undefined);
      if (!r?.ok) { await Bun.sleep(500); continue; }
      ((await r.json()) as any).messages.forEach(handle);
    }
  })();
  return { seen, calls, send, stop: () => (running = false) };
}

const mini = poller("cccc3333-kiosk", "Kiosk");
await Bun.sleep(800);
check(mini.seen.some((m) => m.type === "welcome"), "a polling session is welcomed");

let r = await call("list_sessions");
check(r.includes("Locked Mini") && r.includes("Kiosk build"), "list_sessions shows the polling session, named, on its computer");
r = await call("list_projects");
check(r.includes('"project":"Kiosk"') && mini.calls.some((c) => c.tool === "projects"), "list_projects is answered by the session for its computer (no device agent)");

let t = Date.now();
r = await call("send_message", { session: "kiosk build", text: "run the tests" });
check(r.includes('"status":"sent"') && Date.now() - t < 3000, "send_message reaches a polling session at once, through its held request");

await call("watch_sessions", { sessions: ["kiosk build"] });
await Bun.sleep(300);
check(mini.seen.some((m) => m.type === "watched" && m.watched === true), "the polling session hears it is watched");

await mini.send([{ type: "state", working: true, side: false, asking: 0, task: "run the tests" }]);
t = Date.now();
const waiting = call("wait_for_updates", { seconds: 30 });
setTimeout(() => mini.send([{ type: "event", kind: "finished", text: "All 12 pass.", task: "run the tests", changes: [], messages: ["m-locked-1"], forApp: true }]), 800);
r = await waiting;
check(r.includes("All 12 pass.") && Date.now() - t < 8000, "its news reaches wait_for_updates");

r = await call("show_screen", { device: "Locked Mini" });
check(mini.calls.some((c) => c.tool === "show_screen" || c.tool === "screenshot"), "show_screen reaches the computer through its polling session");

// Claude Code's question waits on the relay's mailbox; the answer comes from elsewhere.
const qid = "cccc3333-kiosk:q1";
t = Date.now();
const asked = fetch(`${BASE}/peer/answer`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ id: qid, seconds: 10 }) }).then((x) => x.json()) as Promise<any>;
setTimeout(() => fetch(`${BASE}/peer/answer`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ id: qid, value: { answers: ["Yes"] } }) }), 700);
const answered = await asked;
check(answered.value?.answers?.[0] === "Yes" && Date.now() - t < 5000, "a question's wait ends the moment its answer is put");
const none = await (await fetch(`${BASE}/peer/answer`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ id: "nobody:q", seconds: 1 }) })).json() as any;
check(none.pending === true, "with no answer the wait ends pending");

// Pause from the polling session, and back.
await mini.send([{ type: "pause", paused: true }]);
await Bun.sleep(400);
r = await call("list_sessions");
check(r.includes("Claude Bridge is paused") && mini.seen.some((m) => m.type === "paused" && m.paused === true), "a polling session pauses the account and hears it");
await mini.send([{ type: "pause", paused: false }]);
await Bun.sleep(300);

// Refusals.
const noKey = await fetch(`${BASE}/peer`, { method: "POST", body: "{}" });
const forged = await peerPost({ hello: { session: "x" }, messages: [], wait: 0 }, `cbd_${id}_${"0".repeat(64)}`);
check(noKey.status === 401 && forged.status === 401, "no key, or a credential no one linked, is refused");

mini.stop();
await Bun.sleep(200);
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
