# Architecture

Claude Bridge has four parts. Each can be replaced on its own as long as it keeps the
[protocol](PROTOCOL.md).

```
┌────────────┐  MCP (Streamable HTTP)  ┌──────────────────────────────┐  WebSocket   ┌──────────────┐
│ Claude app │ ──────────────────────▶ │ relay: Worker + BridgeHub DO │ ◀─────────── │ device agent │  one per computer
└────────────┘   OAuth 2.1 (PKCE)      │   one Durable Object per key │              └──────────────┘
                                       │                              │  WebSocket   ┌───────────┐  JSON lines /  ┌────────┐
                                       │                              │ ◀─────────── │ connector │ ◀────────────▶ │ plugin │ ── Claude Code
                                       └──────────────────────────────┘              └───────────┘  Unix socket   └────────┘    (a session)
                                                                                     one per open session
```

## The model: devices → projects → sessions

- A **device** is a computer. It has an id (`~/.config/claude-bridge/device.json`, made once)
  and a name: its own (macOS's ComputerName) until the person gives it one (`rename_device`,
  kept in the hub).
- A **project** is a folder Claude Code has worked in, named after the folder.
- A **session** is a Claude Code conversation in a project. Its name is the one the person gave
  it (`rename_session`). Without one, it's the desktop app's title, then Claude Code's own title,
  then its first prompt.

