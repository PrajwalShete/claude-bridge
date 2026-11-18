// End-to-end test of devices, projects, sessions, watching and the update feed: real session
// connectors and stand-in device agents (two computers) against a local relay:
//   cd relay && npx wrangler dev --port 8811 --var PUBLIC_ORIGIN:http://localhost:8811
//   bun test/bridge.e2e.ts
// The connector must be built (plugin/connector/bin/claude-bridge-connector); CONNECTOR overrides its path.
const BIN = process.env.CONNECTOR ?? new URL("../../plugin/connector/bin/claude-bridge-connector", import.meta.url).pathname;
const BASE = process.env.RELAY ?? "http://localhost:8811";
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const key = "cbrg_" + b64url(crypto.getRandomValues(new Uint8Array(32)));
const id = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))).toString("hex").slice(0, 20);
const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
const MAC = "dev-mac-1111";
const MINI = "dev-mini-2222";
let failures = 0; const check = (ok: boolean, what: string) => { console.log(`${ts()} ${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures++; };

function chat(session: string, project: string, reply: (tool: string, args: any) => any, device = MAC): { p: any; post: (r: string, b: any) => Promise<any>; seen: any[] } {
  const sock = `/tmp/cb-multi-${session}.sock`;
  const p = Bun.spawn([BIN], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  p.stdin.write(JSON.stringify({ relay: `ws://localhost:8811/chat/connect`, key, session, project, folder: `/Users/x/${project}`, socketPath: sock, device }));
  p.stdin.end();
  const post = (r: string, b: any) => fetch(`http://h${r}`, { method: "POST", body: JSON.stringify(b), unix: sock } as any).then(x => x.json());
  const seen: any[] = [];
  (async () => {
    let buf = "";
    for await (const c of p.stdout) {
      buf += new TextDecoder().decode(c);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const e = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); seen.push(e);
        if (e.t === "tool") setTimeout(async () => post("/tool_response", { id: e.id, response: await reply(e.name, e.args) }), 300);
      }
    }
  })();
  return { p, post, seen };
}

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

