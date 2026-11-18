# Roadmap

Parked ideas and decided-but-unbuilt changes.

## Done

- **No active chat** (replaces the parked "active chat changes only when the person says so"):
  every tool names its chat, and the person watches the chats they care about.
- **Instant send:** no tool waits for Claude Code; replies, questions and side answers come as news.
- **Fewer, sharper tools:** fourteen became nine, then sixteen as features came; 1.7.0 merged four into two and halved the descriptions.
- **Messages matched to turns by id**, not by comparing text.
- **Devices → projects → sessions**: named computers and sessions, starting and resuming
  sessions, and joining more computers ([decisions](DECISIONS.md)).
- Confirmation before **Make a new key**; **Ask me first** per session; screenshot switch per computer.
- **The CLI:** sessions start and resume in a Terminal window as well as the desktop app.

## Parked

- **A Mac signed in to a different Claude account** (parked 2026-11-09). Plugins sync through the
  Claude account, so the plugin won't reach that Mac by itself. To pick up:
  - **Getting the plugin there.** Either send `codebridge.plugin` for the person to save in
    their own account, or install from GitHub. GitHub needs a
    `.claude-plugin/marketplace.json`, plus a public repository or GitHub access on that Mac.
    Compare the two and choose.
  - **Linking across Claude accounts.** Check that the 12-character code works there. By design
    it should, since the code links to the Claude Bridge account (the relay key), not to a
    Claude login. You'd read the code to your own Claude app, the one with the Bridge connector,
    and that Mac's sessions would keep running on its own Claude account. Untested.

## Ideas

- A ping to the phone when a long task finishes and no call is waiting, through `$.ui.notify` (needs a check that it reaches the phone).
- Revoking a linked computer's credential (each computer now has its own).
- Starting a session in a folder Claude Code has never worked in.
- Make the plugin's relay defaults empty before the repository goes public (self-hosting first).
