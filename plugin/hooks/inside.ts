// The no-helper mode: this session talks to the relay itself, over HTTP, from inside Claude Code,
// for computers that won't run the plugin's helper programs (a managed Mac that blocks programs
// it hasn't approved). It does what the connector (connector.swift) and the device agent
// (device.swift) do there:
//   - one request at a time waits at the relay (POST /peer, held up to 25 s) for what comes to
//     this session: the Claude app's calls, and the welcome, watched and paused notices;
//   - what this session says (its state, news, answers to calls) goes at once, in a request of
//     its own;
//   - it answers for the computer too (`serveDevice`: projects, sessions, starting, resuming,
//     renaming, forking), while the Claude app runs one of its sessions;
//   - Claude Code's questions wait on the relay's mailbox (POST /peer/answer).
// Waiting on `$.http.fetch` costs the hooks none of their time budget.

import { atom, read, update } from 'claude-code'

import { COMPUTER_TOOLS, runComputer } from './computer'
import { reportState } from './connector'
import { answerTool } from './tools'
import { type Engine, errorText, note, rt, INITIAL_LINK } from './state'

const link = atom({ plugin: 'codebridge', key: 'link' } as const, INITIAL_LINK)

/** What arrives from the relay. */
type Inbound =
  | { type: 'welcome'; watched?: boolean; paused?: boolean }
  | { type: 'watched'; watched?: boolean }
  | { type: 'paused'; paused?: boolean }
  | { type: 'call'; id: number; tool: string; args?: Record<string, unknown> }
  | { type: 'error'; message?: string }

export type InsideLink = {
  /** Bumped on every (re)start: a loop of an older generation stops. */
  generation: number
  relay: string
  key: string
  hello: Record<string, unknown>
  connected: boolean
  /** The latest state message, sent again whenever the relay welcomes this session anew. */
  lastState?: Record<string, unknown>
  /** News that couldn't go while offline, sent on reconnecting (the latest 20). */
  unsent: Record<string, unknown>[]
  failures: number
  /** When the waiting request went out, for noticing one that never comes back. */
  pollSince: number
}

/** The answer a tool call is waiting for, as an MCP tool result (as connector.swift builds it). */
export function toolResult(response: Record<string, unknown>): Record<string, unknown> {
  const body = { ...response }
  const images = (body._images as Array<{ data?: unknown; mimeType?: unknown }> | undefined) ?? []
  delete body._images
  const isError = body.error !== undefined && body.status === undefined
  // The relay takes messages up to 1 MiB: images that would overflow it are left out, and the answer says so.
  let room = 960_000
  let dropped = 0
  const kept: Array<Record<string, unknown>> = []
  for (const image of images) {
    if (typeof image.data !== 'string' || typeof image.mimeType !== 'string') continue
    if (image.data.length > room) {
      dropped++
      continue
    }
    room -= image.data.length
    kept.push({ type: 'image', data: image.data, mimeType: image.mimeType })
  }
  if (dropped) body.imagesLeftOut = `${dropped} image(s) were too large to send.`
  return { content: [{ type: 'text', text: JSON.stringify(body) }, ...kept], isError }
}

async function computerName($: Engine): Promise<string> {
  const r = await $.process.run(['/usr/sbin/scutil', '--get', 'ComputerName']).catch(() => undefined)
  return r?.stdout.trim() || 'Mac'
}

/** Starts this session's link to the relay, without helper programs. */
export async function startInside($: Engine, opts: { relay: string; key: string; session: string; project: string; folder: string; device: string }): Promise<void> {
  const generation = (rt.inside?.generation ?? 0) + 1
  rt.inside = {
    generation,
    relay: opts.relay,
    key: opts.key,
    hello: { type: 'hello', protocol: 4, session: opts.session, project: opts.project, folder: opts.folder, device: opts.device, serveDevice: true, name: await computerName($) },
    connected: false,
    unsent: [],
    failures: 0,
    pollSince: 0,
  }
  await update($, link, s => ({ ...s, inside: true }))
  await note($, 'connecting without helper programs (from inside Claude)')
  void poll($, generation)
  // A request the network swallowed never answers: one waiting over a minute is given up on.
  rt.insideTimer?.cancel()
  rt.insideTimer = $.clock.every(30_000, async () => {
    const now = await $.clock.now()
    const inside = rt.inside
    if (inside?.generation === generation && inside.pollSince && now - inside.pollSince > 60_000) {
      inside.generation++
      void note($, 'relay request hung; starting a new one')
      void poll($, inside.generation)
    }
  })
}

export async function stopInside($: Engine): Promise<void> {
  rt.insideTimer?.cancel()
  rt.insideTimer = undefined
  if (!rt.inside) return
  rt.inside = undefined
  await update($, link, s => ({ ...s, connected: false, watched: false, inside: false }))
}

/** One exchange with the relay: this session's hello, what it sends, and what comes back. */
async function exchange($: Engine, messages: Record<string, unknown>[], wait: number): Promise<{ ok: boolean; messages: Inbound[]; error?: string }> {
  const inside = rt.inside
  if (!inside) return { ok: false, messages: [] }
  const response = await $.http.fetch(`${inside.relay}/peer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${inside.key}` },
    body: JSON.stringify({ hello: inside.hello, messages, wait }),
  })
  let body: { messages?: Inbound[]; error?: string } = {}
  try {
    body = JSON.parse(response.text) as typeof body
  } catch {
    // not JSON: an error page
  }
  if (!response.ok) return { ok: false, messages: [], error: body.error ?? `the relay answered ${response.status}` }
  return { ok: true, messages: body.messages ?? [] }
}