// A stand-in for a computer's device agent (plugin/connector/device.swift), over a real WebSocket.
function deviceAgent(id: string, name: string, projects: Array<{ name: string; folder: string }>, history: Record<string, Array<{ id: string; name: string }>>) {
  const calls: any[] = [];
  const ws = new WebSocket("ws://localhost:8811/chat/connect", { headers: { Authorization: `Bearer ${key}` } } as any);
  const renamed: Record<string, string> = {};
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", role: "device", protocol: 4, device: id, name }));
  ws.onmessage = async (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.type !== "call") return;
    calls.push(msg);
    const a = msg.args ?? {};
    let result: any;
    switch (msg.tool) {
      case "projects":
        result = { projects: projects.map((p, i) => ({ ...p, lastActive: Date.now() - i * 3_600_000, sessions: (history[p.folder] ?? []).length })) };
        break;
      case "sessions":
        result = { sessions: (history[a.folder] ?? []).map((s, i) => ({ ...s, name: renamed[s.id] ?? s.name, lastActive: Date.now() - i * 86_400_000 })) };
        break;
      case "names": {
        const names: Record<string, string> = {};
        for (const s of a.sessions ?? []) {
          const known = Object.values(history).flat().find((h) => h.id === s.id);
          if (renamed[s.id] ?? known?.name) names[s.id] = renamed[s.id] ?? known!.name;
        }
        result = { names };
        break;
      }
      case "rename_session":
        renamed[a.id] = a.name;
        result = { renamed: a.name };
        break;
      case "open_session": {
        const folder = Object.keys(history).find((f) => history[f]!.some((h) => h.id === a.id))!;
        setTimeout(() => opened.push(chat(a.id, folder.split("/").pop()!, fake(a.id), id)), 800);
        result = { opened: "opened in the desktop app" };
        break;
      }
      case "start_session": {
        const newId = `new0${Math.random().toString(16).slice(2, 6)}-session`;
        history[a.folder] = [{ id: newId, name: a.name ?? "New" }, ...(history[a.folder] ?? [])];
        setTimeout(() => opened.push(chat(newId, a.folder.split("/").pop()!, fake(newId), id)), 800);
        result = { id: newId };
        break;
      }
      case "fork_session": {
        const forkId = `fork${Math.random().toString(16).slice(2, 6)}-side`;
        const project = a.folder.split("/").pop()!;
        history[a.folder] = [{ id: forkId, name: a.name }, ...(history[a.folder] ?? [])];
        setTimeout(() => {
          const side = chat(forkId, project, fake(forkId), id);
          opened.push(side);
          setTimeout(() => side.post("/state", { working: false, side: true, asking: 0, parent: a.id }), 600);
        }, 800);
        result = { id: forkId, opened: "opened in the desktop app" };
        break;
      }
      case "screenshot":
        result = { data: Buffer.from("screen-of-" + name).toString("base64"), mimeType: "image/jpeg" };
        break;
      default:
        result = { error: "unknown" };
    }
    ws.send(JSON.stringify({ type: "result", id: msg.id, result }));
  };
  return { ws, calls, close: () => ws.close() };
}
const opened: any[] = [];

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
check(/^1\.8\.0\+[0-9a-f]{8}$/.test(init.result.serverInfo.version) && init.result.capabilities.tools.listChanged === true, `versioned server ${init.result.serverInfo.version}, listChanged`);
const tools = (await rpc("tools/list")).result.tools.map((t: any) => t.name);
const expected = ["list_sessions", "list_projects", "read_session", "catch_up", "ask", "send_message", "answer", "wait_for_updates", "watch_sessions", "stop_session", "start_session", "resume_session", "fork_session", "rename", "link_computer", "show_screen", "report_problem", "get_instructions"];
check(tools.length === expected.length && expected.every((t) => tools.includes(t)), `the tools: ${tools.join(", ")}`);
const desc = (await rpc("tools/list")).result.tools.find((t: any) => t.name === "send_message")?.description ?? "";
check(desc.includes("Sends the person's request") && init.result.instructions.includes("adding nothing of your own"), "the send-only-what-asked rule is in the instructions and the send tool");

// A fake session answers at once, as the plugin does: send_message says sent, with the message's id.
function fake(name: string) {
  return (tool: string, args: any) =>
    tool === "send_message"
      ? { status: "sent", message: `m-${name}-${args.text.length}` }
      : tool === "session_setting"
        ? { model: "claude-opus-5-5", effort: "high" }
      : tool === "show_screen"
        ? { status: "shown", _images: [{ data: Buffer.from("screen-via-" + name).toString("base64"), mimeType: "image/jpeg" }] }
        : { now: { isWorking: false }, tool };
}
const mac = deviceAgent(MAC, "Prajwal's MacBook", [
  { name: "Nav", folder: "/Users/x/Nav" },
  { name: "SdPaithani", folder: "/Users/x/SdPaithani" },
], {
  "/Users/x/Nav": [
    { id: "aaaa1111-nav", name: "Bridge architecture" },
    { id: "old11111-nav", name: "Voice mod" },
    { id: "old22222-nav", name: "Gemini spike" },
  ],
  "/Users/x/SdPaithani": [{ id: "bbbb2222-sdp", name: "Login gates" }],
});
const nav = chat("aaaa1111-nav", "Nav", fake("nav"));
const sdp = chat("bbbb2222-sdp", "SdPaithani", fake("sdp"));
await Bun.sleep(1500);

// Devices, projects, sessions.
let r = await call("list_sessions");
check(r.includes("Prajwal's MacBook") && r.includes("Bridge architecture") && r.includes("Login gates"), "list_sessions shows the computer and its sessions by name");
r = await call("list_projects");
check(r.includes('"project":"Nav"') && r.includes('"project":"SdPaithani"') && r.includes('"openSessions":1'), "list_projects lists the computer's projects with open sessions");
let t = Date.now();
r = await call("send_message", { session: "bridge architecture", text: "build the thing" });
check(r.includes("Session: Bridge architecture (Nav, aaaa1111)") && r.includes('"status":"sent"') && Date.now() - t < 3000, "a session is found by its own name, and send returns at once");
r = await call("send_message", { session: "SD Paithani", text: "deploy" });
check(r.includes("Login gates"), "\"SD Paithani\" (a project's name) finds its session");
r = await call("send_message", { text: "hello" });
check(r.includes("Say which session"), "no session named with two open asks which one");

