// Claude Code's questions (its AskUserQuestion tool) in a turn the Claude app asked for or in a
// session it watches: the question goes to the app as news, and the answer comes from the app
// (answer_question) or the panel's buttons. The tool call waits on a long poll to the connector, whose time does not
// count against the hook's budget; with no answer, Claude Code's own dialog asks.

import { atom, read, update } from 'claude-code'

import { post } from './connector'
import { type Engine, PANE, addLog, errorText, note, rt, short, NO_QUESTION } from './state'
import type { BridgeQuestion, PendingQuestion } from '../types'

const question = atom({ plugin: 'codebridge', key: 'question' } as const, NO_QUESTION)

type Result = Record<string, unknown>
type Answer = { answers?: string[]; onScreen?: boolean }

/** How long a question may wait on the app before the dialog asks instead. */
const ANSWER_WINDOW_MS = 15 * 60_000

type AskInput = {
  tool_use_id?: string
  questions?: ReadonlyArray<{
    question: string
    header?: string
    multiSelect?: boolean
    options?: ReadonlyArray<{ label: string; description?: string }>
  }>
}

/**
 * Puts a question to the app and waits for the answer. Resolves the answers keyed by
 * question, or undefined when the dialog should ask.
 */
export async function askThroughApp(
  $: Engine,
  input: AskInput,
  tell: (questions: BridgeQuestion[]) => void,
): Promise<Record<string, string> | undefined> {
  const questions: BridgeQuestion[] = (input.questions ?? []).map(q => ({
    question: q.question,
    header: q.header ?? '',
    options: (q.options ?? []).map(o => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
    multiSelect: q.multiSelect === true,
  }))
  if (questions.length === 0) return undefined
  const id = input.tool_use_id ?? `q${await $.clock.now()}`
  await update($, question, () => ({ id, questions, picks: questions.map(() => []) }))
  await addLog($, { kind: 'event', text: `Claude Code asks: ${short(questions[0]!.question)}` })
  void $.ui.open({ id: PANE, title: 'Claude Bridge' })
  tell(questions)

  // Short polls, each well inside any request timeout. A failed one is retried; the connector
  // going away, three failures running, or the window running out hand it to the dialog.
  let value: Answer | undefined
  let misses = 0
  const askedAt = await $.clock.now()
  while (rt.connector && misses < 3 && (await $.clock.now()) - askedAt < ANSWER_WINDOW_MS) {
    try {
      const reply = (await post($, '/wait_answer', { id, seconds: 8 })) as { pending?: boolean; value?: Answer } | undefined
      if (!reply) {
        misses++
        continue
      }
      misses = 0
      if (!reply.pending) {
        value = reply.value
        break
      }
    } catch (error) {
      misses++
      await note($, `question ${id}: wait failed (${misses}): ${errorText(error)}`)
    }
  }
  await update($, question, () => null)
  const given = value?.answers
  if (!given || value?.onScreen) {
    await note($, `question goes to the dialog (${value?.onScreen ? 'asked for' : 'no answer'})`)
    return undefined
  }
  const answers: Record<string, string> = {}
  questions.forEach((q, i) => {
    answers[q.question] = given[i] ?? ''
  })
  await addLog($, { kind: 'answer', text: given.join(' · ') })
  return answers
}

/** answer_question: the app's answer, one per question in order. */
export async function answerFromApp($: Engine, args: Record<string, unknown>): Promise<Result> {
  const pending = await read($, question)
  if (!pending) return { error: 'Claude Code is not waiting on a question right now.' }
  if (args.on_screen === true) {
    await post($, '/answer', { id: pending.id, value: { onScreen: true } satisfies Answer })
    return { status: 'The question is on screen now.' }
  }
  const answers = Array.isArray(args.answers) ? args.answers.map(a => String(a).trim()) : []
  if (answers.length < pending.questions.length || answers.some(a => !a)) {
    const n = pending.questions.length
    return { error: `Claude Code asked ${n} question${n === 1 ? '' : 's'}; give an answer for each, in order.` }
  }
  await post($, '/answer', { id: pending.id, value: { answers } satisfies Answer })
  return { status: 'answered' }
}

/** A press on an option in the panel; a full set of single picks answers at once. */
export async function pick($: Engine, index: number, label: string): Promise<void> {
  let complete = false
  await update($, question, current => {
    if (!current) return current
    const q = current.questions[index]
    if (!q) return current
    const picks = current.picks.map((list, i) => {
      if (i !== index) return list
      if (!q.multiSelect) return [label]
      return list.includes(label) ? list.filter(one => one !== label) : [...list, label]
    })
    complete = current.questions.every((one, i) => !one.multiSelect && (picks[i]?.length ?? 0) > 0)
    return { ...current, picks }
  })
  if (complete) await sendPicks($)
}

export async function sendPicks($: Engine): Promise<void> {
  const pending: PendingQuestion | null = await read($, question)
  if (!pending || pending.picks.some(list => list.length === 0)) return
  await post($, '/answer', { id: pending.id, value: { answers: pending.picks.map(list => list.join(', ')) } satisfies Answer })
}

export async function answerOnScreen($: Engine): Promise<void> {
  const pending = await read($, question)
  if (pending) await post($, '/answer', { id: pending.id, value: { onScreen: true } satisfies Answer })
}
