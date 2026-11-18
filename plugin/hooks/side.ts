// The session's context for the Claude app, without touching the session, as a desktop side chat does.
//   ask      one question. First a single pass over the session's own transcript ($.model.fork: no
//            tools, served from the session's prompt cache, seconds) that quotes exact text: an
//            error, a URL, a list. Only when the answer needs files read, commands run or the
//            current state checked does a fork with every tool take over ($.agent.spawn, `fork`);
//            that call returns at once and the answer comes as an `answer` event.
//   brief    the session's goal, what it has done, decisions and open questions, for catch_up.

import { atom, read } from 'claude-code'

import { reportState, sendEvent } from './connector'
import { type Exchange, readForward, scanBack, transcriptFile } from './transcript'
import { type Engine, addLog, errorText, note, rt, short, INITIAL_CLAUDE } from './state'

const claude = atom({ plugin: 'codebridge', key: 'claude' } as const, INITIAL_CLAUDE)

type Result = Record<string, unknown>

const NEEDS_TOOLS = 'NEEDS_TOOLS'

const TRANSCRIPT_PROMPT =
  'Side question from the person through the Claude app (Claude Bridge). Answer it from this conversation alone. ' +
  'When the answer is something written here (an error message, a URL, a list, a name, a number, a command, a file path), ' +
  'quote it exactly, in quotation marks, never paraphrased. Otherwise answer in a few plain sentences. ' +
  `If answering correctly needs reading files, running commands, or checking how things stand now rather than what was said, reply with exactly ${NEEDS_TOOLS} and nothing else.` +
  '\n\nQuestion: '

const TOOLS_PROMPT =
  'The person is asking a side question through the Claude app (Claude Bridge), as in a desktop side chat. ' +
  'Answer it from this conversation, and use your tools to check or find what it needs. ' +
  'Do not change any files, commit, or start long-running work unless the question explicitly asks you to. ' +
  'Quote exact text (errors, URLs, lists, names) exactly; otherwise answer in a few plain sentences.\n\nQuestion: '

/** ask: the transcript when it holds the answer, a fork with tools when it doesn't. */
export async function ask($: Engine, question: string): Promise<Result> {
  const q = question.trim()
  if (!q) return { error: 'There was no question.' }
  const started = await $.clock.now()
  const reply = await $.model.fork({ prompt: TRANSCRIPT_PROMPT + q })
  const ms = (await $.clock.now()) - started
  const text = reply.isAnswered ? reply.text.trim() : ''
  await note($, `ask: transcript pass in ${ms} ms (${reply.isAnswered ? (text.startsWith(NEEDS_TOOLS) ? 'needs tools' : 'answered') : reply.reason})`)
  if (text && !text.startsWith(NEEDS_TOOLS)) {
    await addLog($, { kind: 'event', text: `Side question: ${short(q, 80)}` })
    return { answer: text, from: 'the session\'s transcript', took: `${(ms / 1000).toFixed(1)} s` }
  }
  return askWithTools($, q)
}

/** Starts a fork of the session on the question and returns at once; sideFinished sends its answer. */
async function askWithTools($: Engine, q: string): Promise<Result> {
  let spawned
  try {
    spawned = await $.agent.spawn({ prompt: TOOLS_PROMPT + q, subagentType: 'fork', description: 'Side question from the Claude app' })
  } catch (error) {
    return { error: `Couldn’t start the side session: ${errorText(error)}` }
  }
  if ('deny' in spawned && spawned.deny) return { error: `The side session was refused: ${spawned.deny}` }
  const agentId = spawned.agentId
  if (!agentId) return { error: 'The side session didn’t start.' }
  rt.sideOpen.set(agentId, { question: q, startedAt: await $.clock.now() })
  await note($, `ask with tools: fork ${agentId} started for "${short(q, 60)}"`)
  await addLog($, { kind: 'event', text: `Side session: ${short(q, 80)}` })
  void reportState($)
  return {
    status: 'working',
    ask: agentId,
    note: 'This needs checking, so a side copy of the session with every tool is looking into it. Its answer comes as an update from this session: call wait_for_updates to hear it.',
  }
}

/** turn.complete of a fork this module started: its answer goes to the Claude app as news. */
export async function sideFinished($: Engine, agentId: string, answer: string, reason: string): Promise<boolean> {
  const open = rt.sideOpen.get(agentId)
  if (!open) return false
  rt.sideOpen.delete(agentId)
  const seconds = Math.round(((await $.clock.now()) - open.startedAt) / 1000)
  await note($, `ask with tools: fork ${agentId} ended (${reason}) after ${seconds} s`)
  const text = answer || (reason === 'answer' ? 'The side session ended without an answer.' : `The side session ended early (${reason}).`)
  await sendEvent($, { kind: 'answer', ask: agentId, question: open.question, text, forApp: true })
  void reportState($)
  return true
}

// MARK: The summary

/** What a complete summary covers, for the Claude app's assistant taking over a session. */
const SUMMARY_PROMPT =
  'Write a complete summary of this session for an assistant in the Claude app who is taking over from here: it talks ' +
  'with the person, mostly by voice, and passes their requests to you. It has read nothing of this session, and must be ' +
  'able to carry on as if it had followed all of it. Cover, in plain sentences under these headings: ' +
  'Goal (what the session is for, and the larger aim behind it); Background (who the person is here, their preferences ' +
  'and rules for how to work, the project and its parts); Everything done (in order, with what came of each step); ' +
  'Decisions (each one and why); Where it stands now (what is finished, what is half done, what is broken or unverified); ' +
  'Open (questions waiting on the person, next steps, risks). Be complete rather than short: leave nothing out that ' +
  'the assistant would need. No code blocks; name files and commands in plain words. Write only the summary.'

