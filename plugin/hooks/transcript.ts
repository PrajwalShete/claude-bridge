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
  /** Where it is in the file: its message's first byte, and the byte after its last row. */
  start: number
  end: number
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

type Row = Record<string, unknown> & { type?: string; uuid?: string; timestamp?: string; message?: { content?: unknown }; _start?: number; _end?: number }

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
 * Exchanges from rows in file order. Only rows from a person count as messages: with `origin`
 * (current Claude Code), or for older rows without it, a plain text row that isn't a notice, a tool
 * result, a compaction summary or an interrupt. Rows before the first message belong to an
 * exchange whose message lies earlier, and are left for a read that reaches it.
 */
function buildExchanges(rows: readonly Row[]): Exchange[] {
  const out: Exchange[] = []
  let current: (Exchange & { uses: ToolUseSummary[] }) | undefined
  let compacted = false
  const close = () => {
    if (!current) return
    const { uses, ...x } = current
    out.push({ ...x, changes: changesOf(uses) })
    current = undefined
  }
  for (const row of rows) {
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
      const at = row._start ?? 0
      current = { id: String(row.uuid ?? ''), start: at, end: row._end ?? at, from, at: String(row.timestamp ?? ''), message: text, reply: '', changes: [], finishedAt: '', uses: [] }
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
      current.end = row._end ?? current.end
    }
  }
  close()
  return out
}

/** The rows of one line that matter here (messages, replies, compaction marks); others are skipped unparsed. */
function rowOf(text: string, start: number, end: number): Row | undefined {
  if (!text.startsWith('{')) return undefined
  if (!text.includes('"type":"user"') && !text.includes('"type":"assistant"') && !text.includes('compact_boundary')) return undefined
  try {
    const row = JSON.parse(text) as Row
    if (row.type !== 'user' && row.type !== 'assistant' && row.type !== 'system') return undefined
    row._start = start
    row._end = end
    return row
  } catch {
    return undefined // a line still being written
  }
}

/** Exchanges from transcript text (whole lines; tests and small reads). */
export function exchangesFrom(text: string): Exchange[] {
  const rows: Row[] = []
  for (const line of text.split('\n')) {
    const row = rowOf(line, 0, 0)
    if (row) rows.push(row)
  }
  return buildExchanges(rows)
}

// MARK: Reading the file

/** Reads bytes [offset, offset + length) of the transcript as `{ base64 }`. */
export type ReadFn = (offset: number, length: number) => Promise<unknown>

/** Bytes per read: base64 of it stays under the 4 MiB Claude Code allows one read's answer. */
export const PIECE = 3 * 1024 * 1024 - 3

const B64 = (() => {
  const t = new Uint8Array(128).fill(255)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (let i = 0; i < chars.length; i++) t[chars.charCodeAt(i)] = i
  return t
})()

/** Bytes from base64, decoded by hand (no Node and no DOM in the plugin's environment). */
function fromBase64(b64: string): Uint8Array {
  const out = new Uint8Array(Math.floor((b64.length * 3) / 4))
  let n = 0
  let acc = 0
  let bits = 0
  for (let i = 0; i < b64.length; i++) {
    const v = B64[b64.charCodeAt(i)] ?? 255
    if (v === 255) continue
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[n++] = (acc >> bits) & 255
    }
  }
  return out.subarray(0, n)
}

const utf8 = new TextDecoder()

/** One piece of the file, as bytes. */
async function piece(read: ReadFn, from: number, to: number): Promise<Uint8Array> {
  const got = (await read(from, to - from)) as { base64?: string }
  return fromBase64(got.base64 ?? '')
}

/** Where a scan stopped: the exchanges it found (oldest first, each complete), and whether it reached the start. */
export type Scan = { exchanges: Exchange[]; atStart: boolean; bytesRead: number }

/**
 * Reads the transcript backwards from `to`, a piece at a time, each byte once, decoding whole lines
 * from the raw bytes (a line that spans two pieces is joined as bytes, so no character is ever cut),
 * and stops as soon as `enough` says so, or at the start of the file.
 */