async function poll($: Engine, generation: number): Promise<void> {
  const inside = rt.inside
  if (!inside || inside.generation !== generation) return
  inside.pollSince = await $.clock.now()
  let result: Awaited<ReturnType<typeof exchange>>
  try {
    result = await exchange($, [], 25)
  } catch (error) {
    result = { ok: false, messages: [], error: errorText(error) }
  }
  const now = rt.inside
  if (!now || now.generation !== generation) return
  now.pollSince = 0
  if (!result.ok) {
    now.failures++
    if (now.connected || now.failures === 1) await note($, `relay unreachable: ${result.error ?? ''}`)
    now.connected = false
    await update($, link, s => ({ ...s, connected: false }))
    // A timer, not a sleep: a sleep would spend the hook's time budget.
    const delay = Math.min(30_000, 500 * 2 ** Math.min(now.failures - 1, 6))
    $.clock.after(delay, () => void poll($, generation))
    return
  }
  now.failures = 0
  await received($, result.messages)
  void poll($, generation)
}

async function received($: Engine, messages: Inbound[]): Promise<void> {
  const inside = rt.inside
  if (!inside) return
  for (const message of messages) {
    if (message.type === 'welcome') {
      const wasConnected = (await read($, link)).connected
      inside.connected = true
      await update($, link, s => ({ ...s, connected: true, watched: message.watched === true, paused: message.paused === true }))
      // The relay knows this session anew (first contact, or it restarted): what it knew goes again.
      const again = [...(inside.lastState ? [inside.lastState] : []), ...inside.unsent.splice(0)]
      if (again.length) void send($, again)
      if (!wasConnected) {
        await note($, 'relay welcomed this session')
        void reportState($)
      }
    } else if (message.type === 'watched') {
      await update($, link, s => ({ ...s, watched: message.watched === true }))
    } else if (message.type === 'paused') {
      await update($, link, s => ({ ...s, paused: message.paused === true }))
    } else if (message.type === 'call') {
      if (COMPUTER_TOOLS.has(message.tool)) void answerForComputer($, message)
      else {
        await note($, `app: ${message.tool} ${JSON.stringify(message.args ?? {}).slice(0, 160)}`)
        void answerTool($, { t: 'tool', id: String(message.id), name: message.tool, args: message.args ?? {} })
      }
    } else if (message.type === 'error') {
      await note($, `relay: ${message.message ?? ''}`)
    }
  }
}

async function answerForComputer($: Engine, call: Extract<Inbound, { type: 'call' }>): Promise<void> {
  await note($, `computer: ${call.tool}`)
  const result = await runComputer($, call.tool, call.args ?? {})
  await send($, [{ type: 'result', id: call.id, result }])
}

/** Sends at once; news that can't go now waits for the reconnect. */
export async function send($: Engine, messages: Record<string, unknown>[]): Promise<boolean> {
  const inside = rt.inside
  if (!inside) return false
  for (const m of messages) if (m.type === 'state') inside.lastState = m
  try {
    const result = await exchange($, messages, 0)
    if (result.ok) {
      await received($, result.messages)
      return true
    }
  } catch {
    // offline: below
  }
  const news = messages.filter(m => m.type === 'event')
  inside.unsent.push(...news)
  if (inside.unsent.length > 20) inside.unsent.splice(0, inside.unsent.length - 20)
  return false
}

/**
 * The connector's command routes, answered here (connector.ts `post` sends them this way in the
 * no-helper mode), so the rest of the plugin doesn't need to know which mode runs.
 */
export async function insideRoute($: Engine, route: string, body: Record<string, unknown>): Promise<unknown> {
  const inside = rt.inside
  if (!inside) return undefined
  switch (route) {
    case '/tool_response':
      return { ok: await send($, [{ type: 'result', id: Number(body.id), result: toolResult((body.response as Record<string, unknown>) ?? {}) }]) }
    case '/state':
      void send($, [{ ...body, type: 'state' }])
      return { ok: true }
    case '/event':
      void send($, [{ ...body, type: 'event' }])
      return { ok: true }
    case '/watch':
      void send($, [{ type: 'watch', watched: body.watched !== false }])
      return { ok: true }
    case '/pause':
      return { ok: inside.connected && (await send($, [{ type: 'pause', paused: body.paused !== false }])) }
    case '/answer':
    case '/wait_answer': {
      // Questions are keyed by session, as the account's mailbox is shared.
      const id = `${String(inside.hello.session)}:${String(body.id)}`
      const response = await $.http.fetch(`${inside.relay}/peer/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${inside.key}` },
        body: JSON.stringify(route === '/answer' ? { id, value: body.value } : { id, seconds: Math.min(25, Math.max(1, Number(body.seconds ?? 8))) }),
      })
      if (!response.ok) return undefined
      const out = JSON.parse(response.text) as { value?: unknown; pending?: boolean }
      return route === '/answer' ? { ok: true } : 'value' in out ? { ok: true, value: out.value } : { ok: true, pending: true }
    }
    case '/ping': {
      const s = await read($, link)
      return { ok: true, connected: s.connected, watched: s.watched, paused: s.paused }
    }
    case '/stop':
      await stopInside($)
      return { ok: true }
    default:
      return { ok: false, error: `unknown route ${route}` }
  }
}
