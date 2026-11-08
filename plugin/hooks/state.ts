// The plugin's shared state: the values the panel draws from (`$.state`, kept by the host
// across reloads) and the runtime the hooks share (module memory, reset on each load).

import { atom, update } from 'claude-code'
import type { EngineInterface, Timer } from 'claude-code'

import type { ClaudeActivity, LinkState, LogEntry, MessageStatus, PendingQuestion } from '../types'
import type { Picture } from './images'
import type { InsideLink } from './inside'

export type Engine = EngineInterface

export const PANE = 'claude-bridge'

// Every file that reads or writes a value declares its own atom for it (the validator checks
// each `$.state` key where it is used); the starting values they share live here.
export const INITIAL_LINK: LinkState = { enabled: true, connected: false, watched: false, paused: false, url: '', key: '', askFirst: false, screen: true, openIn: 'auto', linkCode: '', helpers: 'auto', inside: false }
export const INITIAL_CLAUDE: ClaudeActivity = { isWorking: false, tools: [], replies: [] }
export const INITIAL_LOG: LogEntry[] = []
export const NO_QUESTION = null as PendingQuestion | null

const log = atom({ plugin: 'codebridge', key: 'log' } as const, INITIAL_LOG)

/** The connector process: its output stream and the Unix socket it takes commands on. */
export type Process = { stream: ReturnType<Engine['process']['spawn']>; socketPath: string }

/** Module memory the hooks share. Reset on every load; nothing here outlives the module. */
export const rt = {
  options: {} as { relayUrl?: string; chatUrl?: string },
  connector: undefined as Process | undefined,
  connectorStarting: false,
  connectorStopping: false,
  /** The running connector said it started (so helper programs run on this computer). */
  connectorRan: false,
  /** The no-helper mode's link to the relay (inside.ts), when this session runs that way. */
  inside: undefined as InsideLink | undefined,
  insideTimer: undefined as Timer | undefined,
  /** The desktop app's session records, read at most every 10 s (computer.ts). */
  desktopCache: undefined as { at: number; rows: unknown[] } | undefined,
  /** Ids of the app's messages whose prompt entered before its turn.start ran (see MARK below). */
  entering: [] as string[],
  /** The ids of the app's messages the running turn carries; queued ones can arrive together. */
  turnEntries: [] as string[],
  /** The running main-loop turn and when it started; undefined between turns. */
  turn: undefined as { id: string; startedAt: number } | undefined,
  lastSentText: { text: '', at: 0 },
  /** After the person interrupts, Claude Code drops plugin prompts until they type one. */
  stopStands: false,
  ticker: undefined as Timer | undefined,
  /** Pictures Claude Code shared (share_image) in its latest turn: they go with its reply. */
  shared: [] as Picture[],
  /** Side questions (forks of the session) still running, by agent id. */
  sideOpen: new Map<string, { question: string; startedAt: number }>(),
  /** This session is a side chat (a fork of another session), as its first prompt says. */
  isSide: false,
  /** The session a side chat the Claude app forked came from (its id). */
  parent: '' as string,
  /** Where this session runs: the desktop app, or the CLI in a terminal (and which terminal app). */
  runsIn: 'desktop' as 'desktop' | 'terminal',
  terminalApp: '' as string,
  /** The model and effort the main loop's requests go out with now (its latest turn.step), so a
   * side chat forked from it runs on the same. */
  model: '' as string,
  effort: '' as string,
  /** A briefing on the session for catch_up, refreshed after the turns the Claude app may catch up on. */
  brief: { text: '', at: 0 },
  /** The brief being made right now, which a second caller waits on. */
  briefRun: undefined as Promise<void> | undefined,
  traceFile: '/tmp/claude-bridge.log',
  /** This computer's id, once read. */
  deviceId: '' as string,
  /** When Make a new key was first pressed, for its confirming second press. */
  newKeyAskedAt: 0,
  /** When switching away from this computer's own account was first pressed, for its confirming second press. */
  switchAskedAt: 0,
  /** This session puts the app's messages in its prompt box instead of running them. */
  askFirst: false,
  /** Waiting for this computer to be linked from the Claude app (link.ts). */
  linking: false,
}

/** Whether this session has a link to the relay: the connector's, or its own (no-helper mode). */
export function bridgeUp(): boolean {
  return !!rt.connector || !!rt.inside
}

// MARK: Message ids
//
// Each message from the app has an id (its log entry's). `$.prompt.submit` resolves the moment
// the prompt's turn starts (a plugin's prompt runs only once the session is idle, so no other turn
// can start in between), so that is when the id joins the running turn. Should the resolution
// come before the turn's own turn.start, the id waits in `rt.entering` and that turn.start
// takes it. Prompts that enter together resolve into the same turn, which then carries all of
// them. No text is compared, and nothing is added to the prompt.

// MARK: Small helpers

const trace: string[] = []

/** A short trace of what the bridge did, for diagnosis: /tmp/claude-bridge-<session id>.log, one per session. */
export async function note($: Engine, line: string): Promise<void> {
  const at = new Date(await $.clock.now()).toISOString().slice(11, 23)
  trace.push(`${at} ${line}`)
  if (trace.length > 400) trace.splice(0, trace.length - 400)
  await $.fs.write(rt.traceFile, `${trace.join('\n')}\n`).catch(() => undefined)
  $.ui.log(`claude-bridge: ${line}`, { to: 'debug' })
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} seconds`
  const m = Math.round(s / 60)
  if (m < 60) return m === 1 ? 'a minute' : `${m} minutes`
  const h = Math.round(m / 60)
  return h === 1 ? 'an hour' : `${h} hours`
}

export function short(text: string, limit = 140): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > limit ? `${one.slice(0, limit - 1)}…` : one
}

/** A prompt as the person wrote it: without the system notes the app wraps around it. */
export function cleanPrompt(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<\/?[a-z][\w-]*(\s[^>]*)?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** User rows that aren't the person speaking: notices the engine, tools and the app add as prompts. */
const NOT_THE_PERSON = /^\s*(\[Subagent hand-back\]|<task-notification>|<local-command-|<command-(name|message|args)>|Caveat: The messages below|#*\s*The user forked this session|## Side chat\b)/

/** Whether a prompt is the person's own words, not a notice. */
export function isPersonPrompt(raw: string): boolean {
  return !!raw.trim() && !NOT_THE_PERSON.test(raw)
}

export function baseName(path: unknown): string | undefined {
  return typeof path === 'string' ? path.split('/').filter(Boolean).pop() : undefined
}

export async function addLog(
  $: Engine,
  entry: Omit<LogEntry, 'id' | 'at'> & Partial<Pick<LogEntry, 'id'>>,
): Promise<string> {
  const at = await $.clock.now()
  const id = entry.id ?? `l${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const full: LogEntry = { ...entry, id, at }
  await update($, log, list => [...list.filter(one => one.id !== id), full].slice(-50))
  return id
}

export async function setStatus($: Engine, id: string | undefined, status: MessageStatus): Promise<void> {
  if (!id) return
  await update($, log, list => list.map(one => (one.id === id ? { ...one, status } : one)))
}