// Renaming.
r = await call("rename", { session: "Nav", name: "Claude Bridge v4" });
check(r.includes('"renamed"') && mac.calls.some((c) => c.tool === "rename_session" && c.args.folder === "/Users/x/Nav"), "rename_session renames through the computer (into the transcript)");
r = await call("catch_up", { session: "claude bridge v4" });
check(r.includes("Session: Claude Bridge v4"), "the new name finds the session at once");
r = await call("rename", { device: "Prajwal's MacBook", name: "Studio Mac" });
check(r.includes('"device":"Studio Mac"'), "rename_device names the computer");
r = await call("list_sessions");
check(r.includes("Studio Mac") && !r.includes("Prajwal's MacBook"), "the computer's new name is used everywhere");

// Resume: a numbered list, then a pick by number.
r = await call("resume_session", { project: "nav" });
check(r.includes('"number":1') && r.includes('"number":3') && r.includes("Gemini spike") && r.includes('"open":true'), "resume_session lists the project's sessions, numbered, the open one marked");
t = Date.now();
r = await call("resume_session", { number: 3, open_in: "terminal" });
check(r.includes('"status":"resumed"') && r.includes("old22222-nav") && Date.now() - t < 10_000, "picking number 3 opens that session and waits until it is live");
check(mac.calls.some((c) => c.tool === "open_session" && c.args.open_in === "terminal" && c.args.folder === "/Users/x/Nav"), "where to open it (a terminal) reaches the computer, with the folder");
r = await call("catch_up", { session: "gemini spike" });
check(r.includes("Session: Gemini spike"), "the resumed session is reachable by its name");
r = await call("resume_session", { number: 1 });
check(r.includes("already open"), "an open session isn't opened twice");
r = await call("resume_session", { project: "SdPaithani", number: 1 });
check(r.includes("The last list was for Nav"), "a number only counts for the list it came from");

// Start a new session with its first message.
t = Date.now();
r = await call("start_session", { project: "SdPaithani", name: "Invoice export", message: "add a CSV export" });
check(r.includes('"status":"started"') && r.includes("Invoice export") && r.includes('"status":"sent"') && Date.now() - t < 15_000, "start_session starts it, waits until it is live, and sends its first message");
r = await call("list_sessions");
check(r.includes("Invoice export"), "the new session is listed by its name");

// A side chat forked from a session, with its own task, both watched.
await call("watch_sessions", { sessions: [], mode: "only" });
await nav.post("/state", { working: false, side: false, asking: 0, runsIn: "terminal", terminalApp: "iTerm" });
await Bun.sleep(200);
t = Date.now();
r = await call("fork_session", { session: "claude bridge v4", task: "write the tests for the header" });
check(r.includes(`"status":"forked"`) && r.includes("Nav side: write the tests for") && r.includes('"status":"sent"') && Date.now() - t < 15_000, "fork_session forks, names it from the task, and sends the side task");
check(mac.calls.some((c) => c.tool === "fork_session" && c.args.id === "aaaa1111-nav" && c.args.folder === "/Users/x/Nav"), "the computer forks the right session");
check(mac.calls.some((c) => c.tool === "fork_session" && c.args.open_in === "terminal" && c.args.terminal_app === "iTerm"), "a session running in a terminal is forked into the same terminal app");
check(mac.calls.some((c) => c.tool === "fork_session" && c.args.model === "claude-opus-5-5" && c.args.effort === "high"), "the side chat gets the model and effort its original is on now");
await sdp.post("/state", { working: false, side: false, asking: 0, runsIn: "desktop" });
await Bun.sleep(200);
await call("fork_session", { session: "login gates", task: "check the copy" });
check(mac.calls.filter((c) => c.tool === "fork_session").at(-1)?.args.open_in === "desktop", "a desktop session is forked into the desktop app");
await call("fork_session", { session: "login gates", task: "check the copy again", open_in: "terminal" });
check(mac.calls.filter((c) => c.tool === "fork_session").at(-1)?.args.open_in === "terminal", "the person saying where wins");
await Bun.sleep(900);
r = await call("list_sessions");
check(r.includes('"kind":"side chat"') && r.includes('"forkedFrom":"Claude Bridge v4 (aaaa1111)"'), "the side chat is listed as one, with the session it came from");
check(r.includes('"runsIn":"terminal"') && (r.match(/"watched":true/g) ?? []).length >= 2, "both the session and its side chat are watched, and where each runs is shown");
r = await call("catch_up", { session: "nav side write the tests" });
check(r.includes("Session: Nav side: write the tests for"), "the side chat is reached by its name");
r = await call("catch_up", { session: "Nav" });
check(r.includes("Session: Claude Bridge v4"), "the project's name means the watched main session, not its side chat");

