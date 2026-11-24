# Privacy

Claude Bridge passes messages between the Claude app and your Claude Code sessions through a relay
(a Cloudflare Worker with one Durable Object per account). This is what the relay keeps, and for
how long. It has no accounts, analytics or ads, and sells or shares nothing.

**Never stored**
- Your Claude Bridge key. Sign-in only checks it; the relay keeps a hash that names your account.
- Sign-in state: apps, codes and tokens are signed, not stored.

**Kept in your account's own store**
- News from your sessions (a reply, a question, that a turn started or ended), so the Claude app
  can hear it: an hour after the app has heard it, a week at most if it never does.
- Pictures a session shares with a reply: an hour.
- Computer and session names, the projects a session list showed, which sessions you watch, and
  whether Claude Bridge is paused.
- Linked computers: a hash of each one's credential, with its name.
- Your own instructions for the assistant, until you change them.
- Problem reports the assistant files with `report_problem`, until they are dealt with.
- The last 200 tool calls' names, times and outcomes (not what they said), for fixing problems.
- That a conversation read your instructions: a week.

**Passed through, not kept**
- What you send to a session and the tool calls in between: they reach your computer and are gone.

Cloudflare runs the relay and keeps its usual request logs. To remove everything, make a new key in
the Claude Bridge panel (every connected app is cut off at once) and ask for your account's store
to be deleted in an issue at https://github.com/PrajwalShete/claude-bridge/issues.
