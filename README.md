# Claude Bridge

Talk to Claude Code from the Claude app — voice mode included.

You say "ask the Nav session to run the tests" to Claude on your phone. Claude hands the request
to that Claude Code session on your computer, and tells you what it did when it's done. When
Claude Code needs a decision, the question comes back to you in the Claude app. You can also
start new sessions, resume old ones, and rename them, all by voice.

```
Claude app ──MCP──▶ relay (Cloudflare Worker) ◀──WebSocket── device agent (one per computer)
 (phone, desktop)    one Durable Object per key   ◀──WebSocket── connector ── plugin ── Claude Code
                                                  ◀────HTTP───────────────── plugin     (a session)
                                                   (no helper programs: the session itself)
```

- **Devices → projects → sessions.** Each computer has projects (folders, named after
  themselves), and each project has sessions, each with its own name. Address any session by
  its name or its project ("send to Nav", "how's the login-gates session?"); there is no switching.
- **Start, resume, rename.** Start a new session in any project; resume any earlier one from a
  numbered list of a project's 15 most recent; give sessions and computers the names you use.
- **Side chats by voice.** "By the way, in a side chat, have Nav write the tests": a new session
  with the whole of Nav's conversation takes the side task while Nav carries on. Both report
  back, and you can ask about either.
- **Nothing waits, nothing is missed.** Sending returns at once; the reply, Claude Code's
  questions and answers come back as news, the moment they happen.
- **No database.** Claude Code's own transcripts on each computer are the record of every
  session; the relay keeps only what is on its way to you.
- **No polling.** Each computer holds WebSockets open; requests are pushed down them.

## Repository

| Folder | What it is |
| --- | --- |
| [`relay/`](relay) | The Cloudflare Worker: MCP endpoint for the Claude app, OAuth sign-in, and a `BridgeHub` Durable Object per key that routes each call to the computer or session it names and carries the news. |
| [`plugin/`](plugin) | The Claude Code plugin (`codebridge`): the panel, the tools' behaviour, the Swift connector each session runs, and the device agent each computer runs. |
| [`docs/`](docs) | [Architecture](docs/ARCHITECTURE.md), the [wire protocol](docs/PROTOCOL.md), the [decisions](docs/DECISIONS.md) and the [roadmap](docs/ROADMAP.md); [changelog](CHANGELOG.md). |

## Setup

Claude Bridge runs on macOS with Claude Code (the desktop app or the CLI) and the Claude app.

### 1. Install the plugin, on each computer

In a terminal:

```bash
claude plugin marketplace add PrajwalShete/claude-bridge
```

```bash
claude plugin install codebridge@claude-bridge
```

