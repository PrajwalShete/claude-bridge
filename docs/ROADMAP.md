# Roadmap

Parked ideas and decided-but-unbuilt changes.

## Done

- **No active chat** (replaces the parked "active chat changes only when the person says so"):
  every tool names its chat, and the person watches the chats they care about.
- **Instant send:** no tool waits for Claude Code; replies, questions and side answers come as news.
- **Fewer, sharper tools:** fourteen became nine.
- **Messages matched to turns by id**, not by comparing text.
- **Devices → projects → sessions**: named computers and sessions, starting and resuming
  sessions, and joining more computers ([decisions](DECISIONS.md)).
- Confirmation before **Make a new key**; **Ask me first** per session; screenshot switch per computer.
- **The CLI:** sessions start and resume in a Terminal window as well as the desktop app.

## Ideas

- A ping to the phone when a long task finishes and no call is waiting, through `$.ui.notify` (needs a check that it reaches the phone).
- Per-device keys with revocation (instead of one shared account key).
- Starting a session in a folder Claude Code has never worked in.
- Make the plugin's relay defaults empty before the repository goes public (self-hosting first).
