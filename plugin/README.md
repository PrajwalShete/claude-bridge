# Claude Bridge (codebridge)

Talk to your Claude Code sessions from the Claude app, voice mode included. Send requests, hear
replies, answer Claude Code's questions, catch up on a session, start, resume, rename and fork
sessions, on every computer linked to your account.

## Setup

- **First computer:** open the Claude Bridge panel (the small "● Bridge" button below the prompt,
  or `/bridge`), choose **Own account** under Connection, then add the connector URL in the Claude
  app (Settings, Connectors, Add custom connector) and paste the key.
- **Every other computer:** nothing to install when the plugin is saved to your Claude account.
  Its panel shows a code; tell the Claude app "link my computer, code …".

The plugin carries its two small helper programs prebuilt (Apple silicon and Intel), so no Xcode
is needed. On a Mac that refuses to run them (a managed Mac's "access denied"), it connects from
inside Claude Code instead, by itself; to never launch them there, choose **Inside Claude only**
under Settings, **Helper programs**, or set `CLAUDE_BRIDGE_HELPERS=off` in Claude Code's settings
`env`. Pause everything at any time from the panel.