// A second computer.
const mini = deviceAgent(MINI, "Mac mini", [{ name: "Nav", folder: "/Users/y/Nav" }], { "/Users/y/Nav": [{ id: "cccc3333-mini", name: "Server setup" }] });
const miniNav = chat("cccc3333-mini", "Nav", fake("mini"), MINI);
await Bun.sleep(1500);
r = await call("list_sessions");
check(r.includes('"devices"') && r.includes("Mac mini") && r.includes("Studio Mac"), "with two computers, sessions are grouped by computer");
r = await call("resume_session", { project: "Nav" });
check(r.includes("matches more than one project") && r.includes("Mac mini"), "a project on two computers asks which computer");
r = await call("resume_session", { project: "Nav", device: "mac mini" });
check(r.includes("Server setup") && r.includes('"device":"Mac mini"'), "naming the computer picks its project");
r = await call("catch_up", { session: "Nav", device: "Mac mini" });
check(r.includes("Server setup") && r.includes("on Mac mini"), "device narrows a session reference");
r = await call("show_screen", { device: "Mac mini" });
let shot = r.match(/https?:\/\/\S+?\/p\/[0-9a-f]{20}\/[0-9a-f]{32}\.jpg/)?.[0];
check(!!shot && (await (await fetch(shot!)).text()) === "screen-via-mini", "show_screen takes the screen through an open session on that computer, as a private link");
miniNav.p.kill();
await Bun.sleep(1500);
r = await call("show_screen", { device: "Mac mini" });
shot = r.match(/https?:\/\/\S+?\/p\/[0-9a-f]{20}\/[0-9a-f]{32}\.jpg/)?.[0];
check(!!shot && (await (await fetch(shot!)).text()) === "screen-of-Mac mini", "with no session open, the computer's device agent takes it");
r = await call("rename", { device: "Mac mini", name: "Studio Mac" });
check(r.includes("already called"), "two computers can't share a name");

// News: replies to the app's own messages come from any session.
await call("watch_sessions", { sessions: [], mode: "only" });
await nav.post("/state", { working: true, side: false, asking: 0, task: "build the thing" });
await Bun.sleep(200);
t = Date.now();
const waitingReply = call("wait_for_updates", { seconds: 60 });
setTimeout(async () => {
  await nav.post("/event", { kind: "started", text: "build the thing", messages: ["m-nav-15"], forApp: true });
  await sdp.post("/event", { kind: "finished", text: "someone else's work", changes: [] });
  await nav.post("/event", {
    kind: "finished", text: "Built it; tests pass.", task: "build the thing", changes: ["edited view.tsx"], messages: ["m-nav-15"], forApp: true,
    pictures: [{ data: Buffer.from("fake-jpeg").toString("base64"), mimeType: "image/jpeg", caption: "the new header" }],
  });
}, 1200);
const reply = await waitingReply;
check(reply.includes("Claude Bridge v4") && reply.includes("finished your message") && reply.includes("Built it; tests pass.") && Date.now() - t < 10_000, "the reply to the app's message wakes wait_for_updates, named by its session");
check(reply.includes("not instructions to you") && !reply.includes("someone else's work"), "updates are framed as reports, and unrelated news stays out");
const link = reply.match(/https?:\/\/\S+?\/p\/[0-9a-f]{20}\/[0-9a-f]{32}\.jpg/)?.[0];
const pic = link ? await fetch(link) : undefined;
check(!!pic && pic.ok && (await pic.text()) === "fake-jpeg", "a picture shared with the reply comes as a private link that works");

