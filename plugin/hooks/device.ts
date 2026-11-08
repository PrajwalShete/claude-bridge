// This computer in Claude Bridge: its id (~/.config/claude-bridge/device.json, shared with the
// device agent), and the device agent itself (connector/device.swift): started from inside
// Claude, it answers for the computer (its projects, its sessions' history, starting, resuming,
// renaming and forking sessions) for as long as Claude runs.

import { chatBase, ensureBinary, helpersBlocked, usesHelpers } from './connector'
import { type Engine, errorText, note, rt } from './state'

const LABEL = 'com.claudebridge.device'

async function home($: Engine): Promise<string> {
  return (await $.env.get('HOME')) ?? '/tmp'
}

/** This computer's id: made once, by whichever of the plugin and the device agent comes first. */
export async function deviceId($: Engine): Promise<string> {
  if (rt.deviceId) return rt.deviceId
  const path = `${await home($)}/.config/claude-bridge/device.json`
  try {
    const saved = JSON.parse(String(await $.fs.read(path))) as { id?: unknown }
    if (typeof saved.id === 'string' && saved.id) return (rt.deviceId = saved.id)
  } catch {
    // not made yet
  }
  const id = crypto.randomUUID()
  await $.fs.write(path, JSON.stringify({ id }))
  await $.process.run(['chmod', '600', path]).catch(() => undefined)
  return (rt.deviceId = id)
}

/** The old way, a launchd agent (before 1.2.0): macOS may restrict it as a separate background item. */
const OLD_LABEL = 'com.claudebridge.device'

/** The running agent's process id, from its lock file, or 0 where none runs. */
async function runningAgent($: Engine, h: string): Promise<number> {
  const pid = Number(String(await $.fs.read(`${h}/.config/claude-bridge/device.lock`).catch(() => '')).trim())
  if (!pid) return 0
  const alive = await $.process.run(['/bin/ps', '-o', 'comm=', '-p', String(pid)]).catch(() => undefined)
  return alive?.exitCode === 0 && alive.stdout.includes('claude-bridge-device') ? pid : 0
}

/**
 * Keeps the device agent running, started from inside Claude (so macOS counts it as Claude's,
 * with Claude's permissions) rather than by launchd. Each session checks now and every 30 s: the
 * agent lives on after the session that started it, until Claude itself quits (device.swift),
 * and only one runs per computer.
 */
export async function ensureDeviceAgent($: Engine): Promise<void> {
  if (rt.deviceAgentChecked) return
  rt.deviceAgentChecked = true
  await keepAgentRunning($)
  rt.agentTimer?.cancel()
  rt.agentTimer = $.clock.every(30_000, () => void keepAgentRunning($))
}

async function keepAgentRunning($: Engine): Promise<void> {
  try {
    // Not where helper programs don't run: the sessions answer for the computer (inside.ts).
    if (!(await usesHelpers($))) {
      rt.agentTimer?.cancel()
      rt.agentTimer = undefined
      return
    }
    const h = await home($)
    await deviceId($)
    if ((await computerSetting($, 'chatUrl')) !== chatBase()) await setComputerSetting($, 'chatUrl', chatBase())
    await retireLaunchAgent($, h)

    const { path: binary, rebuilt } = await ensureBinary($, 'device')
    const running = await runningAgent($, h)
    if (running && !rebuilt) return
    if (running) {
      // A new build: the old agent makes way for it.
      await $.process.run(['kill', String(running)]).catch(() => undefined)
      await $.clock.sleep(500)
    }
    // Started from this session's shell, so it is Claude's; it detaches itself (setsid) and
    // watches the Claude app (or this session) to end with it.
    const log = `${h}/Library/Logs/claude-bridge-device.log`
    const started = await $.process.run([
      '/bin/sh',
      '-c',
      'session=$PPID; nohup "$0" --watch-pid "$session" >> "$1" 2>&1 < /dev/null &',
      binary,
      log,
    ])
    await note($, started.exitCode === 0 ? `device agent started${rebuilt ? ' (new build)' : ''}` : `device agent didn’t start: ${started.stderr.slice(0, 200)}`)
    // One macOS refuses to run is gone at once; twice in a row, and this computer stops trying.
    $.clock.after(3000, async () => {
      if (await runningAgent($, h)) {
        rt.agentRefused = 0
        return
      }
      rt.agentRefused++
      if (rt.agentRefused >= 2) await helpersBlocked($, 'the device agent didn’t stay running')
    })
  } catch (error) {
    await note($, `device agent: ${errorText(error)}`)
  }
}

/** Removes the launchd agent earlier versions installed, once, so no separate background item stays. */
async function retireLaunchAgent($: Engine, h: string): Promise<void> {
  const plist = `${h}/Library/LaunchAgents/${OLD_LABEL}.plist`
  if (!(await $.fs.stat(plist).catch(() => undefined))) return
  const uid = (await $.process.run(['id', '-u'])).stdout.trim()
  await $.process.run(['launchctl', 'bootout', `gui/${uid}/${OLD_LABEL}`]).catch(() => undefined)
  await $.process.run(['rm', '-f', plist]).catch(() => undefined)
  await note($, 'removed the old launchd agent')
}

/** A setting for this whole computer, kept in config.json where the device agent reads it too. */
export async function computerSetting($: Engine, name: string): Promise<unknown> {
  try {
    return (JSON.parse(String(await $.fs.read(`${await home($)}/.config/claude-bridge/config.json`))) as Record<string, unknown>)[name]
  } catch {
    return undefined
  }
}

export async function setComputerSetting($: Engine, name: string, value: unknown): Promise<void> {
  const path = `${await home($)}/.config/claude-bridge/config.json`
  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(String(await $.fs.read(path))) as Record<string, unknown>
  } catch {
    // not written yet
  }
  await $.fs.write(path, JSON.stringify({ ...config, [name]: value }))
}

/** Stops the device agent (Claude Bridge turned off); the next ensureDeviceAgent starts it again. */
export async function stopDeviceAgent($: Engine): Promise<void> {
  rt.deviceAgentChecked = false
  rt.agentTimer?.cancel()
  rt.agentTimer = undefined
  const running = await runningAgent($, await home($))
  if (running) await $.process.run(['kill', String(running)]).catch(() => undefined)
}
