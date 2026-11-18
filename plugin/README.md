# Claude Bridge (codebridge)

Talk to your Claude Code sessions from the Claude app, voice mode included. Send requests, hear
replies, answer Claude Code's questions, catch up on a session, start, resume, rename and fork
sessions, on every computer linked to your account.

## Setup

Install it on each computer:

```bash
claude plugin marketplace add PrajwalShete/claude-bridge
claude plugin install codebridge@claude-bridge
```

Or in one step inside Claude Code: `/plugin install codebridge --marketplace PrajwalShete/claude-bridge`

- **First computer:** open the Claude Bridge panel (the small "● Bridge" button below the prompt,
  or `/bridge`), choose **Own account** under Connection, then add the connector URL in the Claude
  app (Settings, Connectors, Add custom connector) and paste the key.
- **Every other computer:** install it there too; its panel shows a code: tell the Claude app
  "link my computer, code …".

The plugin carries its two small helper programs prebuilt (Apple silicon and Intel), so no Xcode
is needed. One runs as a background service macOS starts at login, so the computer stays
reachable with Claude closed. On a Mac that refuses it (a managed Mac's "access denied"), Auto
removes it at once and connects from inside Claude Code instead; to never try it there, choose
**Off** under Settings, **Background service**, or set `CLAUDE_BRIDGE_HELPERS=off` in Claude
Code's settings `env`. Pause everything at any time from the panel.