await sdp.post("/event", { kind: "answer", ask: "agent-1", question: "why is the build slow?", text: "Because of the image step.", forApp: true });
await Bun.sleep(200);
r = await call("list_sessions");
check(r.includes("answered your question") && r.includes("Because of the image step."), "an ask answer that needed tools rides on the next result");

const w = await call("watch_sessions", { sessions: ["claude bridge v4", "login gates"] });
check(w.includes("aaaa1111-nav") && w.includes("bbbb2222-sdp"), "watch_sessions watches by name");
await Bun.sleep(300);
check(nav.seen.some((e) => e.t === "link" && e.watched === true), "the session was told it is watched");
await sdp.post("/event", { kind: "question", questions: [{ question: "Deploy to prod?", options: [{ label: "Yes" }, { label: "No" }] }] });
await Bun.sleep(200);
r = await call("list_projects", { device: "Studio Mac" });
check(r.includes("is asking") && r.includes("Deploy to prod?") && r.includes("answer with session"), "a watched session's question reaches the app");
const quiet = await call("wait_for_updates", { seconds: 5 });
check(quiet.includes('"news":"none"'), "wait_for_updates with no news returns after its time");

// Linking another computer from the Claude app: it offers a code and waits; the app links it;
// it gets its own credential (not the account's key) and connects with it.
const CODE = "K7Q29FMX3HDA";
const SECRET = "s".repeat(20) + crypto.randomUUID().replace(/-/g, "");
let offered = await (await fetch(`${BASE}/link/${CODE}`, { method: "POST", headers: { "X-Link-Secret": SECRET } })).json() as any;
const stranger = fetch(`${BASE}/link/${CODE}`, { headers: { "X-Link-Secret": "x".repeat(40) } }).then((x) => x.json()) as Promise<any>;
const waiting = fetch(`${BASE}/link/${CODE}`, { headers: { "X-Link-Secret": SECRET } }).then((x) => x.json()) as Promise<any>;
await Bun.sleep(300);
r = await call("link_computer", { code: "k7q2 9fmx 3hda" });
const handed = await waiting;
check(offered.ok === true && r.includes('"status":"linked"') && /^cbd_[a-f0-9]{20}_[a-f0-9]{64}$/.test(handed.credential ?? "") && !String(handed.credential).includes(key), "a new computer is linked from the app and gets a credential of its own");
r = await call("link_computer", { code: CODE });
check(r.includes("isn't waiting"), "a code links once");
const linkedSession = (() => {
  const sock = `/tmp/cb-multi-linked.sock`;
  const p = Bun.spawn([BIN], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  p.stdin.write(JSON.stringify({ relay: `ws://localhost:8811/chat/connect`, key: handed.credential, session: "ffff6666-linked", project: "Elsewhere", folder: "/Users/z/Elsewhere", socketPath: sock, device: "dev-linked-3333" }));
  p.stdin.end();
  return p;
})();
const forged = new WebSocket("ws://localhost:8811/chat/connect", { headers: { Authorization: `Bearer ${String(handed.credential).replace(/.{8}$/, "00000000")}` } } as any);
let forgedRefused = false;
forged.onclose = () => (forgedRefused = true);
forged.onerror = () => (forgedRefused = true);
await Bun.sleep(1800);
r = await call("list_sessions");
check(r.includes("Elsewhere") && forgedRefused, "the linked computer's session connects; a forged credential is refused");
check(!(await stranger).credential, "someone who only heard the code can't collect the credential");
r = await call("link_computer", {});
check(r.includes('"linked"') && r.includes("a computer"), "link_computer lists the linked computers");
r = await call("link_computer", { remove: "a computer" });
await Bun.sleep(800);
const afterRemove = await call("list_sessions");
check(r.includes('"removed"') && !afterRemove.includes("Elsewhere"), "unlinking a computer ends its connections");
linkedSession.kill();

// Pausing from a session refuses every call from the app, everywhere, until a session resumes it.
let ok = await nav.post("/pause", { paused: true });
await Bun.sleep(400);
r = await call("list_sessions");
check(ok.ok === true && r.includes("Claude Bridge is paused") && r.includes("can't be turned on from here"), "a paused account refuses the app's calls");
r = await call("start_session", { project: "Nav", name: "should not start" });
check(r.includes("Claude Bridge is paused") && !mac.calls.some((c) => c.tool === "start_session" && c.args.name === "should not start"), "nothing reaches a computer while paused");
const PARAGRAPH = "I called read_session on Haiku and its header said Nav. " + "Details. ".repeat(400);
r = await call("report_problem", { paragraph: PARAGRAPH });
check(r.includes('"reported"'), "a problem can be reported, even while paused");
const MINE = "Speak plainly and keep answers short. Tell me what failed first.\nNever read code aloud.";
const saved = await (await fetch(`${BASE}/api/instructions`, { method: "PUT", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ text: MINE }) })).json() as any;
r = await call("get_instructions");
check(saved.text === MINE && r.includes("Speak plainly and keep answers short.") && r.includes("Never read code aloud."), "the panel's instructions are kept, and get_instructions gives them whole, even while paused");
check(init.result.instructions.startsWith("First, at the start of every conversation") && init.result.instructions.includes("get_instructions"), "the connector's instructions say to call get_instructions first");
check(sdp.seen.some((e) => e.t === "link" && e.paused === true), "every session hears that it is paused");
await sdp.post("/event", { kind: "finished", text: "news while paused", forApp: true });
ok = await sdp.post("/pause", { paused: false });
await Bun.sleep(400);
r = await call("list_sessions");
check(ok.ok === true && !r.includes("is paused") && !r.includes("news while paused") && r.includes("Claude Bridge v4"), "any session resumes it, and news from the pause wasn't kept");

