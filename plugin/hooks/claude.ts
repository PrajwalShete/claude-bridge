// Claude Code's side: submitting the app's messages as prompts, and reading what Claude Code
// did (its replies, what it changed, what it is doing now).

import { atom, read, update } from 'claude-code'
import type { ToolUseSummary } from 'claude-code'

import { type Engine, addLog, ago, baseName, errorText, note, rt, setStatus, short, INITIAL_CLAUDE, NO_QUESTION } from './state'

const claude = atom({ plugin: 'codebridge', key: 'claude' } as const, INITIAL_CLAUDE)
const question = atom({ plugin: 'codebridge', key: 'question' } as const, NO_QUESTION)

type Result = Record<string, unknown>

/**
 * Submits `text` as the person's next prompt and returns at once: `sent` (its turn began) or
 * `queued` (Claude Code is busy), with the message's id; its reply comes as an event. A refused
 * prompt is left in the prompt box (`not sent`).
 */
export async function sendMessage($: Engine, raw: string, mode: 'send' | 'draft', again = false): Promise<Result> {
  const text = raw.trim()
  if (!text) return { error: 'There was nothing to send.' }
  if (mode === 'draft') return holdInBox($, text, 'Put in the prompt box as asked', 'drafted')

  if (await read($, question)) {
    return {
      error:
        "This session is waiting on its question, so nothing new was sent. If that was the person's answer, call answer_question with it.",
    }
  }
  const now = await $.clock.now()
  // A repeat (a retried call whose first result was lost) returns the first message, not a second send.
  if (!again && text.toLowerCase() === rt.lastSentText.text.toLowerCase() && now - rt.lastSentText.at < 120_000) {
    return { status: 'already sent', message: rt.lastSentText.id, note: 'That exact message went to this session within the last two minutes; it was not sent again. Pass again: true to send it once more.' }
  }
  rt.lastSentText = { text, at: now, id: '' }

  const { isWorking } = await read($, claude)
  if (rt.askFirst) return holdInBox($, text, 'This session is set to ask the person first')
  if (rt.stopStands) return holdInBox($, text, 'The person stopped Claude Code a moment ago')

  const id = await addLog($, { kind: 'app', text, status: isWorking ? 'queued' : 'sending' })
  rt.lastSentText.id = id
  const sentAt = await $.clock.now()

  // The submit resolves as its turn starts, which is when the message joins that turn, or at
  // once with `drop` when Claude Code refuses it. Wait briefly for a refusal; a later one still
  // puts the message back in the box.
  type Submitted = { drop?: unknown } | 'pending' | { error: string }
  const submitted = $.prompt
    .submit({ text, asUser: true })
    .then(result => result as Submitted)
    .catch(error => ({ error: errorText(error) }) as Submitted)
  const refused = (o: Submitted) => o !== 'pending' && (('drop' in o && o.drop !== undefined) || 'error' in o)
  const settled = submitted.then(async result => {
    if (refused(result)) {
      await note($, `send ${id} refused: ${JSON.stringify(result)}`)
      await holdInBox($, text, 'Claude Code didn’t take it', 'held', id)
    } else {
      await joinTurn($, id, sentAt)
    }
    return result
  })

  const first = await Promise.race([settled, $.clock.sleep(1500).then(() => 'pending' as Submitted)])
  if (refused(first)) return holdInBox($, text, 'Claude Code didn’t take it', 'held', id)
  return {
    status: isWorking ? 'queued' : 'sent',
    message: id,
    note: isWorking
      ? 'This session is busy; it takes the message as soon as it finishes. Its reply comes as an update from this session.'
      : 'Claude Code is on it. Its reply comes as an update from this session: call wait_for_updates to hear it.',
  }
}

/** The message's prompt entered: it joins the turn that started for it (see MARK in state.ts). */
async function joinTurn($: Engine, id: string, sentAt: number): Promise<void> {
  const turn = rt.turn
  if (turn && turn.startedAt >= sentAt) {
    if (!rt.turnEntries.includes(id)) rt.turnEntries.push(id)
    await saveTurnMarks($)
    await setStatus($, id, 'working')
    await note($, `message ${id} joined turn ${turn.id}`)
  } else {
    // Its turn.start hasn't run yet: that turn takes it.
    rt.entering.push(id)
    await saveTurnMarks($)
  }
}

/** Puts a message in the prompt box for the person to send with Enter, and says so honestly. */
async function holdInBox(
  $: Engine,
  text: string,
  why: string,
  how: 'held' | 'drafted' = 'held',
  entry?: string,
): Promise<Result> {
  const box = await $.prompt.read()
  const filled = box.text.includes(text)
    ? { isFilled: true }
    : await $.prompt.fill({ text: box.text.trim() ? `\n${text}` : text, mode: box.text.trim() ? 'append' : 'replace' })
  if (entry) await setStatus($, entry, 'held')
  else await addLog($, { kind: 'app', text, status: 'held' })
  if (!filled.isFilled) return { status: 'not sent', error: `${why}, and the prompt box isn’t available.` }
  if (how === 'drafted') return { status: 'drafted', note: 'It is in the prompt box for the person to review and send.' }
  return {
    status: 'not sent',
    note: `${why}, so it was not sent. It is in the prompt box: tell the person to press Enter there to send it.`,
  }
}

