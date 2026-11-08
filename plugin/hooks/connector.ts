// The connector: a small Swift process (connector/connector.swift) that holds this session's
// WebSocket to the relay. It passes the Claude app's tool calls here as JSON lines and takes
// answers back as HTTP POSTs on a Unix socket.

import { atom, read, update } from 'claude-code'

import { type Engine, type Process, cleanPrompt, errorText, isPersonPrompt, note, rt, INITIAL_LINK, INITIAL_CLAUDE } from './state'
import { deviceId } from './device'
import { startLinking } from './link'
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

export function relayUrl(): string {
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

/** The account's key (`cbrg_…`), the one the Claude app signs in with. */
export const KEY_PATTERN = /^cbrg_[A-Za-z0-9_-]{40,64}$/
/** A linked computer's own credential (`cbd_<account id>_<secret>`), given from the Claude app. */
export const DEVICE_CREDENTIAL = /^cbd_([a-f0-9]{20})_([A-Za-z0-9_-]{40,64})$/

/** The computer's key lives in ~/.config/claude-bridge/key, shared by every session. */
async function keyPath($: Engine): Promise<string> {
  return `${(await $.env.get('HOME')) ?? '/tmp'}/.config/claude-bridge/key`
}

/** The key, made the first time; `fresh` makes a new one; `given` uses one from another computer. */
/** This computer's saved credential (the account's key, or a linked computer's own), or ''. */
export async function savedCredential($: Engine): Promise<string> {
  const saved = String(await $.fs.read(await keyPath($)).catch(() => '')).trim()
  return KEY_PATTERN.test(saved) || DEVICE_CREDENTIAL.test(saved) ? saved : ''
}

/**
 * The credential, saved: `fresh` makes a new account key (a new account, the first computer),
 * `given` stores one handed over (another computer's key, or the credential linking gave).
 */
export async function bridgeKey($: Engine, fresh = false, given?: string): Promise<string> {
  const path = await keyPath($)
  if (!fresh && !given) {
    const saved = await savedCredential($)
    if (saved) return saved
  }
  const key = given ?? `cbrg_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`
  await $.fs.write(path, `${key}\n`)
  await $.process.run(['chmod', '600', path]).catch(() => undefined)
  return key
}

/** The connector URL for the Claude app: the relay plus an id derived from the key. */
export async function connectorUrl(key: string): Promise<string> {
  const linked = key.match(DEVICE_CREDENTIAL)
  if (linked) return `${relayUrl()}/${linked[1]}/mcp`
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))
  const id = [...digest].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 20)
  return `${relayUrl()}/${id}/mcp`
}

// MARK: The process

/**
 * Puts one of the plugin's Swift programs (the session connector, `connector.swift`, or the
 * device agent, `device.swift`) where this computer runs it: `~/.config/claude-bridge/bin/`, a
 * path that stays put when the plugin updates.
 *
 * The plugin carries both prebuilt (universal, in `connector/prebuilt/`, each stamped with the
 * SHA-256 of its source), so a computer needs no Xcode: the matching one is copied into place and
 * made executable. Only where a source changed since (a development copy) is it built with
 * `swiftc`. Sessions starting together each write their own file and move it into place.
 */
export async function ensureBinary($: Engine, which: 'connector' | 'device'): Promise<{ path: string; rebuilt: boolean }> {
  const root = $.plugin.root
  const source = `${root}/connector/${which}.swift`
  const dir = `${(await $.env.get('HOME').catch(() => undefined)) ?? '/tmp'}/.config/claude-bridge/bin`
  const binary = `${dir}/claude-bridge-${which}`
  const stampPath = `${binary}.sha256`
  const bytes = new TextEncoder().encode(String(await $.fs.read(source)))
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
  const [installed, stamp] = await Promise.all([
    $.fs.stat(binary).catch(() => undefined),
    $.fs.read(stampPath).then(String).catch(() => ''),
  ])
  if (installed && stamp.trim() === digest) return { path: binary, rebuilt: false }

  await $.process.run(['mkdir', '-p', dir])
  const temp = `${binary}.${Math.random().toString(36).slice(2, 8)}`
  const prebuilt = `${root}/connector/prebuilt/claude-bridge-${which}`
  const prebuiltStamp = await $.fs.read(`${prebuilt}.sha256`).then(String).catch(() => '')
  if (prebuiltStamp.trim() === digest) {
    await note($, `installing the prebuilt ${which}`)
    await $.process.run(['cp', prebuilt, temp])
    // A plugin synced from the account may arrive without its executable bit, or quarantined.
    await $.process.run(['chmod', '755', temp])
    await $.process.run(['xattr', '-d', 'com.apple.quarantine', temp]).catch(() => undefined)
  } else {
    await note($, `building the ${which} from source`)
    const built = await $.process
      .run(['swiftc', '-O', '-swift-version', '5', '-o', temp, source], { timeoutMs: 600_000 })
      .catch(() => undefined)
    if (!built) throw new Error('This copy of Claude Bridge has no prebuilt program for this version; building it needs Xcode’s command line tools: run xcode-select --install.')
    if (built.exitCode !== 0) {
      await $.process.run(['rm', '-f', temp]).catch(() => undefined)
      const first = built.stderr.split('\n').find(line => line.includes('error')) ?? built.stderr.slice(0, 300)
      throw new Error(`Couldn’t build the ${which}: ${first.trim()}`)
    }
  }
  await $.process.run(['mv', '-f', temp, binary])
  await $.fs.write(stampPath, `${digest}\n`)
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
    // A computer with no credential yet links itself first (link.ts); it connects once linked.
    const key = await savedCredential($)
    if (!key) {
      await update($, link, s => ({ ...s, enabled: true, connected: false, watched: false, url: '', key: '' }))
      void startLinking($)
      return
    }
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
