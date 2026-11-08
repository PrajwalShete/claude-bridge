// Claude Bridge for Claude Code: lets the Claude app (voice mode included) reach this session.
// This module wires the hooks; the work lives beside it:
//   connector.ts  the Swift connector process and the computer's key
//   tools.ts      the tools the Claude app calls, and waiting for Claude Code's reply
//   claude.ts     submitting prompts and reading what Claude Code did
//   questions.ts  Claude Code's questions, answered from the app or the panel
//   view.tsx      the panel and the strip above the prompt
//   state.ts      the values they share

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { changesOfLastTurn, describeTool } from './claude'
import { type Picture, prepareImage } from './images'
import { refreshBrief, sideFinished } from './side'
import { type EventPicture, KEY_PATTERN, bridgeKey, post, reportState, sendEvent, setWatched, startConnector, stopConnector } from './connector'
import { computerSetting, ensureDeviceAgent, setComputerSetting, stopDeviceAgent } from './device'
import { startNewAccount, switchToLinking } from './link'
import { answerOnScreen, askThroughApp, pick, sendPicks } from './questions'
import {
  type Engine,
  INITIAL_CLAUDE,
  INITIAL_LINK,
  INITIAL_LOG,
  NO_QUESTION,
  PANE,
  addLog,
  cleanPrompt,
  errorText,
  note,
  rt,
  setStatus,
  isPersonPrompt,
  short,
} from './state'
import { type Actions, type ViewModel, footerView, panelView, terminalFooterView, terminalView } from './view'

const claude = atom({ plugin: 'codebridge', key: 'claude' } as const, INITIAL_CLAUDE)
const link = atom({ plugin: 'codebridge', key: 'link' } as const, INITIAL_LINK)
const log = atom({ plugin: 'codebridge', key: 'log' } as const, INITIAL_LOG)
const paneShown = atom({ plugin: 'codebridge', key: 'paneShown' } as const, false)
const question = atom({ plugin: 'codebridge', key: 'question' } as const, NO_QUESTION)
const settingsOpen = atom({ plugin: 'codebridge', key: 'settingsOpen' } as const, false)
const settingsShown = atom({ plugin: 'codebridge', key: 'settingsShown' } as const, false)
const tick = atom({ plugin: 'codebridge', key: 'tick' } as const, 0)

async function openPane($: Engine): Promise<void> {
  await $.store.set('paneOpen', true)
  await update($, paneShown, () => true)
  await $.ui.open({ id: PANE, title: 'Claude Bridge' })
}

async function setEnabled($: Engine, on: boolean): Promise<void> {
  await $.store.set('enabled', on)
  await update($, link, s => ({ ...s, enabled: on }))
  if (on) {
    await startConnector($)
    await ensureDeviceAgent($)
  } else {
    await stopConnector($)
    await stopDeviceAgent($)
  }
}

/** A new key (`given`: one copied from another computer, so this one joins the same account). */
async function newKey($: Engine, given?: string): Promise<void> {
  await bridgeKey($, !given, given)
  await stopConnector($)
  for (let i = 0; i < 30 && rt.connector; i++) await $.clock.sleep(100)
  await startConnector($)
}

/**
 * Pauses Claude Bridge for the whole account, or resumes it: the relay then refuses every call
 * from the Claude app, and tells every session at once. Only a session can resume it.
 */
async function togglePause($: Engine): Promise<void> {
  const now = await read($, link)
  if (!now.connected) {
    $.ui.toast('Claude Bridge isn’t connected, so it can’t be paused or resumed from here right now.')
    return
  }
  const r = (await post($, '/pause', { paused: !now.paused }).catch(() => undefined)) as { ok?: boolean } | undefined
  if (!r?.ok) {
    $.ui.toast('Couldn’t reach the relay to change that; try again in a moment.')
    return
  }
  // The relay's answer to every session (this one too) sets the dot; this shows it at once.
  await update($, link, s => ({ ...s, paused: !now.paused }))
  await addLog($, { kind: 'event', text: now.paused ? 'Claude Bridge turned back on' : 'Claude Bridge paused everywhere' })
}

/** This session's choice: run the app's messages, or put them in the prompt box first. */
async function setAskFirst($: Engine, on: boolean): Promise<void> {
  await $.store.set(`askFirst:${await $.session.id()}`, on)
  rt.askFirst = on
  await update($, link, s => ({ ...s, askFirst: on }))
}

