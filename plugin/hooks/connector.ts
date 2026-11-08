// The connector: a small Swift process (connector/connector.swift) that holds this session's
// WebSocket to the relay. It passes the Claude app's tool calls here as JSON lines and takes
// answers back as HTTP POSTs on a Unix socket.

import { atom, read, update } from 'claude-code'

import { type Engine, type Process, cleanPrompt, errorText, isPersonPrompt, note, rt, INITIAL_LINK, INITIAL_CLAUDE } from './state'
import { deviceId } from './device'
import { answerTool } from './tools'

const link = atom({ plugin: 'codebridge', key: 'link' } as const, INITIAL_LINK)
const claude = atom({ plugin: 'codebridge', key: 'claude' } as const, INITIAL_CLAUDE)

export const DEFAULT_RELAY = 'https://claude-bridge.prajwalshete.com'

export type ConnectorEvent =
  | { t: 'started'; pid: number }
  | { t: 'link'; state: 'connecting' | 'connected' | 'offline'; watched: boolean; paused?: boolean }
  | { t: 'tool'; id: string; name: string; args?: Record<string, unknown> }
  | { t: 'error'; message: string; code?: string }
  | { t: 'log'; message: string }

function relayUrl(): string {
  return (rt.options.relayUrl || DEFAULT_RELAY).replace(/\/+$/, '')
}

/** Where sessions and the device agent connect: the configured URL, else the relay's own address over WebSocket. */
export function chatBase(): string {
  const configured = rt.options.chatUrl?.replace(/\/+$/, '')
  return configured || relayUrl().replace(/^http/, 'ws')
}

function chatUrl(): string {
  return `${chatBase()}/chat/connect`
}

// MARK: The key

function b64url(bytes: Uint8Array): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 6) {
      out += abc[(value >>> (bits - 6)) & 63]
      bits -= 6
    }
  }
  if (bits > 0) out += abc[(value << (6 - bits)) & 63]
  return out
}

export const KEY_PATTERN = /^cbrg_[A-Za-z0-9_-]{40,64}$/

/** The computer's key lives in ~/.config/claude-bridge/key, shared by every session. */
async function keyPath($: Engine): Promise<string> {
  return `${(await $.env.get('HOME')) ?? '/tmp'}/.config/claude-bridge/key`
}

/** The key, made the first time; `fresh` makes a new one; `given` uses one from another computer. */
export async function bridgeKey($: Engine, fresh = false, given?: string): Promise<string> {
  const path = await keyPath($)
  if (!fresh && !given) {
    const saved = String(await $.fs.read(path).catch(() => '')).trim()
    if (KEY_PATTERN.test(saved)) return saved
  }
  const key = given ?? `cbrg_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`
  await $.fs.write(path, `${key}\n`)
  await $.process.run(['chmod', '600', path]).catch(() => undefined)
  return key
}

/** The connector URL for the Claude app: the relay plus an id derived from the key. */
export async function connectorUrl(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))
  const id = [...digest].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 20)
  return `${relayUrl()}/${id}/mcp`
}

// MARK: The process

/**
 * Builds a Swift program from connector/ the first time, or after its source changed: the
 * session connector (connector.swift) or the device agent (device.swift). Sessions starting
 * together may build at once, so each builds to its own file and moves it into place.
 */
export async function ensureBinary($: Engine, which: 'connector' | 'device'): Promise<{ path: string; rebuilt: boolean }> {
  const root = $.plugin.root
  const source = `${root}/connector/${which}.swift`
  const binary = `${root}/connector/bin/claude-bridge-${which}`
  const [src, bin] = await Promise.all([$.fs.stat(source), $.fs.stat(binary).catch(() => undefined)])
  if (bin && bin.mtimeMs >= src.mtimeMs) return { path: binary, rebuilt: false }
  await note($, `building the ${which}`)
  await $.process.run(['mkdir', '-p', `${root}/connector/bin`])
  const temp = `${binary}.${Math.random().toString(36).slice(2, 8)}`
  const built = await $.process
    .run(['swiftc', '-O', '-swift-version', '5', '-o', temp, source], { timeoutMs: 600_000 })
    .catch(() => undefined)
  if (!built) throw new Error('Building Claude Bridge needs Xcode’s command line tools: run xcode-select --install.')
  if (built.exitCode !== 0) {
    await $.process.run(['rm', '-f', temp]).catch(() => undefined)
    const first = built.stderr.split('\n').find(line => line.includes('error')) ?? built.stderr.slice(0, 300)
    throw new Error(`Couldn’t build the ${which}: ${first.trim()}`)
  }
  await $.process.run(['mv', '-f', temp, binary])
  return { path: binary, rebuilt: true }
}

