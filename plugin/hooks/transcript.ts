// Reading a session's own transcript (~/.claude/projects/<folder>/<id>.jsonl): the only record of
// what was said. No model: read_session returns what is there, whole, and catch_up's summary is
// built from it. The file's format is Claude Code's, not a documented contract, so every field is
// read defensively and anything unrecognised is skipped rather than guessed.
//
//   origin     who sent each message: typed on the computer, the Claude app (this plugin), voice,
//              Remote Control, another session. Claude Code writes it on every user row.
//   exchanges  one message from a person + Claude Code's final reply + what it changed. Compaction
//              summaries, interrupt markers, notices and tool results are not exchanges.

import type { ToolUseSummary } from 'claude-code'

import { changesOf } from './claude'
import type { Engine } from './state'

export type Exchange = {
  /** The row id of the message, a stable place in the transcript. */
  id: string
  from: string
  at: string
  message: string
  reply: string
  changes: string[]
  /** The reply's last row: when the turn ended (empty while it is still running). */
  finishedAt: string
  /** The conversation was compacted just before this message. */
  afterCompaction?: true
}

type Row = Record<string, unknown> & { type?: string; uuid?: string; timestamp?: string; message?: { content?: unknown } }

/** This session's transcript file. */
export async function transcriptPath($: Engine): Promise<string> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const root = await $.session.root()
  return `${home}/.claude/projects/${root.replace(/[^A-Za-z0-9]/g, '-')}/${await $.session.id()}.jsonl`
}

/** Who sent a user row, from Claude Code's own `origin`; undefined when the row has none. */
function sender(row: Row): string | undefined {
  const o = row.origin as { kind?: string; name?: string } | undefined
  if (!o?.kind) return undefined
  if (o.kind === 'human') return 'computer'
  if (o.kind === 'plugin') return o.name === 'codebridge' ? 'Claude app' : o.name === 'voice' ? 'voice' : `plugin ${o.name ?? ''}`.trim()
  if (o.kind === 'bridge') return 'Remote Control'
  if (o.kind === 'peer') return 'another session'
  return undefined
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map(b => b.text)
    .join('\n')
}

