# Protocol

Version **4**. Every message is a JSON object.

## Session ⇄ relay (WebSocket)

The connector opens `wss://<relay>/chat/connect` with `Authorization: Bearer <key>`. The device agent connects the same way (see below).

### Session → relay

| Message | When |
| --- | --- |
| `{ "type": "hello", "protocol": 4, "session": "<id>", "project": "<name>", "folder": "<path>", "device": "<device id>" }` | First message. |
| `{ "type": "state", "working": bool, "side": bool, "asking": n, "parent"?, "runsIn"?, "terminalApp"?, "model"?, "effort"?, "task"? }` | What the session is doing (`asking`: questions to `ask` still being answered with tools), for `list_sessions` and `wait_for_updates`; sent on connect and on change. |
| `{ "type": "event", "kind": …, "forApp"?, "messages"?, … }` | News for the feed; see below. |
| `{ "type": "watch", "watched": bool }` | Add this session to the watch list, or take it off. |
| `{ "type": "pause", "paused": bool }` | Pause Claude Bridge for the whole account, or resume it. |
| `{ "type": "result", "id": <n>, "result": <MCP tool result> }` | Answer to a `call`. |
| `{ "type": "ping" }` | Every 30 s; answered `{ "type": "pong" }` by the runtime. |

### Relay → session

| Message | When |
| --- | --- |
| `{ "type": "welcome", "watched": bool }` | After `hello`. |
| `{ "type": "watched", "watched": bool }` | When this session is added to or taken off the watch list. |
| `{ "type": "paused", "paused": bool }` | When the account is paused or resumed (also in `welcome`). |
| `{ "type": "call", "id": <n>, "tool": "<name>", "args": { … } }` | A tool call from the Claude app. |
| `{ "type": "error", "message": "…" }` | A refused `hello` (protocol mismatch). |

Close codes: `4001` replaced by a newer connection of the same session (or device), `4002` bad hello.

### Events

Every event may carry `forApp: true` (news the app asked for: passed on even from sessions it doesn't
watch) and `messages` (the ids of the app's messages the turn carries, as `send_message` returned
them).

| `kind` | Fields |
| --- | --- |
| `started` | `text`: what the turn was asked. |
| `finished` | `text`: the reply; `task`; `changes`: files edited and commands run; `pictures`?: `[{ data, mimeType, caption? }]` (base64, at most about 900 kB together). |
| `question` | `questions`: as AskUserQuestion asked them. |
| `stopped`, `failed` | `task`. |
| `answer` | `ask`: the side question's id; `question`; `text`: the answer. |

## Session ⇄ relay without helper programs (HTTP)

A session that can't run the connector speaks the same messages over HTTP, with the same
`Authorization: Bearer <key or credential>`.

| Request | Body | Answer |
| --- | --- | --- |
| `POST /peer` | `{ hello, messages, wait }` | `{ messages }`: what came for the session. |
| `POST /peer/answer` | `{ id, value }` | `{}`: puts an answer to a question. |
| `POST /peer/answer` | `{ id, seconds }` | Waits up to 25 s: `{ value }` or `{ pending: true }`. |