export async function scanBack(read: ReadFn, to: number, enough: (exchanges: Exchange[], bytesRead: number) => boolean): Promise<Scan> {
  let rows: Row[] = []
  let carry: Uint8Array = new Uint8Array(0) // the start of a line whose beginning is in an earlier piece
  let end = to
  let bytesRead = 0
  while (end > 0) {
    const start = Math.max(0, end - PIECE)
    const got = await piece(read, start, end)
    bytesRead += got.length
    const buf = new Uint8Array(got.length + carry.length)
    buf.set(got)
    buf.set(carry, got.length)
    // The first segment continues a line from further back, unless this piece starts the file.
    let first = start === 0 ? 0 : buf.indexOf(10) + 1
    if (start > 0 && first === 0) {
      carry = buf // one line longer than a piece: keep gathering it
      end = start
      continue
    }
    const batch: Row[] = []
    for (let at = first; at < buf.length; ) {
      let nl = buf.indexOf(10, at)
      if (nl < 0) nl = buf.length
      const row = rowOf(utf8.decode(buf.subarray(at, nl)), start + at, start + nl + 1)
      if (row) batch.push(row)
      at = nl + 1
    }
    rows = [...batch, ...rows]
    carry = start === 0 ? new Uint8Array(0) : buf.subarray(0, first)
    end = start
    const exchanges = buildExchanges(rows)
    if (end === 0 || enough(exchanges, bytesRead)) return { exchanges, atStart: end === 0, bytesRead }
  }
  return { exchanges: buildExchanges(rows), atStart: true, bytesRead }
}

/** The exchanges in bytes [from, to), which start on a message: for continuing a page. */
export async function readForward(read: ReadFn, from: number, to: number): Promise<Scan> {
  let rows: Row[] = []
  let carry: Uint8Array = new Uint8Array(0)
  let bytesRead = 0
  for (let at = from; at < to; ) {
    const stop = Math.min(to, at + PIECE)
    const got = await piece(read, at, stop)
    bytesRead += got.length
    const buf = new Uint8Array(carry.length + got.length)
    buf.set(carry)
    buf.set(got, carry.length)
    const base = at - carry.length
    let i = 0
    for (;;) {
      const nl = buf.indexOf(10, i)
      if (nl < 0) break
      const row = rowOf(utf8.decode(buf.subarray(i, nl)), base + i, base + nl + 1)
      if (row) rows.push(row)
      i = nl + 1
    }
    carry = buf.subarray(i)
    at = stop
  }
  if (carry.length) {
    const row = rowOf(utf8.decode(carry), to - carry.length, to)
    if (row) rows.push(row)
  }
  return { exchanges: buildExchanges(rows), atStart: from === 0, bytesRead }
}

/** This session's transcript as a ReadFn, and its size now. */
export async function transcriptFile($: Engine, file?: string): Promise<{ read: ReadFn; size: number }> {
  const path = file ?? (await transcriptPath($))
  const size = (await $.fs.stat(path)).size
  return { read: (offset, length) => $.fs.read(path, { as: 'bytes', offset, length }), size }
}

// MARK: Pages

/** Where a page continues: from the exchange starting at byte `s`, `o` characters into it.
 * Without `f`: the selection runs forward to byte `e`. With `f` (a search): newer matches were
 * given; the search goes on backwards from that exchange (which ends at byte `e`). */
export type Cursor = { s: number; o: number; e: number; f?: string }

export const encodeCursor = (c: Cursor) => encodeURIComponent(JSON.stringify(c))
export function decodeCursor(text: string): Cursor | undefined {
  try {
    const c = JSON.parse(decodeURIComponent(text)) as Cursor
    return typeof c.s === 'number' && typeof c.e === 'number' && typeof c.o === 'number' ? c : undefined
  } catch {
    return undefined
  }
}

/**
 * One page of the selection, in its order, at most `budget` characters, never cutting a message: a
 * message larger than a page continues on the next page from where it stopped. Says where the next
 * page starts (an index in the selection, and how far into that exchange).
 */
export function page(selection: Exchange[], budget: number, offset = 0): { items: unknown[]; stop?: { index: number; offset: number } } {
  const items: unknown[] = []
  let room = budget
  for (const [i, x] of selection.entries()) {
    const body = `${x.message}\u0000${x.reply}`
    const start = i === 0 ? offset : 0
    const rest = body.length - start
    if (rest > room && items.length > 0) return { items, stop: { index: i, offset: 0 } }
    if (rest > room) {
      const end = start + room
      const [m, r] = splitAt(body, start, end)
      items.push({ ...meta(x), part: `characters ${start + 1}-${end} of ${body.length - 1}; continues on the next page`, ...m, ...r })
      return { items, stop: { index: i, offset: end } }
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
