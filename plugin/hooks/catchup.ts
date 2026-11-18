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
import { currentSummary } from './side'
import { type Exchange, decodeCursor, page, readTail } from './transcript'
import { type Engine, ago, baseName, cleanPrompt, isPersonPrompt, rt, short, INITIAL_CLAUDE, INITIAL_LOG } from './state'

const claude = atom({ plugin: 'codebridge', key: 'claude' } as const, INITIAL_CLAUDE)
const log = atom({ plugin: 'codebridge', key: 'log' } as const, INITIAL_LOG)

type Result = Record<string, unknown>

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

/** What read_session returns per page by default, and at most; a page never cuts a message, and
 * stays well under the Claude app's ~150,000-character limit per result. */
const PAGE_DEFAULT = 20_000
const PAGE_MAX = 120_000

/**
 * read_session: the transcript itself, whole, no model. With `next`: the next page. With `find`:
 * exchanges containing that text. With `last`: the last N. Otherwise what the app hasn't heard
 * (exchanges finished after `since`, which the relay passes), else the last one.
 */
export async function readSession($: Engine, args: Record<string, unknown>): Promise<Result> {
  const budget = Math.min(PAGE_MAX, Math.max(2_000, Number(args.budget) || PAGE_DEFAULT))
  const cursor = typeof args.next === 'string' && args.next ? decodeCursor(args.next) : undefined
  if (args.next && !cursor) return { error: 'That `next` value is not one read_session gave.' }
  const find = cursor?.f ?? (typeof args.find === 'string' && args.find.trim() ? args.find.trim() : undefined)
  const last = Math.min(50, Math.max(1, Math.round(Number(args.last)) || 0))
  const since = Number(args.since) || 0
  const whole = !!cursor || !!find
  const { exchanges: all } = await readTail($, whole ? Number.POSITIVE_INFINITY : Math.max(last, 20))
  let selection: Exchange[]
  if (cursor) {
    const from = all.findIndex(x => x.id === cursor.s)
    const to = all.findIndex(x => x.id === cursor.e)
    if (from < 0 || to < 0) return { error: 'The transcript changed under that page; ask again without `next`.' }
    selection = all.slice(from, to + 1).filter(x => !find || contains(x, find))
  } else if (find) {
    selection = all.filter(x => contains(x, find))
    if (selection.length === 0) return { exchanges: [], note: `Nothing in this session's transcript contains "${find}".` }
  } else if (last) {
    selection = all.slice(-last)
  } else {
    const unheard = since ? all.filter(x => x.finishedAt && Date.parse(x.finishedAt) > since) : []
    selection = unheard.length ? unheard : all.slice(-1)
  }
  if (selection.length === 0) return { exchanges: [], note: 'This session has no messages yet.' }
  const { items, next } = page(selection, budget, cursor?.o ?? 0, find)
  return {
    exchanges: items,
    ...(next ? { next, note: 'More follows: call read_session with this `next` for the next page. Nothing is cut.' } : {}),
    from: 'oldest first; "from" says who sent each message (computer, Claude app, voice, Remote Control, another session)',
  }
}

const contains = (x: Exchange, text: string) => `${x.message}\n${x.reply}`.toLowerCase().includes(text.toLowerCase())

/**
 * catch_up: the complete picture of a session for the Claude app's assistant to carry on from: a
 * full summary, its status now, anything waiting on the person. The summary is kept in the store
 * (it survives reloads) and brought up to date from the new exchanges only; the first one, or
 * `depth: "full"`, is written from the whole session.
 */
export async function catchUp($: Engine, args: Record<string, unknown>): Promise<Result> {
  const root = await $.session.root()
  const summary = await currentSummary($, args.depth === 'full')
  const got = await $.session.messages({ last: 400 }).catch(() => [] as readonly SessionMessage[])
  const recent: readonly SessionMessage[] = Array.isArray(got) ? got : []
  const files = filesTouched(recent).map(path => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : baseName(path) ?? path))
  const result: Result = {
    now: await claudeStatus($),
    ...(summary.text
      ? { summary: summary.text, summaryCovers: summary.covers, summaryMade: summary.how }
      : { summary: 'No summary could be written yet.', why: summary.how }),
    ...(files.length ? { filesTouched: files } : {}),
    note: 'For any message word for word, call read_session.',
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
