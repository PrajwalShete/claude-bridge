# Claude Bridge

Talk to Claude Code from the Claude app — voice mode included.

You say "ask the Nav session to run the tests" to Claude on your phone. Claude hands the request
to that Claude Code session on your computer, and tells you what it did when it's done. When
Claude Code needs a decision, the question comes back to you in the Claude app. You can also
start new sessions, resume old ones, and rename them, all by voice.

```
Claude app ──MCP──▶ relay (Cloudflare Worker) ◀──WebSocket── device agent (one per computer)
 (phone, desktop)    one Durable Object per key   ◀──WebSocket── connector ── plugin ── Claude Code
                                                                (Swift, one per session)  (a session)
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

### 1. Deploy the relay (once)

```bash
cd relay
npm install
openssl rand -base64 48 | npx wrangler secret put SIGNING_KEY
npx wrangler deploy
```

Edit `relay/wrangler.jsonc` first: set `routes` and `PUBLIC_ORIGIN` to your own domain.

### 2. Install the plugin

Requires macOS with Xcode's command line tools (the connector and the device agent are built
on first use) and the Claude desktop app (sessions are started and resumed in it).

Point Claude Code at the plugin folder in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-bridge/plugin" } }
```

Set your relay in the plugin's options (`relayUrl`, and `chatUrl` if sessions should connect
through a different hostname).

The first session installs the **device agent**, a launchd agent
(`~/Library/LaunchAgents/com.claudebridge.device.plist`, log in
`~/Library/Logs/claude-bridge-device.log`) that keeps the computer reachable with no session
open. `/bridge off` stops it.

### 3. Connect the Claude app

1. In Claude Code, type `/bridge` to open the panel.
2. In the Claude app: **Settings → Connectors → Add custom connector**, and paste the URL from
   **Copy connector URL**.
3. Click **Connect** and paste the key from **Copy key**.

### 4. More computers

On each other Mac, install the plugin the same way, then in any Claude Code session there:

```text
/bridge key <the key from Copy key on your first computer>
```

It joins the same account: the Claude app reaches its sessions too, and asks which computer
when a project exists on more than one. Name computers with `rename_device` ("call this one
the Studio Mac").

## Tools the Claude app gets

No tool waits for Claude Code to work: sending returns at once, and what follows (the reply, a
question, an answer) comes back as news.

| Tool | What it does |
| --- | --- |
| `list_sessions` | The open sessions by computer: name, project, what each is doing, which are watched. |
| `list_projects` | A computer's projects (folders), most recent first. |
| `start_session` | Starts a new session in a project, named, optionally with its first message; it opens in the desktop app. |
| `resume_session` | A project's 15 most recent sessions, numbered; then opens the one picked by number. |
| `fork_session` | Starts a side chat from a session: its whole conversation, a different task, the original undisturbed; both watched. |
| `rename_session` | Renames a session (open, or by number from the list); kept in its transcript. |
| `rename_device` | Renames a computer. |
| `watch_sessions` | Chooses the sessions whose every move reaches the Claude app. |
| `wait_for_updates` | Waits for news and returns it the moment it happens. |
| `send_message` | Sends a request to a session; returns at once with the message's id. |
| `answer_question` | Answers a question Claude Code asked. |
| `catch_up` | Everything needed to carry on with a session: goal, what it did, status now, its last exchanges, decisions, files touched, open questions. |
| `ask` | One exact detail (an error, a URL, a list), quoted from the session's own words; checked with tools only when needed. |
| `stop_session` | Interrupts a session. |
| `show_screen` | A screenshot of a computer's screen, with a private link. |

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

```bash
cd relay && npx tsc --noEmit                 # type-check the relay
claude plugin validate plugin                # check the plugin as Claude Code will load it
claude plugin test plugin                    # run the plugin's tests
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