// MARK: What Claude Code did

/** Files and commands, from a turn's tool uses. */
export function changesOf(uses: readonly ToolUseSummary[]): string[] {
  const out: string[] = []
  let reads = 0
  for (const use of uses) {
    const file = baseName(use.input.file_path ?? use.input.notebook_path)
    switch (use.tool) {
      case 'Edit':
      case 'MultiEdit':
      case 'NotebookEdit':
        out.push(`edited ${file ?? 'a file'}`)
        break
      case 'Write':
        out.push(`wrote ${file ?? 'a file'}`)
        break
      case 'Bash': {
        const what =
          typeof use.input.description === 'string' ? use.input.description : short(String(use.input.command ?? ''), 60)
        out.push(`ran: ${what}${use.isError ? ' (it failed)' : ''}`)
        break
      }
      case 'Read':
        reads++
        break
    }
  }
  if (reads) out.push(`read ${reads} file${reads === 1 ? '' : 's'}`)
  const all = [...new Set(out)]
  // A long list of actions is summed up, never dropped without a word.
  return all.length > 14 ? [...all.slice(0, 13), `and ${all.length - 13} more`] : all
}

export async function changesOfLastTurn($: Engine): Promise<string[]> {
  const messages = await $.session.messages()
  let start = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user' && m.text.trim() && !m.toolResults?.length) {
      start = i + 1
      break
    }
  }
  return changesOf(messages.slice(start).flatMap(m => (m.role === 'assistant' ? m.toolUses : [])))
}

export async function claudeStatus($: Engine): Promise<Result> {
  const activity = await read($, claude)
  const pending = await read($, question)
  if (pending) return { isWorking: true, waitingOn: 'the person, to answer its question', questions: pending.questions }
  const now = await $.clock.now()
  if (!activity.isWorking) {
    const last = activity.replies.at(-1)
    return { isWorking: false, note: 'Claude Code is idle.', ...(last ? { lastFinished: `${ago(now - last.at)} ago` } : {}) }
  }
  return {
    isWorking: true,
    task: activity.task,
    workingFor: activity.startedAt ? ago(now - activity.startedAt) : undefined,
    doingNow: activity.tools,
    soFar: await changesOfLastTurn($),
  }
}

export async function stopClaude($: Engine): Promise<Result> {
  const { isWorking, turnId } = await read($, claude)
  if (!isWorking || !turnId) return { status: 'Claude Code was not working on anything.' }
  rt.appStopped = true
  await $.turn.abort({ turnId })
  await addLog($, { kind: 'event', text: 'Stopped by the Claude app' })
  return { status: 'stopped' }
}

/** A short phrase for what a tool call is doing, for status. */
export function describeTool(tool: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>
  const file = baseName(args.file_path ?? args.notebook_path)
  switch (tool) {
    case 'Bash':
      return typeof args.description === 'string'
        ? `running: ${args.description.replace(/^./, c => c.toLowerCase())}`
        : 'running a command'
    case 'Read':
      return `reading ${file ?? 'a file'}`
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `editing ${file ?? 'a file'}`
    case 'Write':
      return `writing ${file ?? 'a file'}`
    case 'Grep':
    case 'Glob':
      return 'searching the code'
    case 'Agent':
    case 'Task':
      return `running a subagent${typeof args.description === 'string' ? `: ${args.description}` : ''}`
    case 'WebSearch':
    case 'WebFetch':
      return 'looking something up on the web'
    case 'AskUserQuestion':
      return 'waiting on your answer'
    case 'TodoWrite':
      return 'updating its plan'
    default:
      return `using ${tool.replace(/^mcp__/, '').replace(/__/g, ' ')}`
  }
}

const turnMarks = atom({ plugin: 'codebridge', key: 'turnMarks' } as const, { entering: [] as string[], turnEntries: [] as string[] })

/** Keeps which app messages wait for, or ride in, a turn in the session's state (survives a reload). */
export async function saveTurnMarks($: Engine): Promise<void> {
  await update($, turnMarks, () => ({ entering: [...rt.entering], turnEntries: [...rt.turnEntries] }))
}

/** Puts them back after a reload. */
export async function loadTurnMarks($: Engine): Promise<void> {
  const kept = await read($, turnMarks)
  rt.entering = [...kept.entering]
  rt.turnEntries = [...kept.turnEntries]
}