/** This computer's choice, shared with the device agent: may the app take screenshots. */
async function setScreen($: Engine, on: boolean): Promise<void> {
  await setComputerSetting($, 'screen', on)
  await update($, link, s => ({ ...s, screen: on }))
}

/** This computer's choice, read by the device agent: where started and resumed sessions open. */
async function setOpenIn($: Engine, where: 'auto' | 'desktop' | 'terminal'): Promise<void> {
  await setComputerSetting($, 'openIn', where === 'auto' ? null : where)
  await update($, link, s => ({ ...s, openIn: where }))
}

/**
 * A side chat runs on the model and effort its original was on when it was forked. The desktop
 * app keeps the model it was forked on but not the effort, so the side chat sets both itself,
 * once, as /model and /effort would; after that, what the person chooses stands.
 */
async function keepForkedSetting($: Engine, forkNote: string): Promise<void> {
  const [, model, effort] = forkNote.match(SAME) ?? []
  if (!model) return
  const key = `forkSetting:${await $.session.id()}`
  if ((await $.store.get(key)) === true) return
  await $.store.set(key, true)
  const current = await $.session.model().catch(() => '')
  if (model && !current.startsWith(model)) {
    await $.command.run({ command: 'model', args: model }).catch(error => note($, `couldn't set the model: ${errorText(error)}`))
  }
  if (effort) {
    await $.command.run({ command: 'effort', args: effort }).catch(error => note($, `couldn't set the effort: ${errorText(error)}`))
    rt.effort = effort
  }
  rt.model = model
  await $.store.set(`setting:${await $.session.id()}`, { model: rt.model, effort: rt.effort })
  await note($, `side chat set to ${model}${effort ? ` at ${effort} effort` : ''}`)
}

/**
 * The Connection switch: own an account (URL and key for the Claude app) or link with a code.
 * Leaving an account this computer owns takes a second press: it then leaves that account.
 */
async function setConnectMode($: Engine, mode: 'own' | 'link'): Promise<void> {
  const now = await read($, link)
  const owns = now.key.startsWith('cbrg_')
  if (mode === 'own') {
    if (!owns) await startNewAccount($)
    return
  }
  if (owns) {
    const at = await $.clock.now()
    if (at - rt.switchAskedAt > 5_000) {
      rt.switchAskedAt = at
      $.ui.toast('Choose Link with a code again within 5 seconds: this computer leaves its own account (its key is kept, and comes back if you switch back).', { timeoutMs: 5_000 })
      return
    }
    rt.switchAskedAt = 0
  }
  await switchToLinking($)
}

/** A new key cuts off the Claude app and every other computer: the first press only warns. */
async function confirmNewKey($: Engine): Promise<void> {
  const now = await $.clock.now()
  if (now - rt.newKeyAskedAt > 5_000) {
    rt.newKeyAskedAt = now
    $.ui.toast('Press again within 5 seconds to make a new key. The Claude app and your other computers then need the new key.', { timeoutMs: 5_000 })
    return
  }
  rt.newKeyAskedAt = 0
  await newKey($)
}

function actionsFor($: Engine): Actions {
  // A press handler's promise has no one waiting on it: note what fails.
  const run = (name: string, work: Promise<unknown>) =>
    void work.catch(error => note($, `${name} failed: ${errorText(error)}`))
  return {
    setWatched: on => run('watch', setWatched($, on)),
    togglePause: () => run('pause', togglePause($)),
    toggleSetup: () => run('setup', update($, settingsOpen, open => !open)),
    toggleSettings: () => run('settings', update($, settingsShown, open => !open)),
    setEnabled: on => run('connection', setEnabled($, on)),
    setAskFirst: on => run('ask first', setAskFirst($, on)),
    setScreen: on => run('screenshots', setScreen($, on)),
    setOpenIn: where => run('open in', setOpenIn($, where)),
    newKey: () => run('new key', confirmNewKey($)),
    copy: (text, surface) => run('copy', $.ui.copy({ text, surface })),
    clear: () => run('clear', update($, log, () => [])),
    pick: (index, label) => run('answer', pick($, index, label)),
    sendPicks: () => run('answer', sendPicks($)),
    answerOnScreen: () => run('answer', answerOnScreen($)),
    openPane: () => run('open', openPane($)),
    startNewAccount: () => run('new account', startNewAccount($)),
    setConnectMode: mode => run('connection', setConnectMode($, mode)),
  }
}