export async function postTo($: Engine, socketPath: string, route: string, body: unknown): Promise<unknown> {
  const response = await $.http.fetch(`http://connector${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    socketPath,
  })
  return response.ok ? JSON.parse(response.text) : undefined
}

/** A command to this session's connector; nothing while it isn't running. */
export async function post($: Engine, route: string, body: unknown): Promise<unknown> {
  return rt.connector ? postTo($, rt.connector.socketPath, route, body) : undefined
}

/** Starts the connector, which keeps this session connected to the relay. */
export async function startConnector($: Engine): Promise<void> {
  if (rt.connector || rt.connectorStarting) return
  rt.connectorStarting = true
  rt.connectorStopping = false
  try {
    const key = await bridgeKey($)
    const url = await connectorUrl(key)
    await update($, link, s => ({ ...s, enabled: true, connected: false, watched: false, url, key }))
    const binary = (await ensureBinary($, 'connector')).path
    const session = await $.session.id()
    const socketPath = `/tmp/claude-bridge-${session.slice(0, 8)}.sock`
    const folder = await $.session.root()
    const project = folder.split('/').filter(Boolean).pop() ?? 'project'
    const stream = $.process.spawn({
      argv: [binary],
      input: JSON.stringify({ relay: chatUrl(), key, session, project, folder, socketPath, device: await deviceId($) }),
    })
    rt.connector = { stream, socketPath }
    await note($, 'connector started')
    void pump($, stream)
  } catch (error) {
    await note($, `connector failed to start: ${errorText(error)}`)
  } finally {
    rt.connectorStarting = false
  }
}

export async function stopConnector($: Engine): Promise<void> {
  const running = rt.connector
  rt.connectorStopping = true
  if (!running) return
  await postTo($, running.socketPath, '/stop', {}).catch(() => undefined)
  $.clock.after(1500, () => {
    if (rt.connector === running) void running.stream.return?.(undefined as never)
  })
}

async function pump($: Engine, stream: Process['stream']): Promise<void> {
  let buffer = ''
  try {
    for await (const piece of stream) {
      if (piece.stream === 'stderr') continue
      buffer += piece.text
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (!line) continue
        let event: ConnectorEvent
        try {
          event = JSON.parse(line) as ConnectorEvent
        } catch {
          continue
        }
        if (event.t === 'link') {
          const wasConnected = (await read($, link)).connected
          await update($, link, s => ({ ...s, connected: event.state === 'connected', watched: event.watched, paused: event.paused === true }))
          if (event.state === 'connected' && !wasConnected) void reportState($)
        } else if (event.t === 'tool') {
          await note($, `app: ${event.name} ${JSON.stringify(event.args ?? {}).slice(0, 160)}`)
          void answerTool($, event)
        } else if (event.t === 'error' || event.t === 'log') {
          await note($, `connector: ${event.message}`)
        }
      }
    }
  } catch (error) {
    await note($, `connector ended: ${errorText(error)}`)
  }
  if (rt.connector?.stream === stream) rt.connector = undefined
  await update($, link, s => ({ ...s, connected: false, watched: false }))
  // A crash or a lost worker should not leave the Claude app talking to no one.
  if (!rt.connectorStopping && (await read($, link)).enabled) {
    await note($, 'connector ended; restarting it')
    $.clock.after(3000, () => void startConnector($))
  }
}

/** Tells the relay what this session is doing (and on which model and effort, for its side chats),
 * for list_sessions and for knowing when news can come. */
export async function reportState($: Engine): Promise<void> {
  const activity = await read($, claude)
  // Before its first request since loading, the session's own setting stands in.
  const model = rt.model || (await $.session.model().catch(() => ''))
  const effort = rt.effort || ((await $.env.get('CLAUDE_EFFORT').catch(() => undefined)) ?? '')
  const task = activity.task && isPersonPrompt(activity.task) ? cleanPrompt(activity.task) : undefined
  await post($, '/state', { working: activity.isWorking, side: rt.isSide, asking: rt.sideOpen.size, ...(rt.parent ? { parent: rt.parent } : {}), runsIn: rt.runsIn, ...(rt.terminalApp ? { terminalApp: rt.terminalApp } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(task ? { task } : {}) }).catch(
    () => undefined,
  )
}

/** A picture for the Claude app: the relay keeps it an hour under a private link. */
export type EventPicture = { data: string; mimeType: string; caption?: string }

/**
 * News for the Claude app's feed. `messages` names the app's messages a turn carried, and
 * `forApp` marks news the app asked for (its messages' turns, its side questions): the relay
 * passes that on even from sessions the app doesn't watch.
 */
export type BridgeEvent = { messages?: string[]; forApp?: boolean } & (
  | { kind: 'started'; text?: string }
  | { kind: 'finished'; text: string; task?: string; changes: string[]; pictures?: EventPicture[] }
  | { kind: 'question'; questions: unknown }
  | { kind: 'stopped' | 'failed'; task?: string }
  | { kind: 'answer'; ask: string; question: string; text: string }
)

export async function sendEvent($: Engine, event: BridgeEvent): Promise<void> {
  // Paused: nothing goes to the Claude app.
  if ((await read($, link)).paused) return
  await post($, '/event', event).catch(() => undefined)
}

/** Adds this session to the Claude app's watch list, or takes it off. */
export async function setWatched($: Engine, on: boolean): Promise<void> {
  await post($, '/watch', { watched: on }).catch(() => undefined)
}
