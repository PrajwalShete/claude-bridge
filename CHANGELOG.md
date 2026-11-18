# Changelog

## 1.7.0 (2026-11-19)

From the architecture review (`docs/REVIEW-2026-11-18.md`).

- **`read_session`**: a session's transcript itself, whole, no model: what you haven't heard, the
  last N, or a search; long results come in pages and a huge message continues across pages, so
  nothing is ever cut. Each message says who sent it (computer, Claude app, voice, Remote Control,
  another session), from Claude Code's own `origin`.
- **`catch_up` is the complete summary** for taking over a session: written once from the whole
  session, kept (it survives reloads), and updated from the new exchanges only, on the session's
  own model and effort. Nothing runs at turn end any more. It marks the session heard and watches it.
- **News can't be lost:** updates are numbered and `wait_for_updates` takes `heard`; a wait the
  app hangs up on (or cancels) ends without taking news. Old news (over 30 minutes) comes as one
  line per session. The app's own request isn't echoed back. A reply too long for one result
  points to `read_session`.
- **The inbox:** `list_sessions` shows `unheard` per session. Turns the app neither asked for nor
  watches reach the relay thin: that they happened, never what was said.
- **Permission prompts** go to the app as Allow / Deny questions; other things a session waits on
  at its screen come as news. The Mac is kept awake through turns the app asked for.
- **Tools:** `answer` (questions and permissions) and `rename` (sessions and computers) replace
  four; descriptions and instructions are about half as long.
- **Link codes need the computer's own secret** (the code is read aloud); `link_computer` lists
  and removes linked computers.
- **Fixes:** the app's own stop no longer holds its next message; a reload no longer loses the
  "for the app" mark; long side chats stay side chats; the panel's type error with Claude Code
  2.1.326.
- **Session names:** a session the desktop app moves after it starts (out of its spare folder)
  reports its new folder, so its project and name follow; headers and lookups by name fetch names
  again after the relay restarts, instead of showing the project's name.
- `GET /api/diag` lists the relay's last 200 calls. Logs, sockets and pictures moved to the private
  temp folder; the key file is created private.

## 1.6.0 (2026-11-18)

- **Nothing is ever cut.** Replies, answers, questions and the request they answer reach the
  Claude app whole: the relay no longer cuts them (it cut at 1,500 and 4,000 characters), and
  catch_up gives every message and reply complete (it cut at 700 and 2,500).
- A batch of news too big for one result comes over several calls, whole messages only.
- Each piece of news is kept on its own in the relay; unheard news waits a week.
- While the relay is out of reach, 500 pieces of news wait to be sent, not 20.
- The voice assistant is told to pass on each session's message in full.
- The plugin's log says which folder it loaded from.

## 1.5.0 (2026-11-09)

- **The background service is back** where macOS allows it: the device agent runs as a launchd
  agent that macOS starts at login, so the computer stays reachable with Claude closed.
- **Auto tries it first, and falls back:** where macOS refuses it, the plugin removes it at once
  (no prompt coming back) and connects from inside Claude from then on.
- The panel's setting is now **Background service**: Auto, On, Off.
- Sessions still on 1.4.0 replace the service with their own copy until they restart.

## 1.4.0 (2026-11-09)

- **Works on Macs that block the helper programs.** Where macOS refuses to run the plugin's two
  small programs (a managed Mac's "access denied"), each session talks to the relay itself, from
  inside Claude Code, and answers for its computer too: no program to run, nothing to allow.
  - **Auto** (the default) uses the helpers where they run, and switches to this mode for good the
    first time a computer refuses one. The panel's **Helper programs** setting chooses either
    way; `CLAUDE_BRIDGE_HELPERS=off` in Claude Code's settings `env` never launches one at all.
  - Without the helpers, the computer answers the Claude app while a Claude Code session is open
    on it (the device agent also answered with none open).
- The device agent starts only once the connector has started, and stops being retried where
  it doesn't stay running, so a refused program no longer brings the macOS prompt back every 30 s.

## 1.3.0 (2026-11-09)

- **One Connection switch in the panel:** Own account (URL and key for the Claude app) or Link
  with a code, either at any time. An owned account's key is kept aside, and restored on
  switching back.

## 1.2.0 (2026-11-09)

- **The device agent runs inside Claude.** Sessions start it, so macOS counts it as part of Claude,
  with Claude's permissions, and no separate background item needs allowing. One runs per computer;
  it quits with the Claude desktop app. The launchd agent of earlier versions is removed.

## 1.1.0 (2026-11-09)

- **Other computers with no setup.** Save the plugin to your Claude account once: every computer
  signed in gets it. Helper programs ship prebuilt (no Xcode). A new computer is linked by
  telling the Claude app its code (`link_computer`), with a credential of its own.

## 1.0.0 (2026-11-08)

The first version: Claude Code, reachable from the Claude app, voice mode included.

- **Devices, projects, sessions.** Every computer, its projects (folders) and their named
  sessions; no active session, every request names its session.
- **Instant send, news back.** Sending returns at once; replies, Claude Code's questions and
  answers come back as news, from watched sessions and from any session the app asked.
- **Catching up.** `catch_up` (goal, status, recent exchanges, decisions, files) and `ask` (exact
  details, quoted from the transcript; a tool-using side copy when needed).
- **Start, resume, rename, fork.** New sessions in a project; the 15 most recent of a project,
  numbered, to resume; names for sessions and computers; side chats with the whole context of
  their session, on its model and effort, opening where it runs.
- **Desktop app and CLI.** Sessions open in the desktop app or a Terminal window, per computer
  or per request.
- **Safety.** Pause everywhere (only a computer can resume it), ask first per session, a
  screenshot switch per computer, a confirmed new key, updates labelled as reports.
- **The panel.** Status, pause and watching; connecting the Claude app; settings; the app's
  messages, answered or not. A small Bridge button below the prompt opens it.