Nothing about sessions is stored by Claude Bridge. Claude Code keeps every session's transcript
on its computer (`~/.claude/projects/<folder>/<id>.jsonl`), and the desktop app keeps its own
records beside them. The device agent reads both, and a rename is written into the transcript
itself (a `custom-title` row, as the Agent SDK's `renameSession` and the desktop app do).

## Relay (`relay/`)

A Cloudflare Worker.

- **MCP endpoint** `/<id>/mcp`: the connector URL the Claude app adds. The Worker answers
  `tools/list` from a fixed list ([`tools.ts`](../relay/src/tools.ts)), so the app sees the
  tools even while every computer sleeps. `tools/call` goes to the account's hub.
- **OAuth**: dynamic client registration, PKCE, and signed (not stored) codes and tokens. To
  sign in, the person pastes the key. The URL's `<id>` is the first 20 hex characters of
  SHA-256(key), so the key proves ownership of the URL.
- **BridgeHub**: one Durable Object per key, that is, per account. Every device agent and every
  open session holds a hibernatable WebSocket to it. It routes each call to the session or
  computer it names, and holds the HTTP request until the answer comes back. That is at once
  for nearly every tool; `catch_up`, `ask`, `start_session` and `resume_session` take a model
  call's time or a session's start-up. It keeps only:
  - the watch list
  - device names
  - a short feed of news on its way to the app (dropped once heard and an hour old)
  - the last numbered history it showed
  - pictures, for an hour

### Scaling

- Each account is its own Durable Object: accounts never contend, and Cloudflare places each
  near the computers that connect to it.
- WebSockets hibernate: an idle session or device costs no compute; the runtime answers pings
  without waking the object.
- The Worker keeps nothing between requests, so it scales with Cloudflare's edge.

## Device agent (`plugin/connector/device.swift`)

A small native program per computer, started from inside Claude, never by launchd:
- **A session starts it,** so macOS counts it as part of Claude and Claude's permissions are its
  own. Its responsible process is Claude Code's.
- **One copy per computer:** it holds `~/.config/claude-bridge/device.lock`, and a second copy
  exits.
- **It outlives the session that started it,** in a process group of its own.
- **It lives as long as Claude does:** it watches the Claude desktop app (or, from a terminal,
  the session that started it) and quits with it.

Each session checks every 30 s that it runs. The next session after a quit starts it again, and
a new build of it replaces the running one. A launchd agent from earlier versions is removed,
since a managed Mac may block one as a separate background item.

While Claude runs, it keeps the computer reachable with no session open, and answers what only
the computer knows:

| Call | Does |
| --- | --- |
| `projects` | The folders Claude Code has worked in, most recent first (from the transcripts and the desktop app's records; its scratch folders left out). |
| `sessions` | A project's recent sessions, newest first, with names; transcripts a desktop session has moved past (after a rewind) left out. |
| `names` | What given live sessions are called. |
| `rename_session` | Appends a `custom-title` row to the session's transcript. |
| `open_session` | Opens a session where the person works. In the Claude desktop app: `claude://code/continue?session=<desktop id>` for a session the app knows, else `claude://resume?session=<id>`, which imports it. In a terminal: `claude --resume <id>` in a new window. |
| `start_session` | Starts a new session: see below. |
| `screenshot` | The screen, when no session is open to take it. |

**Where sessions open.** Each computer has a setting (`openIn` in `config.json`, set in the
panel): Auto (the desktop app if it is installed, else Terminal), the desktop app, or Terminal.
A call can choose instead (`open_in`). Terminal windows open through a `.command` script run
with `open -a Terminal` (or `terminalApp`), which needs no Automation permission. The script
runs the person's own `claude` from their login shell, or the one the desktop app ships. A
folder the CLI hasn't trusted (it or a folder above it, in `~/.claude.json`) is refused, since
the CLI would wait at its trust question with nobody there to answer it.

**Starting a session in a terminal** is direct: `claude --session-id <id> -n "<name>"`. The
plugin connects as the session starts, and the first message goes in through the normal path.

**Starting a session in the desktop app.** The desktop app's `claude://code/new` link only fills its composer;
nothing is sent. So the agent asks Claude Code to make the session, under an id it chooses
(`claude -p --session-id <id>`), with one short first turn that says it was started from the
Claude app. Then it opens `claude://resume?session=<id>`: the desktop app imports the session
and runs it, its plugin connects, and the person's real first message goes in through the
normal path. That way the first task runs visibly, in the desktop app's own permission mode,
with live progress and questions.

Only folders Claude Code has already worked in can get a new session. A brand-new folder
starts on the computer.

## Getting it onto a computer

The plugin is saved to the person's Claude account once and syncs to every computer signed in
to it. Its two Swift programs ship prebuilt (universal, ad-hoc signed, stamped with their
source's SHA-256), so a computer needs no Xcode: the plugin copies the matching one into
`~/.config/claude-bridge/bin/` and builds from source only when a source changed.

A computer joins the account by **linking**: with no credential, it shows a code; the person
reads it to the Claude app (`link_computer`), and the relay hands that computer a credential of
its own, `cbd_<account id>_<secret>`, through a short-lived hub named after the code. The
account's hub keeps only the hash of each credential's secret and checks it on every connect.
The account's key, which the Claude app signs in with, stays on the first computer.

## Connector (`plugin/connector/connector.swift`)

A small native process for each open session. The plugin builds it with `swiftc` on first use.
It keeps the session's WebSocket to the relay alive (pings every 30 s, reconnects with backoff),
turns the relay's calls into `tool` events on stdout, and sends the plugin's answers back. It
also holds the answer mailbox that Claude Code's questions wait on, and it exits when its
session goes away. The plugin runtime has no sockets, so this process is how a session reaches
the network.

## Plugin (`plugin/`)

A Claude Code plugin of function hooks.

| File | Responsibility |
| --- | --- |
| `register.tsx` | Wires the hooks: session start and end, `/bridge`, turn tracking, tool tracking, questions, drawing. |
| `connector.ts` | The connector process, the account's key (`~/.config/claude-bridge/key`), the connector URL, building the Swift programs. |
| `device.ts` | This computer's id, its settings, and installing and updating the device agent. |
| `tools.ts` | The session tools the Claude app calls, each answered at once. |
| `claude.ts` | Submitting prompts reliably, and reading what Claude Code did and is doing. |
| `catchup.ts` | `catch_up`: status, brief, exchanges, files touched. |
| `side.ts` | `ask`, and the session's brief. |
| `questions.ts` | Claude Code's questions answered from the app or the panel. |
| `images.ts` | Screenshots and pictures Claude Code shares. |
| `view.tsx` | The panel (Bridge, Connect the Claude app, Settings, and the Claude app's messages, answered or not), and the small Bridge button in the prompt's footer that opens it. |
| `state.ts` | Shared values and runtime. |

### Addressing sessions

There is no active session. Every session tool takes `session`: the session's name, its
project's name as the person says it ("SD Paithani" finds `SdPaithani`), or an id. `device`
narrows it when more than one computer is in play. It can be left out when exactly one session
is watched, or exactly one is open. When a name fits several sessions, the order is:
1. a watched one
2. a main session over side chats
3. otherwise, the call asks which, listing the candidates

### Side chats

`fork_session` gives a session a side chat: a new session holding a copy of its whole
conversation, for a different task, while the original carries on undisturbed, even mid-turn.
1. The device agent runs `claude -p --resume <id> --fork-session --session-id <new id>` with a
   short first message. That message tells the side chat what it is and which session it came
   from, and to leave that session's work alone.
2. The agent names the new session (default: "<project> side: <the task's first words>") and
   opens it where the person works.
3. The relay watches both sessions, then sends the side task.

A side chat opens where its original runs (the desktop app, or the same terminal app), on the
model and effort the original is on at that moment. The relay asks the original when forking.
Then:
- The headless fork step and any Terminal window get `--model`/`--effort`.
- The side chat's first message records both, and its plugin applies them once with `/model` and
  `/effort`. The desktop app keeps a forked session's model, but not its effort.

The original is only read, so nothing in it changes. The side chat is a session like any other:
it has a name, catches up and answers `ask`, asks questions, can be stopped and renamed, and
outlives its original. Its plugin reads the first message, so it reports itself as a side chat
along with its original's id, and `list_sessions` shows `forkedFrom`. Asked for by project
name, the relay picks the watched main session over its side chats.

Desktop side chats ("btw") are the same kind of session and the bridge reaches them too. The
CLI's `/btw` is different: a throwaway answer with no session behind it.

### Resuming by number

`resume_session` with a project lists that project's sessions, newest first, numbered, at most
15. It goes by count, not dates: the voice assistant reads the list out and the person picks a
number. The hub keeps that list for an hour, so "number 3" means the session that was read out.
A number for a different project than the last list is refused. There is no search by date or
topic: answering "what was I doing on Friday" would mean reading old sessions' whole context
again, uncached, at full price.

### News

Each session sends events: started, finished (with the reply, what changed and any pictures),
question, stopped, failed, and answers to `ask`. The app gets:

- everything from the sessions it watches, from the moment it started watching them;
- from any session, what it asked for: the turns that carry its messages (finished, stopped,
  failed, and the questions they raise) and the answers to its questions (marked `forApp`).

News is appended to the next tool result the app gets, once, labelled as reports rather than
instructions. `wait_for_updates` holds a call open until news arrives. News a session makes
during a call to that same session waits for the next result. The Claude app calls connectors
from Claude's servers and starts a fresh MCP session for each call, so nothing tells a phone
from a desktop: there is one stream of news per account.

### Sending, and matching replies to messages

Nothing waits for Claude Code to work. `send_message` submits the prompt and returns at once:
- `sent`: its turn began
- `queued`: Claude Code is busy and takes it next
- `not sent`: Claude Code refused it, or the session is set to **ask first**; the message is
  left in the prompt box

Each message has an id. `$.prompt.submit` resolves the moment the prompt's turn starts, and a
plugin's prompt runs only once the session is idle, so no other turn can start in between: that
is when the id joins the running turn. Should the resolution come first, the next turn start
takes it. A plugin's own hooks never see the prompts it submits, so a marker in the text would
reach the model; the submit's resolution is the reliable link.

### Sharing the session's context

- `catch_up` (`catchup.ts`) is the main one: everything needed to carry on. The brief (goal,
  what was done, decisions and why, open questions) is written by a fork of the session
  (`$.model.fork`), refreshed after the turns the app may catch up on and again on demand when
  stale. Around it is exact data from the transcript: the status now, the last several
  exchanges (each marked as typed on the computer or sent from the app), and the files touched.
- `ask` (`side.ts`) answers one question, for exact details a brief would paraphrase. First
  comes one pass over the session's own transcript (`$.model.fork`: no tools, the session's
  prompt cache, seconds) that quotes the session's words. Only if the answer needs files read
  or something checked does a fork with every tool take over (`$.agent.spawn`, type `fork`).
  That call returns at once, and the fork's `turn.complete` becomes an `answer` event.

### Pictures

Pictures Claude Code shares (`share_image`) go with its reply's `finished` event. `show_screen`
asks an open session on that computer, which has Claude Code's Screen Recording permission,
else the device agent. The hub keeps each picture for an hour under an unguessable link, and
gives the app the link, since voice mode drops image content.

### Pausing

**Pause everywhere** in the panel pauses the whole account, from any session.
The relay keeps the switch:
- While it's on, every call from the Claude app is refused with a message saying so, and news is
  dropped rather than kept.
- Every session hears the change at once (`paused`): every panel shows it, and Claude Code's
  questions stay on screen.
- Sessions and device agents stay connected, which is free and makes resuming instant.
- Only a session can resume it: a pause the app could lift would protect nothing.

The panel's **Connection** switch and `/bridge off` remain the full local shutdown, which
disconnects everything.

### Reliability

- A prompt Claude Code refuses (after the person interrupts, for example) goes into the prompt
  box, and the app is told to have the person press Enter. It is never reported as sent.
- A repeat of the same message within 20 s is not sent twice.
- A new message is refused while Claude Code waits on a question.
- A crashed connector is restarted; every session checks every 30 s that the device agent runs.
- Sessions starting together build the Swift programs into separate files and move them into
  place, so they never overwrite each other's build.
