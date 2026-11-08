// catch_up: everything the Claude app needs to carry on with a session, read from the session itself
// (its transcript on this computer is the only record; the relay keeps none).
//   now        working or idle, on what, for how long, what it is doing; a question it waits on
//   brief      the goal, what was done, decisions and why, open questions (a fork writes it)
//   exchanges  the last few messages and replies, typed on the computer or sent from the app
//   files      the files the session edited or wrote, most recent first

import { atom, read } from 'claude-code'
import type { SessionMessage } from 'claude-code'

import { changesOf, claudeStatus } from './claude'
import type { Picture } from './images'
import { currentBrief } from './side'
import { type Engine, ago, baseName, cleanPrompt, isPersonPrompt, rt, short, INITIAL_CLAUDE, INITIAL_LOG } from './state'

const claude = atom({ plugin: 'codebridge', key: 'claude' } as const, INITIAL_CLAUDE)
const log = atom({ plugin: 'codebridge', key: 'log' } as const, INITIAL_LOG)

type Result = Record<string, unknown>

export type Exchange = { from: 'Claude app' | 'computer'; message: string; reply: string; changes: string[] }

/**
 * The transcript as the person's messages, each with Claude Code's final reply to it and what
 * it changed. `fromApp` tells the app's messages apart from ones typed on the computer.
 */
export function exchangesOf(messages: readonly SessionMessage[], fromApp: (text: string) => boolean): Exchange[] {
  const out: Exchange[] = []
  let current: { message: string; replies: string[]; uses: SessionMessage['toolUses'][number][] } | undefined
  const close = () => {
    if (!current) return
    const reply = current.replies.at(-1) ?? ''
    out.push({ from: fromApp(current.message) ? 'Claude app' : 'computer', message: current.message, reply, changes: changesOf(current.uses) })
  }
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.toolResults?.length || !isPersonPrompt(m.text)) continue
      const text = cleanPrompt(m.text)
      if (!text) continue
      close()
      current = { message: text, replies: [], uses: [] }
    } else if (current) {
      if (m.text.trim()) current.replies.push(m.text.trim())
      current.uses.push(...m.toolUses)
    }
  }
  close()
  return out
}

/** Files the session edited or wrote, most recent first, by name. */
export function filesTouched(messages: readonly SessionMessage[], limit = 15): string[] {
  const seen: string[] = []
  for (let i = messages.length - 1; i >= 0 && seen.length < limit; i--) {
    const uses = messages[i]!.toolUses
    for (let j = uses.length - 1; j >= 0 && seen.length < limit; j--) {
      const use = uses[j]!
      if (!['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(use.tool)) continue
      const path = use.input.file_path ?? use.input.notebook_path
      if (typeof path === 'string' && path && !seen.includes(path)) seen.push(path)
    }
  }
  return seen
}

export async function catchUp($: Engine, args: Record<string, unknown>): Promise<Result> {
  const want = Math.min(10, Math.max(1, Math.round(Number(args.exchanges ?? 6)) || 6))
  const root = await $.session.root()
  const messages = await $.session.messages()
  const sent = new Set((await read($, log)).filter(e => e.kind === 'app').map(e => short(e.text, 400)))
  const exchanges = exchangesOf(messages, text => sent.has(short(text, 400)))
    .slice(-want)
    .map((x, i, all) => ({
      from: x.from,
      message: short(x.message, 500),
      // The newest reply whole enough to carry on from; earlier ones shorter.
      reply: x.reply ? short(x.reply, i === all.length - 1 ? 2500 : 700) : '(no reply yet)',
      ...(x.changes.length ? { changes: x.changes } : {}),
    }))
  const brief = await currentBrief($)
  const now = await $.clock.now()
  const files = filesTouched(messages).map(path => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : baseName(path) ?? path))

  const result: Result = {
    now: await claudeStatus($),
    ...(brief ? { brief: brief.text, briefUpdated: `${ago(now - brief.updated)} ago` } : { brief: 'No briefing yet: the session has no finished turn.' }),
    exchanges,
    ...(files.length ? { filesTouched: files } : {}),
    note: 'exchanges are oldest first; "from" says whether the person typed the message on the computer or sent it from the Claude app.',
  }
  return withPictures($, result)
}

/** The pictures Claude Code shared with its latest reply, while no newer turn is running. */
async function withPictures($: Engine, result: Result): Promise<Result> {
  const shared: Picture[] = rt.shared
  if (shared.length === 0 || (await read($, claude)).isWorking) return result
  return {
    ...result,
    pictures: shared.map(p => p.caption ?? 'a picture'),
    picturesNote: 'Claude Code shared pictures with its latest reply, each with a private link. Give the person the links.',
    _images: shared.map(p => ({ data: p.data, mimeType: p.mimeType })),
  }
}