// Nothing is ever cut: a long reply arrives whole, and a batch too big for one result arrives
// whole over several calls.
await call("wait_for_updates", { seconds: 5 });
const long = (tag: string, n: number) => `${tag} begins. ${"All of this must arrive. ".repeat(Math.ceil(n / 25)).slice(0, n)} ${tag} ends here.`;
await sdp.post("/event", { kind: "finished", text: long("REPLY-A", 12_000), task: long("TASK-A", 3_000), forApp: true });
await Bun.sleep(300);
r = await call("wait_for_updates", { seconds: 5 });
check(r.includes(long("REPLY-A", 12_000)) && r.includes("your message") && !r.includes("TASK-A"), "a 12,000-character reply arrives whole; the app's own request is named, not echoed");
// A message typed on the computer (the app hasn't seen it) comes whole with the reply.
await sdp.post("/event", { kind: "finished", text: "Done.", task: long("TASK-B", 3_000) });
await Bun.sleep(300);
r = await call("wait_for_updates", { seconds: 5 });
check(r.includes(long("TASK-B", 3_000)), "a request typed on the computer comes whole");
for (const tag of ["B1", "B2", "B3", "B4"]) await sdp.post("/event", { kind: "finished", text: long(tag, 20_000), forApp: true });
await sdp.post("/event", { kind: "answer", ask: "x1", question: long("Q", 1_000), text: long("ANSWER", 9_000), forApp: true });
await Bun.sleep(400);
const first = await call("wait_for_updates", { seconds: 5 });
const second = await call("wait_for_updates", { seconds: 5 });
const third = (first + second).includes("ANSWER ends here.") ? "" : await call("wait_for_updates", { seconds: 5 });
const got = first + second + third;
check(first.includes("more update") && first.includes("waiting, whole"), "a batch too big for one result says the rest is waiting");
check(["B1", "B2", "B3", "B4"].every((t) => got.split(`${t} ends here.`).length === 2 && got.includes(long(t, 20_000))), "every long reply arrives whole, exactly once, over the calls");
check(got.includes(long("ANSWER", 9_000)) && got.includes("Q ends here."), "a long answer and its question arrive whole");

