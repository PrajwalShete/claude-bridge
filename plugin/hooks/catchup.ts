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
import { type Exchange, decodeCursor, encodeCursor, page, readForward, scanBack, transcriptFile } from './transcript'
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
/** How much of the transcript one search page looks through at most (then it says where to go on). */
const SEARCH_SLICE = 48 * 1024 * 1024

/**
 * read_session: the transcript itself, whole, no model, reading only as much of the file as the
 * answer needs, backwards from its end, each byte once. With `next`: the next page, read straight
 * from where it starts. With `find`: matches, newest first, a page at a time, each page going on
 * further back from where the last one stopped. With `last`: the last N. Otherwise what the app
 * hasn't heard (exchanges finished after `since`, which the relay passes), else the last one.
 */
export async function readSession($: Engine, args: Record<string, unknown>): Promise<Result> {
  const budget = Math.min(PAGE_MAX, Math.max(2_000, Number(args.budget) || PAGE_DEFAULT))
  const cursor = typeof args.next === 'string' && args.next ? decodeCursor(args.next) : undefined
  if (args.next && !cursor) return { error: 'That `next` value is not one read_session gave.' }
  const find = cursor?.f ?? (typeof args.find === 'string' && args.find.trim() ? args.find.trim() : undefined)
  const { read, size } = await transcriptFile($)

  if (find) {
    // Newest matches first; a page goes back only as far as it takes to fill it.
    const from = cursor ? cursor.e : size
    // A page also stops after SEARCH_SLICE bytes, so one call stays quick on any size of session.
    const scan = await scanBack(read, from, (list, n) => {
      const hits = list.filter(x => contains(x, find))
      return hits.reduce((sum, x) => sum + x.message.length + x.reply.length, 0) > budget || n >= SEARCH_SLICE
    })
    const matches = scan.exchanges.filter(x => contains(x, find)).reverse()
    if (matches.length === 0) {
      if (scan.atStart || scan.exchanges.length === 0) {
        return { exchanges: [], read: bytes(scan.bytesRead), note: `Nothing ${cursor ? 'further back ' : ''}in this session's transcript contains "${find}".` }
      }
      return {
        exchanges: [],
        read: bytes(scan.bytesRead),
        next: encodeCursor({ s: scan.exchanges[0]!.start, e: scan.exchanges[0]!.start, o: 0, f: find }),
        note: `No match back to ${scan.exchanges[0]!.at}; older parts remain: call read_session with this \`next\` to search further back.`,
      }
    }
    const { items, stop } = page(matches, budget, cursor?.o ?? 0)
    // Where the search goes on: from the match the page stopped in; else, if the file's start
    // wasn't reached, from the oldest exchange this page looked at (all newer ones are done).
    const nextCursor = stop
      ? encodeCursor({ s: matches[stop.index]!.start, e: matches[stop.index]!.end, o: stop.offset, f: find })
      : !scan.atStart && scan.exchanges.length
        ? encodeCursor({ s: scan.exchanges[0]!.start, e: scan.exchanges[0]!.start, o: 0, f: find })
        : undefined
    return {
      exchanges: items,
      order: 'newest first',
      ...(nextCursor ? { next: nextCursor, note: 'More may lie further back: call read_session with this `next`.' } : {}),
      read: bytes(scan.bytesRead),
    }
  }

  let selection: Exchange[]
  let bytesRead = 0
  if (cursor) {
    // The next page of a selection: read only its own bytes.
    const scan = await readForward(read, cursor.s, Math.min(cursor.e, size))
    bytesRead = scan.bytesRead
    selection = scan.exchanges
  } else {
    const last = Math.min(50, Math.max(0, Math.round(Number(args.last)) || 0))
    const since = Number(args.since) || 0
    const scan = await scanBack(read, size, list =>
      last ? list.length >= last : since ? list.some(x => x.finishedAt && Date.parse(x.finishedAt) <= since) : list.length >= 1,
    )
    bytesRead = scan.bytesRead
    const all = scan.exchanges
    const unheard = !last && since ? all.filter(x => x.finishedAt && Date.parse(x.finishedAt) > since) : []
    selection = last ? all.slice(-last) : unheard.length ? unheard : all.slice(-1)
  }
  if (selection.length === 0) return { exchanges: [], note: 'This session has no messages yet.' }
  const { items, stop } = page(selection, budget, cursor?.o ?? 0)
  return {
    exchanges: items,
    order: 'oldest first',
    ...(stop
      ? {
          next: encodeCursor({ s: selection[stop.index]!.start, o: stop.offset, e: selection.at(-1)!.end }),
          note: 'More follows: call read_session with this `next` for the next page. Nothing is cut.',
        }
      : {}),
    from: '"from" says who sent each message (computer, Claude app, voice, Remote Control, another session)',
    read: bytes(bytesRead),
  }
}

const contains = (x: Exchange, text: string) => `${x.message}\n${x.reply}`.toLowerCase().includes(text.toLowerCase())
const bytes = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB of the transcript read`

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