async function viewModel($: Engine, rows: number): Promise<ViewModel> {
  const activity = await read($, claude)
  return {
    link: await read($, link),
    claude: activity,
    log: await read($, log),
    question: await read($, question),
    setupOpen: await read($, settingsOpen),
    settingsShown: await read($, settingsShown),
    // The tick only matters while a timer shows: Claude Code working.
    tick: activity.isWorking ? await read($, tick) : 0,
    now: await $.clock.now(),
    rows,
  }
}

/** What marks news as the app's own: the ids of its messages the running turn carries. */
function appTurn(): { messages?: string[]; forApp?: true } {
  return rt.turnEntries.length ? { messages: [...rt.turnEntries], forApp: true } : {}
}

/** The latest turn's shared pictures for its finished event, within what one message can carry. */
function picturesOf(shared: readonly Picture[]): { pictures?: EventPicture[] } {
  const out: EventPicture[] = []
  let room = 900_000
  for (const p of shared) {
    if (p.data.length > room) continue
    room -= p.data.length
    out.push({ data: p.data, mimeType: p.mimeType, ...(p.caption ? { caption: p.caption } : {}) })
  }
  return out.length ? { pictures: out } : {}
}

/** The note the desktop app opens a side chat's first prompt with; quoted elsewhere, it doesn't count. */
const FORK_NOTE = /^\s*#*\s*(The user forked this session|Side chat\b)/
/** A side chat the Claude app forked names the session it came from. */
const PARENT = /original session \(([0-9a-f-]{36})\)/
/** …and the model and effort it was forked on: the original's, then. */
const SAME = /It runs on ([A-Za-z0-9._\-[\]]+)(?: at (low|medium|high|xhigh|max) effort)?, as the original does/