// News is confirmed: what the app says it didn't receive comes again.
await call("watch_sessions", { sessions: ["login gates"], mode: "only" });
await call("wait_for_updates", { seconds: 5 });
await sdp.post("/event", { kind: "finished", text: "CONFIRM-ME", forApp: true });
await Bun.sleep(300);
const got1 = await call("wait_for_updates", { seconds: 5 });
const num = Number(got1.match(/Updates (\d+)-/)?.[1]);
const again = await call("wait_for_updates", { seconds: 5, heard: num - 1 });
check(got1.includes("CONFIRM-ME") && again.includes("CONFIRM-ME"), "news the app says it didn't receive comes again");
const done = await call("wait_for_updates", { seconds: 5, heard: Number(again.match(/heard: (\d+)/)?.[1]) });
check(!done.includes("CONFIRM-ME"), "news the app confirmed doesn't come again");

// A wait the app gave up on leaves its news for the next call.
const held = rpc("tools/call", { name: "wait_for_updates", arguments: { seconds: 20 } });
const heldId = n;
await Bun.sleep(400);
await fetch(`${BASE}/${id}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: heldId } }) });
const cancelled = await held;
await sdp.post("/event", { kind: "finished", text: "AFTER-CANCEL", forApp: true });
await Bun.sleep(300);
r = await call("wait_for_updates", { seconds: 5 });
check(JSON.stringify(cancelled).includes("cancelled") && r.includes("AFTER-CANCEL"), "a cancelled wait ends without taking news");

// The inbox: an unwatched session's turn arrives thin (no text) and shows as unheard.
await call("watch_sessions", { sessions: [], mode: "only" });
await nav.post("/event", { kind: "finished", thin: true });
await Bun.sleep(300);
r = await call("list_sessions");
check(/"unheard":1/.test(r), "a turn the app didn't hear shows as unheard");
await call("read_session", { session: "claude bridge v4" });
r = await call("list_sessions");
check(!r.includes('"unheard"'), "reading the session clears its unheard count");

// A session whose folder moves after it starts (the desktop app's spare folder) reports the move.
await nav.post("/state", { working: false, side: false, asking: 0, folder: "/Users/x/Moved", project: "Moved" });
await Bun.sleep(300);
r = await call("list_sessions");
check(r.includes('"project":"Moved"'), "a session's folder move updates its project");

// Reports: read whole, then removed once dealt with.
const kept = await (await fetch(`${BASE}/api/reports`, { headers: { Authorization: `Bearer ${key}` } })).json() as any;
const report = kept.reports?.find((x: any) => x.text === PARAGRAPH.trim());
check(!!report && Object.keys(report).sort().join(",") === "at,id,text", "GET /api/reports gives the paragraph whole, with only its id and time");
const removed = await (await fetch(`${BASE}/api/reports/${encodeURIComponent(report?.id ?? "x")}`, { method: "DELETE", headers: { Authorization: `Bearer ${key}` } })).json() as any;
const left = await (await fetch(`${BASE}/api/reports`, { headers: { Authorization: `Bearer ${key}` } })).json() as any;
check(removed.removed === true && left.reports.length === 0, "a report dealt with can be removed");

// The diagnostic log.
const diag = await (await fetch(`${BASE}/api/diag`, { headers: { Authorization: `Bearer ${key}` } })).json() as any;
check(Array.isArray(diag.calls) && diag.calls.some((c: any) => c.tool === "wait_for_updates" && typeof c.ms === "number"), "GET /api/diag lists recent calls with how long they took");

for (const c of [nav, sdp, ...opened]) c.p.kill();
mac.close();
mini.close();
await Bun.sleep(500);
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
