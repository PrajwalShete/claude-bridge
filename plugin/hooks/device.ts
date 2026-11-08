// This computer in Claude Bridge: its id (~/.config/claude-bridge/device.json, shared with the
// device agent), and the device agent itself (connector/device.swift), which launchd keeps
// running so the Claude app can reach the computer with no session open: its projects, its
// sessions' history, starting, resuming and renaming sessions.

import { chatBase, ensureBinary } from './connector'
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

function plist(binary: string, log: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(binary)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`
}

/**
 * Installs the device agent as a launchd agent, or updates it. Once per load of the plugin:
 * writes where to connect, builds the program if its source changed, and (re)starts it.
 */
export async function ensureDeviceAgent($: Engine): Promise<void> {
  if (rt.deviceAgentChecked) return
  rt.deviceAgentChecked = true
  try {
    const h = await home($)
    await deviceId($)
    if ((await computerSetting($, 'chatUrl')) !== chatBase()) await setComputerSetting($, 'chatUrl', chatBase())

    const { path: binary, rebuilt } = await ensureBinary($, 'device')
    const plistPath = `${h}/Library/LaunchAgents/${LABEL}.plist`
    const wanted = plist(binary, `${h}/Library/Logs/claude-bridge-device.log`)
    const uid = (await $.process.run(['id', '-u'])).stdout.trim()
    const target = `gui/${uid}/${LABEL}`
    const loaded = (await $.process.run(['launchctl', 'print', target]).catch(() => ({ exitCode: 1 }))).exitCode === 0
    if (String(await $.fs.read(plistPath).catch(() => '')) !== wanted) {
      await $.process.run(['mkdir', '-p', `${h}/Library/LaunchAgents`])
      await $.fs.write(plistPath, wanted)
      if (loaded) await $.process.run(['launchctl', 'bootout', target]).catch(() => undefined)
      await $.process.run(['launchctl', 'bootstrap', `gui/${uid}`, plistPath])
      await note($, 'device agent installed')
    } else if (!loaded) {
      await $.process.run(['launchctl', 'bootstrap', `gui/${uid}`, plistPath])
      await note($, 'device agent started')
    } else if (rebuilt) {
      await $.process.run(['launchctl', 'kickstart', '-k', target])
      await note($, 'device agent restarted on its new build')
    }
  } catch (error) {
    rt.deviceAgentChecked = false
    await note($, `device agent: ${errorText(error)}`)
  }
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
  const uid = (await $.process.run(['id', '-u'])).stdout.trim()
  await $.process.run(['launchctl', 'bootout', `gui/${uid}/${LABEL}`]).catch(() => undefined)
}