const UPDATE_PROMPT =
  'Below is a complete summary of a Claude Code session, then the exchanges that happened after it. Rewrite the ' +
  'summary so it covers everything, keeping the same headings (Goal, Background, Everything done, Decisions, Where it ' +
  'stands now, Open): add what the new exchanges did and decided, and update anything they changed. Keep everything ' +
  'still true from the old summary; nothing important may be dropped. Write only the new summary.'

/** The summary kept in the store: its text; the last exchange it covers (its id, and the byte after
 * it in the transcript, where an update starts reading); when it was written. */
type Kept = { text: string; through: string; throughEnd?: number; at: number; exchanges: number }

/** New exchanges are folded into the summary in batches of about this many characters, so no one
 * update asks the model for more than it should take at once. */
const UPDATE_BATCH = 300_000

/**
 * The session's complete summary, kept in the store (it survives reloads): returned as is when no
 * exchange finished since; else brought up to date from the new exchanges only, read straight from
 * where the summary ends (no part of the file twice), on the session's own model and effort (never a
 * costlier one), with no history to re-read. Written from the whole session (one fork, which reads
 * the session's own context, not the file) the first time, or when `full` is asked.
 */
export async function currentSummary($: Engine, full: boolean): Promise<{ text: string; covers: string; how: string }> {
  const key = `summary:${await $.session.id()}`
  const kept = (await $.store.get(key)) as Kept | undefined
  const { read: readFile, size } = await transcriptFile($)
  const covers = (k: Kept) => `everything through ${new Date(k.at).toISOString()} (${k.exchanges} exchange${k.exchanges === 1 ? '' : 's'} folded in)`
  if (kept && !full) {
    let fresh: Exchange[] | undefined
    if (typeof kept.throughEnd === 'number' && kept.throughEnd <= size) {
      fresh = (await readForward(readFile, kept.throughEnd, size)).exchanges
    } else {
      // A summary kept before byte positions: look back for its last exchange once.
      const scan = await scanBack(readFile, size, list => list.some(x => x.id === kept.through))
      const at = scan.exchanges.findIndex(x => x.id === kept.through)
      fresh = at >= 0 ? scan.exchanges.slice(at + 1) : undefined
    }
    if (fresh) {
      // Only finished exchanges are folded in: the newest waits while the session is still on it.
      const working = (await read($, claude)).isWorking
      const upto = fresh.filter(x => x.finishedAt && !(working && x === fresh.at(-1)))
      if (upto.length === 0) return { text: kept.text, covers: covers(kept), how: 'kept: nothing new since it was written' }
      let text = kept.text
      for (let i = 0; i < upto.length; ) {
        const batch: Exchange[] = []
        let chars = 0
        while (i < upto.length && (batch.length === 0 || chars + upto[i]!.message.length + upto[i]!.reply.length <= UPDATE_BATCH)) {
          chars += upto[i]!.message.length + upto[i]!.reply.length
          batch.push(upto[i++]!)
        }
        const next = await updateSummary($, text, batch)
        if (!next) {
          await note($, 'summary update failed; writing it from the whole session')
          text = ''
          break
        }
        text = next
      }
      if (text) {
        const last = upto.at(-1)!
        const next: Kept = { text, through: last.id, throughEnd: last.end, at: await $.clock.now(), exchanges: kept.exchanges + upto.length }
        await $.store.set(key, next)
        await note($, `summary updated from ${upto.length} new exchange(s) (${text.length} chars)`)
        return { text, covers: covers(next), how: `updated from ${upto.length} new exchange${upto.length === 1 ? '' : 's'}` }
      }
    }
  }
  const reply = await $.model.fork({ prompt: SUMMARY_PROMPT })
  if (!reply.isAnswered || !reply.text.trim()) {
    if (kept) return { text: kept.text, covers: covers(kept), how: `kept: a fresh one couldn't be written (${reply.isAnswered ? 'empty' : reply.reason})` }
    return { text: '', covers: '', how: reply.isAnswered ? 'the model wrote nothing' : String(reply.reason) }
  }
  // Where the summary ends: the newest finished exchange, found by reading back only as far as it.
  const working = (await read($, claude)).isWorking
  const tail = await scanBack(readFile, size, list => list.length >= 2 || (!working && list.length >= 1))
  const last = tail.exchanges.filter((x, i, all) => x.finishedAt && !(working && i === all.length - 1)).at(-1)
  const next: Kept = { text: reply.text.trim(), through: last?.id ?? '', ...(last ? { throughEnd: last.end } : {}), at: await $.clock.now(), exchanges: 0 }
  await $.store.set(key, next)
  await note($, `summary written from the whole session (${next.text.length} chars)`)
  return { text: next.text, covers: `everything through ${new Date(next.at).toISOString()}`, how: 'written from the whole session' }
}

/** One update: the summary so far plus a batch of new exchanges, on the session's own model and effort. */
async function updateSummary($: Engine, summary: string, batch: Exchange[]): Promise<string | undefined> {
  const model = rt.model || (await $.session.model().catch(() => ''))
  const effort = (rt.effort || undefined) as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined
  const exchangesText = batch
    .map(x => `--- ${x.from} at ${x.at}:\n${x.message}\n--- Claude Code replied:\n${x.reply || '(no reply)'}${x.changes.length ? `\n--- Changed: ${x.changes.join('; ')}` : ''}`)
    .join('\n\n')
  const reply = await $.model.complete({
    model,
    ...(effort ? { effort } : {}),
    maxTokens: 32_000,
    prompt: `${UPDATE_PROMPT}\n\n=== Summary so far ===\n${summary}\n\n=== New exchanges ===\n${exchangesText}`,
  })
  return reply.isAnswered && reply.text.trim() ? reply.text.trim() : undefined
}
