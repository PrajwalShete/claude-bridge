// The session's context for the Claude app, without touching the session, as a desktop side chat does.
//   ask      one question. First a single pass over the session's own transcript ($.model.fork: no
//            tools, served from the session's prompt cache, seconds) that quotes exact text: an
//            error, a URL, a list. Only when the answer needs files read, commands run or the
//            current state checked does a fork with every tool take over ($.agent.spawn, `fork`);
//            that call returns at once and the answer comes as an `answer` event.
//   brief    the session's goal, what it has done, decisions and open questions, for catch_up.

import { atom, read } from 'claude-code'

import { reportState, sendEvent } from './connector'
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
  await sendEvent($, { kind: 'answer', ask: agentId, question: short(open.question, 300), text, forApp: true })
  void reportState($)
  return true
}

// MARK: The brief

const BRIEF_PROMPT =
  'Write a briefing on this session for an assistant who talks with the person by voice and passes their requests ' +
  'to you, so it can carry on from here. Plain sentences, no code or markdown, under 250 words, under these labels: ' +
  'Goal: what this session is for overall. Done so far: what has been done, most recent last. ' +
  'Decisions: the key decisions and why. Open: open questions, anything waiting on the person, likely next steps. ' +
  'Write only the briefing.'

/** Makes a new brief. One at a time: a caller arriving during one waits for it. */
async function makeBrief($: Engine): Promise<void> {
  if (rt.briefRun) return rt.briefRun
  rt.briefRun = (async () => {
    try {
      const reply = await $.model.fork({ prompt: BRIEF_PROMPT })
      if (reply.isAnswered && reply.text.trim()) {
        rt.brief = { text: reply.text.trim(), at: await $.clock.now() }
        await note($, `brief refreshed (${rt.brief.text.length} chars)`)
      } else if (!reply.isAnswered) {
        await note($, `brief not refreshed: ${reply.reason}`)
      }
    } catch (error) {
      await note($, `brief failed: ${errorText(error)}`)
    }
  })()
  try {
    await rt.briefRun
  } finally {
    rt.briefRun = undefined
  }
}

/** After a turn the app may catch up on: a new brief in the background, at most once a minute. */
export async function refreshBrief($: Engine): Promise<void> {
  if ((await $.clock.now()) - rt.brief.at < 60_000) return
  await makeBrief($)
}

/** The brief, made now when the session has finished a turn since the last one. */
export async function currentBrief($: Engine): Promise<{ text: string; updated: number } | undefined> {
  const lastReply = (await read($, claude)).replies.at(-1)?.at ?? 0
  if (!rt.brief.text || rt.brief.at < lastReply) await makeBrief($)
  return rt.brief.text ? { text: rt.brief.text, updated: rt.brief.at } : undefined
}