export const register: Register = (on, config) => {
  rt.options = (config ?? {}) as typeof rt.options

  on('session.start', async ($, e, next) => {
    // The device agent's own short run that starts a new session (device.swift): no bridge in it.
    if (await $.env.get('CLAUDE_BRIDGE_BOOTSTRAP').catch(() => undefined)) return next(e)
    rt.traceFile = `/tmp/claude-bridge-${(await $.session.id()).slice(0, 8)}.log`
    // Where this session runs, so a side chat forked from it opens in the same place.
    const kept = (await $.store.get(`setting:${await $.session.id()}`)) as { model?: string; effort?: string } | undefined
    rt.model = kept?.model ?? ''
    rt.effort = kept?.effort ?? ''
    rt.runsIn = (await $.env.get('CLAUDE_CODE_ENTRYPOINT').catch(() => undefined)) === 'claude-desktop' ? 'desktop' : 'terminal'
    const terminal = await $.env.get('TERM_PROGRAM').catch(() => undefined)
    rt.terminalApp = terminal === 'iTerm.app' ? 'iTerm' : terminal === 'Apple_Terminal' ? 'Terminal' : ''
    await note($, 'loaded')
    rt.connector = undefined
    // A desktop side chat is a copy of another session; the app marks the point it was forked at.
    const history = await $.session.messages().catch(() => [])
    const forkNote = history.find(m => m.role === 'user' && FORK_NOTE.test(m.text))
    rt.isSide = !!forkNote
    rt.parent = forkNote?.text.match(PARENT)?.[1] ?? ''
    if (forkNote) void keepForkedSetting($, forkNote.text)
    await update($, question, () => null)
      await $.command
      .register({ name: 'bridge', description: 'Claude Bridge: let the Claude app reach this session', argumentHint: '[on|off|key <key from another computer>]' })
      .catch(error => note($, `couldn't register /bridge: ${errorText(error)}`))
    // The desktop app runs sessions headless and attaches later; an open waits for a surface.
    await $.tool
      .register({
        name: 'share_image',
        description:
          "Shows an image to the person in the Claude app, where they may be talking to you from their phone through Claude Bridge. Use it when they asked to see something, or when a picture says more than words: after changing a UI, take a screenshot (of a browser preview, a simulator, or the screen) and share it. The image goes with your reply.",
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path of the image file: PNG, JPEG, GIF, HEIC, WebP, TIFF or BMP.' },
            caption: { type: 'string', description: 'A few words on what it shows.' },
          },
          required: ['path'],
        },
        isDeferred: false,
      })
      .catch(error => note($, `couldn't register share_image: ${errorText(error)}`))
    const paneOpen = (await $.store.get('paneOpen')) !== false
    await update($, paneShown, () => paneOpen)
    if (paneOpen) void $.ui.open({ id: PANE, title: 'Claude Bridge' })
    const enabled = (await $.store.get('enabled')) !== false
    rt.askFirst = (await $.store.get(`askFirst:${await $.session.id()}`)) === true
    const screen = (await computerSetting($, 'screen')) !== false
    const savedOpenIn = await computerSetting($, 'openIn')
    const openIn: 'auto' | 'desktop' | 'terminal' = savedOpenIn === 'desktop' || savedOpenIn === 'terminal' ? savedOpenIn : 'auto'
    await update($, link, s => ({ ...s, enabled, connected: false, watched: false, askFirst: rt.askFirst, screen, openIn }))
    if (enabled) {
      void startConnector($)
      void ensureDeviceAgent($)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    rt.linking = false
    await stopConnector($)
    return next(e)
  })

  // The model and effort the session is on right now, as its requests go out: side chats forked
  // from it use the same.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const effort = e.effort !== undefined ? String(e.effort) : rt.effort
      if (e.model !== rt.model || effort !== rt.effort) {
        rt.model = e.model
        rt.effort = effort
        // Kept across reloads of the plugin, so the session's setting is known before its next request.
        await $.store.set(`setting:${await $.session.id()}`, { model: rt.model, effort: rt.effort })
      }
    }
    return yield* next(e)
  })

  // /model and /effort change the setting before any request shows it.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    const level = (e.args ?? '').trim().toLowerCase()
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(level)) {
      rt.effort = level
      await $.store.set(`setting:${await $.session.id()}`, { model: rt.model, effort: rt.effort })
    }
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'model' }, async ($, e, next) => {
    const result = await next(e)
    // The new model is read from the session itself until its next request names it.
    rt.model = ''
    await $.store.set(`setting:${await $.session.id()}`, { model: '', effort: rt.effort })
    return result
  }).catch(($, e, next) => next(e))

  // Claude Code's own tool: queue a picture for the Claude app.
  on('tool.call', { tool: 'mcp__codebridge__share_image' }, async ($, e) => {
    const args = e as unknown as { path?: unknown; caption?: unknown }
    try {
      const picture = await prepareImage($, String(args.path ?? ''), typeof args.caption === 'string' ? args.caption : undefined)
      rt.shared = [...rt.shared, picture].slice(-4)
      await addLog($, { kind: 'event', text: `Shared a picture: ${picture.caption ?? 'image'}` })
      return { result: 'Shared: the person sees it in the Claude app with your reply.' }
    } catch (error) {
      return { result: `Not shared: ${errorText(error)}` }
    }
  })

  on('command.run', { command: 'bridge' }, async ($, e) => {
    const [first = '', ...rest] = (e.args ?? '').trim().split(/\s+/)
    const word = first.toLowerCase()
    if (word === 'key') {
      const key = rest.join('').trim()
      if (!KEY_PATTERN.test(key)) return { text: 'Paste the key from Copy key in Claude Bridge on your other computer: /bridge key cbrg_…' }
      await newKey($, key)
      await openPane($)
      return { text: 'This computer now uses that key: it joins the same Claude Bridge account, and the Claude app reaches its sessions too.' }
    }
    if (word === 'off') {
      await setEnabled($, false)
      return { text: 'Claude Bridge is off for every session until you turn it on.' }
    }
    if (word === 'on') await setEnabled($, true)
    await openPane($)
    return { text: 'Claude Bridge panel is open. The Claude app reaches this session by its name or its project’s name.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await $.store.set('paneOpen', false)
      await update($, paneShown, () => false)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      // A desktop side chat is a fork of another session; the app wraps its first prompt saying so.
      if (FORK_NOTE.test(e.text)) {
        rt.isSide = true
        rt.parent = e.text.match(PARENT)?.[1] ?? rt.parent
      }
      // A notice (a subagent's hand-back, the fork note) isn't what the session was asked.
      const text = isPersonPrompt(e.text) ? cleanPrompt(e.text) : ''
      const now = await $.clock.now()
      rt.stopStands = false
      rt.turn = { id: e.turnId, startedAt: now }
      // Messages whose submit resolved before this ran belong to this turn; the rest join it as
      // their submit resolves (joinTurn in claude.ts).
      rt.turnEntries = rt.entering
      rt.entering = []
      rt.shared = []
      for (const id of rt.turnEntries) await setStatus($, id, 'working')
      await update($, claude, current => ({
        ...current,
        isWorking: true,
        turnId: e.turnId,
        startedAt: now,
        task: text ? short(text, 160) : current.task,
        tools: [],
      }))
      rt.ticker?.cancel()
      rt.ticker = $.clock.every(1000, () => void update($, tick, n => n + 1))
      const task = text ? short(text, 160) : undefined
      void reportState($)
      void sendEvent($, { kind: 'started', ...(task ? { text: task } : {}), ...appTurn() })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A side question's answer goes to the Claude app as news.
    if (e.agentId !== undefined) await sideFinished($, e.agentId, e.answer.trim(), e.reason)
    if (e.agentId === undefined) {
      rt.turn = undefined
      rt.ticker?.cancel()
      rt.ticker = undefined
      const answer = e.answer.trim()
      const now = await $.clock.now()
      const watched = (await read($, link)).watched
      const forApp = rt.turnEntries.length > 0
      const task = (await read($, claude)).task
      const changes = forApp || watched ? await changesOfLastTurn($).catch(() => []) : []
      await update($, claude, current => ({
        ...current,
        isWorking: false,
        turnId: undefined,
        startedAt: undefined,
        tools: [],
        replies: answer ? [...current.replies, { text: answer, at: now, changes }].slice(-3) : current.replies,
      }))
      const status = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
      for (const id of rt.turnEntries) await setStatus($, id, status)
      if (e.reason === 'aborted') rt.stopStands = true
      if (forApp) {
        if (e.reason === 'answer') await addLog($, { kind: 'reply', text: answer })
        else await addLog($, { kind: 'event', text: e.reason === 'aborted' ? 'Claude Code was stopped' : 'Claude Code hit a problem' })
      }
      // The Claude app's feed: the reply, what changed and any pictures, or that it didn't finish.
      const about = { ...appTurn(), ...(task ? { task } : {}) }
      rt.turnEntries = []
      void reportState($)
      void sendEvent(
        $,
        e.reason === 'answer'
          ? { kind: 'finished', text: answer, changes, ...about, ...picturesOf(rt.shared) }
          : { kind: e.reason === 'aborted' ? 'stopped' : 'failed', ...about },
      )
      // Keep the Claude app's briefing current while it watches this session.
      if (watched || forApp) void refreshBrief($)
    }
    return next(e)
  })

  // Claude Code's questions go to the Claude app in a turn it asked for, or while it watches.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.tool !== 'AskUserQuestion' || e.agentId !== undefined || !rt.connector) return next(e)
    const linked = await read($, link)
    if (linked.paused || (rt.turnEntries.length === 0 && !linked.watched)) return next(e)
    const answers = await askThroughApp($, e, questions => void sendEvent($, { kind: 'question', questions, ...appTurn() }))
    if (!answers) return next(e)
    return { result: { questions: e.questions, answers } }
  }).catch(($, e, next) => next(e))

  // What Claude Code is doing, for status.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || !(await read($, claude)).isWorking) return next(e)
    const label = describeTool(String(e.tool), e)
    await update($, claude, current => ({ ...current, tools: [...current.tools, label].slice(-6) }))
    try {
      return await next(e)
    } finally {
      await update($, claude, current => {
        const at = current.tools.lastIndexOf(label)
        return at < 0 ? current : { ...current, tools: current.tools.filter((_, i) => i !== at) }
      })
    }
  }).catch(($, e, next) => next(e))


  // The small Bridge button in the prompt's footer, beside the mode labels: it opens the panel.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (!(await read($, link)).enabled) return next(e)
    const model = await viewModel($, 1)
    if (e.surface === 'terminal') return terminalFooterView($.ui.resolve(e), model, e.props.modes)
    return footerView($.ui.resolve(e), model, actionsFor($), e.props.modes)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const model = await viewModel($, e.viewport?.rows ?? 24)
    if (e.surface === 'terminal') return terminalView($.ui.resolve(e), model, actionsFor($))
    return panelView($.ui.resolve(e), model, actionsFor($), e.surface)
  })
}