- **`/peer` fields:**
  - `hello` is the session's hello, sent with every request, so a relay that restarted knows the
    session again (it answers `welcome` anew). It adds `serveDevice: true` and `name` (the
    computer's name): the session then answers the device agent's calls for its computer.
  - `messages` are the session's messages (`state`, `event`, `watch`, `pause`, `result`).
  - `wait` (seconds, at most 25) holds the request until something comes. The session keeps one
    such request waiting at all times, and sends with `wait: 0`.
- **The relay forgets a polling session** 60 s after its last request.
- **The `id` of `/peer/answer`** is the session's id and the question's id (`<session>:<question>`):
  the mailbox is shared by the whole account.

## Device agent ⇄ relay (WebSocket)

Same endpoint and key. Settings come from `~/.config/claude-bridge/`: `key`, `device.json`
(`{ id }`), and `config.json` (`{ chatUrl, screen?, openIn?, terminalApp? }`, written by the plugin). `open_in` is `desktop` or `terminal`; without it, `openIn`, else the desktop app if it is installed.

| Message | Direction | When |
| --- | --- | --- |
| `{ "type": "hello", "role": "device", "protocol": 4, "device": "<id>", "name": "<ComputerName>", "host": "…" }` | → relay | First message. |
| `{ "type": "welcome", "name": "<the person's name for it>" }` | ← relay | After `hello`. |
| `{ "type": "call", "id": <n>, "tool": "<call>", "args": { … } }` | ← relay | A request; answered with `{ "type": "result", "id": <n>, "result": { … } }`. |
| `{ "type": "ping" }` | → relay | Every 30 s. |

| Call | Args | Result |
| --- | --- | --- |
| `projects` | `{ limit }` | `{ projects: [{ folder, name, lastActive, sessions }] }` |
| `sessions` | `{ folder, limit }` (≤ 15) | `{ sessions: [{ id, name, lastActive, archived?, side? }] }`, newest first |
| `names` | `{ sessions: [{ id, folder }] }` | `{ names: { <id>: <name> } }` |
| `rename_session` | `{ id, folder, name }` | `{ renamed }` |
| `open_session` | `{ id, folder, open_in? }` | `{ opened }` |
| `start_session` | `{ folder, name?, open_in? }` | `{ id, opened }` |
| `fork_session` | `{ id, folder, name?, open_in?, terminal_app?, model?, effort? }` | `{ id, opened }`: a side chat holding a copy of `id`'s conversation, on that model and effort |
| `screenshot` | `{}` | `{ data, mimeType }` |

Any call can answer `{ error }`.

## Linking a computer

A computer with no credential offers a code (12 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`)
and waits; the Claude app approves it with `link_computer`.

| Request | Answer |
| --- | --- |
| `POST /link/<code>` | `{ ok, expires }`: the code is good for ten minutes. |
| `GET /link/<code>` | Waits up to 25 s: `{ credential }` once (a `cbd_<account id>_<secret>` of its own), else `{ pending: true }`, or `{ expired: true }`. |

The computer then connects with `Authorization: Bearer <credential>`. The account's hub keeps
only the SHA-256 of each credential's secret, so a credential can be checked and revoked alone.

## Plugin ⇄ connector

The plugin starts the connector with one JSON object on stdin:

```json
{ "relay": "wss://…/chat/connect", "key": "cbrg_…", "session": "…", "project": "…", "folder": "/path/to/project", "socketPath": "/tmp/claude-bridge-….sock", "device": "<device id>" }
```

### Connector → plugin (JSON lines on stdout)

| Event | Meaning |
| --- | --- |
| `{ "t": "started", "pid": n }` | Running. |
| `{ "t": "link", "state": "connecting" \| "connected" \| "offline", "watched": bool }` | Connection, and whether the app watches this session. |
| `{ "t": "tool", "id": "b1", "name": "…", "args": { … } }` | A call to answer. |
| `{ "t": "error" \| "log", "message": "…" }` | Diagnostics. |

### Plugin → connector (HTTP POST on the Unix socket)

| Route | Body | Does |
| --- | --- | --- |
| `/tool_response` | `{ id, response }` | Sends the answer to a `tool` event back to the app. |
| `/state` | `{ working, side, asking, task? }` | Reports what the session is doing. |
| `/event` | an event, as above | Sends news to the feed (held while offline). |
| `/watch` | `{ watched }` | Adds or removes this session from the watch list. |
| `/pause` | `{ paused }` | Pauses or resumes the whole account; `{ ok: false }` while not connected. |
| `/answer` | `{ id, value }` | Answers a waiting question. |
| `/wait_answer` | `{ id, seconds }` | Long poll: resolves `{ value }` or `{ pending: true }`. |
| `/ping` | `{}` | `{ connected, watched }`. |
| `/stop` | `{}` | Exits. |

## Added in 1.7.0

- **Link codes** carry the computer's own secret: `POST /link/<code>` and `GET /link/<code>` both
  send `X-Link-Secret` (32 to 128 URL-safe characters); the relay keeps only its SHA-256 and hands
  the credential only to the same secret.
- **`GET /api/diag`** with the account key: the hub's last 200 tool calls (tool, start, milliseconds
  held, how it ended).
- **Events:** `finished`, `stopped` and `failed` may be `thin: true` (no text: a turn the app
  neither asked for nor watches); `question` may carry `permission: true` (Allow / Deny); new kind
  `waiting` (`text`: what Claude Code waits on at its screen).
- **MCP:** `notifications/cancelled` ends the named `wait_for_updates` without marking news heard;
  so does the app hanging up (`request.signal`).

## Added in 1.8.0

- **`report_problem`** (tool): `{ paragraph }`, kept as `report:<time>-<random>` → `{ at, text }`.
- **`GET /api/reports`** with the account key: `{ reports: [{ id, at, text }] }`, oldest first.
  **`DELETE /api/reports/<id>`** removes one: `{ removed }`.
- **`get_instructions`** (tool): the person's instructions for the assistant, `{ instructions, updated }`.
  **`GET /api/instructions`** and **`PUT /api/instructions` `{ text }`** with the account key or a
  linked computer's credential: the panel reads and saves them (`customInstructions` in the hub).

## Added in 1.9.1

- **`POST /api/admin/census`** `{ ids: [...] }` (at most 200 Durable Object ids, as Cloudflare's API
  lists them) with `Authorization: Bearer <ADMIN_TOKEN>`: what each object is, in counts only
  (`account` with how many computers it knows, how many are linked, online, open sessions, the date
  of its last news; `link-code`, expired or not; `empty`). No messages, names or keys. Off (404)
  unless the relay's operator sets the `ADMIN_TOKEN` secret (`wrangler secret put ADMIN_TOKEN`, 32+
  characters). `GET /api/status` also gives the account hub's own `objectId`, to find it in a census.
