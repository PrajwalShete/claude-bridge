# Changelog

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
