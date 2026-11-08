// This computer in Claude Bridge: its id (~/.config/claude-bridge/device.json, shared with the
// device agent), and the device agent itself (connector/device.swift), which answers for the
// computer (its projects, its sessions' history, starting, resuming, renaming and forking
// sessions).
//
// The device agent runs as a background service: a launchd agent, started by macOS at login and
// kept running, so the computer stays reachable with Claude closed. Where macOS won't run it (a
// managed Mac's "access denied"), Auto removes it at once and the sessions answer for the
// computer instead, from inside Claude (inside.ts).

import { chatBase, ensureBinary, helperSetting } from './connector'
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

/** A wait that is a `$` call, so it costs a hook none of its time budget (a `$.clock` sleep would). */
async function pause($: Engine, seconds: number): Promise<void> {
  await $.process.run(['/bin/sleep', String(seconds)]).catch(() => undefined)
}

function plist(binary: string, log: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(binary)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`
}

type Service = { uid: string; target: string; plistPath: string }

async function service($: Engine, h: string): Promise<Service> {
  const uid = (await $.process.run(['id', '-u'])).stdout.trim()
  return { uid, target: `gui/${uid}/${LABEL}`, plistPath: `${h}/Library/LaunchAgents/${LABEL}.plist` }
}

/** The service's process id while launchd has it running, else 0. */
async function servicePid($: Engine, s: Service): Promise<number> {
  const r = await $.process.run(['launchctl', 'print', s.target]).catch(() => undefined)
  if (!r || r.exitCode !== 0 || !/\bstate = running\b/.test(r.stdout)) return 0
  return Number(r.stdout.match(/\bpid = (\d+)/)?.[1] ?? 0)
}

/** The process holding the device agent's lock (any copy, launchd's or not), or 0. */
async function lockHolder($: Engine, h: string): Promise<number> {
  const pid = Number(String(await $.fs.read(`${h}/.config/claude-bridge/device.lock`).catch(() => '')).trim())
  if (!pid) return 0
  const alive = await $.process.run(['/bin/ps', '-o', 'comm=', '-p', String(pid)]).catch(() => undefined)
  return alive?.exitCode === 0 && alive.stdout.includes('claude-bridge-device') ? pid : 0
}

/**
 * Sessions starting together take turns installing the service (a lock folder), so none of them
 * mistakes another's restart for macOS refusing it. A lock over a minute old was left behind.
 */
async function withServiceLock<T>($: Engine, h: string, work: () => Promise<T>): Promise<T | undefined> {
  const lock = `${h}/.config/claude-bridge/service.lock`
  for (let i = 0; i < 20; i++) {
    const took = await $.process.run(['mkdir', lock]).catch(() => undefined)
    if (took?.exitCode === 0) {
      try {
        return await work()
      } finally {
        await $.process.run(['rm', '-rf', lock]).catch(() => undefined)
      }
    }
    const stat = await $.fs.stat(lock).catch(() => undefined)
    if (stat && (await $.clock.now()) - stat.mtimeMs > 60_000) await $.process.run(['rm', '-rf', lock]).catch(() => undefined)
    else await pause($, 1)
  }
  return undefined
}

/**
 * Makes sure the background service runs, installing or updating it where needed:
 * - `running`: it runs (as installed now, or already);
 * - `blocked`: macOS wouldn't run it (refused, or ended at once);
 * - `unavailable`: there is no program to run (no prebuilt one for this copy, and no Xcode).
 */
export async function ensureBackgroundService($: Engine): Promise<'running' | 'blocked' | 'unavailable'> {
  const h = await home($)
  await deviceId($)
  if ((await computerSetting($, 'chatUrl')) !== chatBase()) await setComputerSetting($, 'chatUrl', chatBase())
  let binary: { path: string; rebuilt: boolean }
  try {
    binary = await ensureBinary($, 'device')
  } catch (error) {
    await note($, `no device agent program: ${errorText(error)}`)
    return 'unavailable'
  }
  const s = await service($, h)
  const wanted = plist(binary.path, `${h}/Library/Logs/claude-bridge-device.log`)
  const current = String(await $.fs.read(s.plistPath).catch(() => ''))
  // The usual case, every session after the first: nothing to do.
  if (current === wanted && !binary.rebuilt && (await servicePid($, s))) return 'running'

  const outcome = await withServiceLock($, h, async () => {
    // Another session may have finished it while this one waited.
    if ((await computerSetting($, 'helpersBlocked')) === true && (await helperSetting($)) === 'auto') return 'blocked' as const
    const fresh = String(await $.fs.read(s.plistPath).catch(() => ''))
    if (fresh === wanted && !binary.rebuilt && (await servicePid($, s))) return 'running' as const

    // A copy started from inside Claude (1.2.0 and 1.3.0) holds the lock launchd's copy needs.
    const stray = await lockHolder($, h)
    if (stray && stray !== (await servicePid($, s))) {
      await $.process.run(['kill', String(stray)]).catch(() => undefined)
      for (let i = 0; i < 5 && (await lockHolder($, h)); i++) await pause($, 1)
    }
    await $.process.run(['launchctl', 'bootout', s.target]).catch(() => undefined)
    await $.process.run(['mkdir', '-p', `${h}/Library/LaunchAgents`])
    await $.fs.write(s.plistPath, wanted)
    const boot = await $.process.run(['launchctl', 'bootstrap', `gui/${s.uid}`, s.plistPath]).catch(error => ({ exitCode: 1, stdout: '', stderr: errorText(error) }))
    if (boot.exitCode !== 0) await note($, `launchctl bootstrap: ${boot.stderr.trim().slice(0, 200)}`)

    // Running now, and still the same process a moment later: macOS let it run.
    await pause($, 2)
    const first = await servicePid($, s)
    await pause($, 2)
    const second = await servicePid($, s)
    if (first && first === second) {
      await note($, current ? 'background service updated' : 'background service installed')
      return 'running' as const
    }
    // Only a refusal counts as blocked: a copy of the agent running at all (one an older version
    // of the plugin started, which also removes the service) means helper programs run here.
    if (await lockHolder($, h)) {
      await note($, 'another copy of the device agent runs (started by an older version); the service waits for it')
      return 'running' as const
    }
    if (!(await $.fs.exists(s.plistPath).catch(() => false))) return 'running' as const
    return 'blocked' as const
  })
  if (outcome) return outcome
  // The lock stayed taken: judge by what runs, never "blocked" on a guess.
  return (await servicePid($, s)) || (await lockHolder($, h)) ? 'running' : 'unavailable'
}

/** Removes the background service: stopped, and gone from login. Any copy started otherwise stops too. */
export async function removeBackgroundService($: Engine): Promise<void> {
  const h = await home($)
  const s = await service($, h)
  const installed = await $.fs.exists(s.plistPath).catch(() => false)
  const loaded = (await $.process.run(['launchctl', 'print', s.target]).catch(() => undefined))?.exitCode === 0
  if (loaded) await $.process.run(['launchctl', 'bootout', s.target]).catch(() => undefined)
  if (installed) await $.process.run(['rm', '-f', s.plistPath]).catch(() => undefined)
  const stray = await lockHolder($, h)
  if (stray) await $.process.run(['kill', String(stray)]).catch(() => undefined)
  if (installed || loaded || stray) await note($, 'background service removed')
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