const INTERRUPT = /^\s*\[Request interrupted by user/

/**
 * Exchanges from transcript text (whole lines; a partial first line is skipped). Only rows from
 * a person count as messages: with `origin` (current Claude Code), or for older rows without it,
 * a plain text row that isn't a notice, a tool result, a compaction summary or an interrupt.
 */
export function exchangesFrom(text: string): Exchange[] {
  const out: Exchange[] = []
  let current: (Exchange & { uses: ToolUseSummary[] }) | undefined
  let compacted = false
  const close = () => {
    if (!current) return
    const { uses, ...x } = current
    out.push({ ...x, changes: changesOf(uses) })
    current = undefined
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let row: Row
    try {
      row = JSON.parse(line) as Row
    } catch {
      continue
    }
    if (row.isSidechain === true) continue
    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      compacted = true
      continue
    }
    if (row.type === 'user') {
      const content = row.message?.content
      const hasToolResult = Array.isArray(content) && content.some(b => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result')
      if (hasToolResult || row.isMeta === true || row.isCompactSummary === true) continue
      const text = textOf(content).trim()
      if (!text || INTERRUPT.test(text)) continue
      const from = sender(row) ?? (row.origin === undefined && !/^\s*</.test(text) ? 'computer' : undefined)
      if (!from) continue
      close()
      current = { id: String(row.uuid ?? ''), from, at: String(row.timestamp ?? ''), message: text, reply: '', changes: [], finishedAt: '', uses: [] }
      if (compacted) current.afterCompaction = true
      compacted = false
    } else if (row.type === 'assistant' && current) {
      const content = row.message?.content
      const said = textOf(content).trim()
      if (said) current.reply = said
      if (Array.isArray(content)) {
        for (const b of content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) {
          if (b?.type === 'tool_use') current.uses.push({ tool: b.name ?? '', input: b.input ?? {} } as unknown as ToolUseSummary)
        }
      }
      current.finishedAt = String(row.timestamp ?? '')
    }
  }
  close()
  return out
}

/**
 * The transcript's last part, enough for `need` exchanges: read from the end in growing windows
 * (1, 4, 16 MB, then the whole file), so a long session isn't read whole for its last message.
 */
export async function readTail($: Engine, need: number, file?: string): Promise<{ exchanges: Exchange[]; whole: boolean }> {
  const path = file ?? (await transcriptPath($))
  const size = (await $.fs.stat(path)).size
  for (const window of [1 << 20, 4 << 20, 16 << 20, Infinity]) {
    const offset = Math.max(0, size - window)
    const text = String(await $.fs.read(path, { offset, length: size - offset }))
    const exchanges = exchangesFrom(offset > 0 ? text.slice(text.indexOf('\n') + 1) : text)
    // One more than asked, so the first is known to be complete (its message is in the window).
    if (offset === 0) return { exchanges, whole: true }
    if (exchanges.length > need) return { exchanges: exchanges.slice(1), whole: false }
  }
  return { exchanges: [], whole: true }
}

// MARK: Pages

/** Where a page continues: from exchange `s` (at `o` characters into it) through exchange `e`,
 * among those containing `f` when a search made the selection. */
export type Cursor = { s: string; o: number; e: string; f?: string }

export const encodeCursor = (c: Cursor) => encodeURIComponent(JSON.stringify(c))
export function decodeCursor(text: string): Cursor | undefined {
  try {
    const c = JSON.parse(decodeURIComponent(text)) as Cursor
    return typeof c.s === 'string' && typeof c.e === 'string' && typeof c.o === 'number' ? c : undefined
  } catch {
    return undefined
  }
}

/**
 * One page of the selection, oldest first, at most `budget` characters, never cutting a message:
 * a message larger than a page continues on the next page, marked so, from where it stopped.
 */
export function page(selection: Exchange[], budget: number, offset = 0, find?: string): { items: unknown[]; next?: string } {
  const items: unknown[] = []
  let room = budget
  const last = selection.at(-1)
  for (const [i, x] of selection.entries()) {
    const body = `${x.message}\u0000${x.reply}`
    const start = i === 0 ? offset : 0
    const rest = body.length - start
    if (rest > room && items.length > 0) return { items, next: encodeCursor({ s: x.id, o: 0, e: last!.id, ...(find ? { f: find } : {}) }) }
    if (rest > room) {
      // Larger than a whole page: this page carries part of it; the next carries on exactly there.
      const end = start + room
      const [m, r] = splitAt(body, start, end)
      items.push({ ...meta(x), part: `characters ${start + 1}-${end} of ${body.length - 1}; continues on the next page`, ...m, ...r })
      return { items, next: encodeCursor({ s: x.id, o: end, e: last!.id, ...(find ? { f: find } : {}) }) }
    }
    const [m, r] = splitAt(body, start, body.length)
    items.push({ ...meta(x), ...(start > 0 ? { part: 'continued from the previous page, to its end' } : {}), ...m, ...r })
    room -= rest
  }
  return { items }
}

function meta(x: Exchange) {
  return {
    from: x.from,
    at: x.at,
    ...(x.afterCompaction ? { note: 'The conversation was compacted just before this message.' } : {}),
    ...(x.changes.length ? { changes: x.changes } : {}),
    ...(x.finishedAt ? {} : { status: 'still running' }),
  }
}

/** The message and reply parts of `body` (message \0 reply) within [start, end). */
function splitAt(body: string, start: number, end: number): [Record<string, string>, Record<string, string>] {
  const sep = body.indexOf('\u0000')
  const m = body.slice(Math.min(start, sep), Math.min(end, sep))
  const r = body.slice(Math.max(start, sep + 1), Math.max(end, sep + 1))
  return [start < sep ? { message: m } : {}, end > sep + 1 ? { reply: r || '(no reply yet)' } : {}]
}