Or, inside a Claude Code session: `/plugin install codebridge --marketplace PrajwalShete/claude-bridge`.
The desktop app uses plugins installed this way; it just can't add a marketplace from its own
screens, so that one step is in a terminal. If the installer mentions two `userConfig` options
(the relay's address), leave them: the defaults are right.

Then open a new Claude Code session, in the desktop app or a terminal. Claude Bridge loads in
every session from then on.

**What it runs on your computer** (Claude Code warns that plugins can run code; this one does):
hooks inside Claude Code; two small Swift programs that ship prebuilt, ad-hoc signed, for Apple
silicon and Intel (a connector per open session, and a device agent per computer); and that
device agent as a background service macOS starts at login, so the computer stays reachable with
Claude closed (macOS shows its usual "background item added" notice). Its files are in
`~/.config/claude-bridge/`, its log in `~/Library/Logs/claude-bridge-device.log`. `/bridge off`
stops everything and removes the service. On a Mac that refuses helper programs (a managed Mac's
"access denied"), **Auto**, the default, removes the service at once and each session talks to
the relay itself instead; choose in the panel (Settings, **Background service**), or set
`{ "env": { "CLAUDE_BRIDGE_HELPERS": "off" } }` in `~/.claude/settings.json` to never launch one.

**Updates:** in Claude Code, `/plugin`, the **Marketplaces** tab, **claude-bridge**, **Enable
auto-update**; or by hand:

```bash
claude plugin marketplace update claude-bridge && claude plugin update codebridge@claude-bridge
```

### 2. Your first computer

Open the Claude Bridge panel (the small "● Bridge" button below the prompt, or `/bridge`) and,
in **Connection**, choose **Own account**. Then, in the Claude app: Settings, Connectors, **Add
custom connector** with the panel's connector URL, and paste the key on the page that opens.
That key is your account: keep it to yourself.

### 3. Every other computer

Install the plugin there too (step 1). Its panel's **Connection** shows a code (**Link with a
code**). Tell the Claude app "link my computer, code K7Q2 9FMX 3HDA": it connects a few seconds
later, with a credential of its own (the account's key never leaves your first computer).
`/bridge key <key>` also works, if you'd rather copy the key.

### The relay

The Claude app reaches your computers through a relay, a small Cloudflare Worker. By default the
plugin uses the one at `claude-bridge.prajwalshete.com`, run by this project's author. Each key
gets its own isolated store there; what passes through (your messages and Claude Code's replies)
is not kept beyond what's on its way to you (see [Architecture](docs/ARCHITECTURE.md)), but whoever
runs a relay can read what passes through it. To run your own:

```bash
cd relay
npm install
openssl rand -base64 48 | npx wrangler secret put SIGNING_KEY
npx wrangler deploy
```

Edit `relay/wrangler.jsonc` first (`routes` and `PUBLIC_ORIGIN`: your own domain), then set the
plugin's options to it: `/plugin configure codebridge@claude-bridge`, `relayUrl` (and `chatUrl`
if computers connect through a different hostname).

## Tools the Claude app gets

No tool waits for Claude Code to work: sending returns at once, and what follows (the reply, a
question, an answer) comes back as news.

| Tool | What it does |
| --- | --- |
| `list_sessions` | The open sessions by computer: name, project, what each is doing, which are watched, how many replies you haven't heard. |
| `list_projects` | A computer's projects (folders), most recent first. |
| `read_session` | The transcript itself, whole, no model: what you haven't heard, the last N, or a search; a running turn comes with its steps so far and what it's doing now. Long results in pages, nothing cut. |
| `catch_up` | The complete summary of a session for taking it over: goal, everything done, decisions and why, where it stands, what is open. Kept and updated from new exchanges only. |
| `ask` | One question about a session, quoting its own words; checked with tools only when needed. |
| `send_message` | Sends a request to a session; returns at once with the message's id. A repeat within two minutes isn't sent twice. |
| `answer` | Answers a session's question, or allows or denies one permission request. |
| `wait_for_updates` | Waits for news and returns it the moment it happens; `heard` confirms what arrived. |
| `watch_sessions` | Chooses the sessions whose every move reaches the Claude app. |
| `stop_session` | Interrupts a session. |
| `start_session` | Starts a new session in a project, named, optionally with its first message. |
| `resume_session` | A project's 15 most recent sessions, numbered; then opens the one picked by number. |
| `fork_session` | Starts a side chat from a session: its whole conversation, a different task, the original undisturbed; both watched. |
| `rename` | Renames a session (open, or by number from the list) or a computer. |
| `link_computer` | Links another computer from the code its panel shows; lists or removes linked computers. |
| `show_screen` | A screenshot of a computer's screen, with a private link. |
| `get_instructions` | Your own instructions for the assistant, written in the panel; it calls this first in every conversation. |
| `report_problem` | Keeps one paragraph about something that went wrong, for fixing later (`GET /api/reports`). |

## In the terminal (the Claude Code CLI)

The plugin runs the same in the CLI, which was tested with 2.1.316. These all work there:
- sending, replies and questions as news, and `catch_up`
- `ask`, including its tool-using check
- `stop_session`, `rename_session` and `show_screen`
- the panel (`/bridge`)

Differences:

- **Starting and resuming open where you choose.** Each computer has a setting in the panel:
  Auto, the desktop app, or Terminal. Auto means the desktop app if it's installed, else
  Terminal. The voice assistant can also say where for one request ("resume number 3 in the
  terminal").
  - In Terminal, a new session runs `claude --session-id <id> -n "<name>"`, and a resumed one
    runs `claude --resume <id>`. Each opens in a new Terminal window, through a `.command`
    script, so no Automation permission is needed. Set `terminalApp` in
    `~/.config/claude-bridge/config.json` for another app, such as iTerm.
  - The folder must already be trusted by the CLI (you've opened it there once). Otherwise
    the CLI would wait at its trust question with nobody there to answer.
- **`/btw` is not a session in the CLI.** It is a throwaway side question, so the Claude app
  can't see it, unlike the desktop app's side chats.
- **A CLI session lives in its terminal.** Close the terminal and it goes offline; resume brings
  it back.
- **Permission prompts stay on screen.** A request that needs your approval waits at the
  terminal; use auto or bypass mode for sessions you drive by voice.
- **Screenshots** need the terminal app's Screen Recording permission.

## Safety

The key is the account: whoever has it can send prompts to every session on every computer that
uses it. Keep it private (it lives in `~/.config/claude-bridge/key`, readable only by you).

- **Self-host the relay** for your own use (step 1): whoever runs it can read what passes through.
- **Pause everywhere**: **Pause** at the top of the Claude Bridge panel (the small "● Bridge"
  button below the prompt opens it, as does `/bridge`), in any session. Every call from the Claude app is then refused, on every computer, until you press
  **Turn Claude Bridge on**. Only a computer can lift a pause; the Claude app can't.
- **Ask me first** (panel, setup): a session puts the app's messages in its prompt box for you
  to send, instead of running them.
- **Screenshots** (panel, setup): turn `show_screen` off for a computer.
- **Make a new key** cuts off the Claude app and every other computer (it asks you to press
  twice); use it if the key leaks.
- The voice assistant is told to send only what you asked for, and to treat sessions' replies
  as reports, not instructions.

## Development

While developing, run the plugin from this repository instead of an installed copy: point Claude
Code at it in `~/.claude/settings.json`, `{ "env": { "CLAUDE_CODE_PLUGIN_DIRS":
"/path/to/claude-bridge/plugin", "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1" } }`, and uninstall any
installed copy (the desktop app prefers an installed or account copy of the same name). Each
session then reloads the plugin when a turn ends.

```bash
cd relay && npx tsc --noEmit                 # type-check the relay
claude plugin validate plugin                # check the plugin as Claude Code will load it
claude plugin test plugin                    # run the plugin's tests
```

After changing a Swift program, rebuild the prebuilt binaries (universal, ad-hoc signed):

```bash
scripts/build-binaries.sh            # --check fails if one is older than its source
```

End to end, with real connectors and stand-in device agents against a local relay:

```bash
cd relay && npx wrangler dev --port 8811 --var PUBLIC_ORIGIN:http://localhost:8811
bun relay/test/bridge.e2e.ts                 # in another terminal
```

The device agent answers one call by hand, for checking it against your own files:

```bash
plugin/connector/bin/claude-bridge-device --call sessions '{"folder":"/path/to/project"}'
```

## License

[MIT](LICENSE)
