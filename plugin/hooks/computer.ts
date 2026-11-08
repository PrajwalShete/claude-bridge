// The computer's own jobs, done inside Claude Code (the no-helper mode): what the device agent
// (connector/device.swift) answers where it can run, ported here for computers that block it.
// Only Apple's own tools (ps, head, grep, open, screencapture) and Claude Code itself are run.
//   projects        the folders Claude Code has worked in, most recent first
//   sessions        a project's recent sessions, from its transcripts
//   names           what live sessions are called
//   rename_session  appends a `custom-title` row to the transcript
//   open_session    opens a session in the desktop app or a terminal
//   start_session   starts a new session in a project
//   fork_session    a side chat: a new session with a copy of another's whole conversation
//   screenshot      the screen

import { captureScreen } from './images'
import { type Engine, errorText, rt } from './state'

type Result = Record<string, unknown>

export const COMPUTER_TOOLS = new Set(['projects', 'sessions', 'names', 'rename_session', 'open_session', 'start_session', 'fork_session', 'screenshot'])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function home($: Engine): Promise<string> {
  return (await $.env.get('HOME').catch(() => undefined)) ?? '/tmp'
}

function transcriptsDir(h: string, folder: string): string {
  return `${h}/.claude/projects/${folder.replace(/[^A-Za-z0-9]/g, '-')}`
}

async function readJson($: Engine, path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(String(await $.fs.read(path))) as Record<string, unknown>
  } catch {
    return undefined
  }
}

async function sh($: Engine, script: string, ...args: string[]): Promise<string> {
  const r = await $.process.run(['/bin/sh', '-c', script, ...args], { timeoutMs: 20_000 }).catch(() => undefined)
  return r?.stdout ?? ''
}

// MARK: The desktop app's own records

type DesktopSession = { localId: string; current?: string; cliIds: string[]; cwd: string; title?: string; lastActivity: number; archived: boolean }

async function desktopSessions($: Engine): Promise<DesktopSession[]> {
  const now = await $.clock.now()
  if (rt.desktopCache && now - rt.desktopCache.at < 10_000) return rt.desktopCache.rows as DesktopSession[]
  const root = `${await home($)}/Library/Application Support/Claude/claude-code-sessions`
  const rows: DesktopSession[] = []
  for (const a of await $.fs.list(root).catch(() => [])) {
    if (a.kind !== 'dir') continue
    for (const b of await $.fs.list(`${root}/${a.name}`).catch(() => [])) {
      if (b.kind !== 'dir') continue
      const dir = `${root}/${a.name}/${b.name}`
      for (const f of await $.fs.list(dir).catch(() => [])) {
        if (!f.name.startsWith('local_') || !f.name.endsWith('.json')) continue
        const d = await readJson($, `${dir}/${f.name}`)
        if (!d || typeof d.sessionId !== 'string') continue
        const current = typeof d.cliSessionId === 'string' ? d.cliSessionId : undefined
        rows.push({
          localId: d.sessionId,
          current,
          cliIds: [...(current ? [current] : []), ...((d.priorCliSessionIds as string[] | undefined) ?? [])],
          cwd: typeof d.cwd === 'string' ? d.cwd : '',
          title: typeof d.title === 'string' ? d.title : undefined,
          lastActivity: typeof d.lastActivityAt === 'number' ? d.lastActivityAt : 0,
          archived: d.isArchived === true,
        })
      }
    }
  }
  rt.desktopCache = { at: now, rows }
  return rows
}

async function desktopRecord($: Engine, id: string): Promise<DesktopSession | undefined> {
  return (await desktopSessions($)).find(r => r.cliIds.includes(id) || r.localId === `local_${id}`)
}

// MARK: Names

function meaningful(s: unknown): string | undefined {
  const t = typeof s === 'string' ? s.trim() : ''
  return t && t !== 'New session' && t !== 'Untitled' ? t : undefined
}

async function latestTitle($: Engine, file: string, kind: string, field: string): Promise<string | undefined> {
  const line = (await sh($, 'grep -h -F "\\"type\\":\\"$1\\"" "$0" | tail -n 1', file, kind)).trim()
  if (!line) return undefined
  try {
    return meaningful((JSON.parse(line) as Record<string, unknown>)[field])
  } catch {
    return undefined
  }
}

async function firstPrompt($: Engine, file: string): Promise<string | undefined> {
  const head = await sh($, 'head -c 400000 "$0"', file)
  for (const line of head.split('\n').slice(0, 400)) {
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (row.type !== 'user' || row.isMeta === true) continue
    const message = row.message as { content?: unknown } | undefined
    let text = ''
    if (typeof message?.content === 'string') text = message.content
    else if (Array.isArray(message?.content)) {
      const blocks = message.content as Array<Record<string, unknown>>
      if (blocks.some(b => b.type === 'tool_result')) continue
      text = blocks.filter(b => b.type === 'text').map(b => String(b.text ?? '')).join(' ')
    }
    text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').replace(/\s+/g, ' ').trim()
    if (!text || text.startsWith('<') || text.startsWith('[Subagent') || text.startsWith('Caveat:')) continue
    if (text.includes('started from the Claude app through Claude Bridge') || text.startsWith('## Side chat')) continue
    return text.length > 70 ? `${text.slice(0, 69)}…` : text
  }
  return undefined
}

type Info = { id: string; name: string; lastActive: number; archived: boolean; side: boolean }

async function sessionInfo($: Engine, h: string, id: string, folder: string): Promise<Info | undefined> {
  const file = `${transcriptsDir(h, folder)}/${id}.jsonl`
  const stat = await $.fs.stat(file).catch(() => undefined)
  if (!stat) return undefined
  const record = await desktopRecord($, id)
  const custom = await latestTitle($, file, 'custom-title', 'customTitle')
  const desktopTitle = meaningful(record?.title)
  const first = await firstPrompt($, file)
  if (!custom && !desktopTitle && !first) return undefined
  const name = custom ?? desktopTitle ?? (await latestTitle($, file, 'ai-title', 'aiTitle')) ?? first ?? 'Untitled'
  return {
    id,
    name,
    lastActive: Math.max(stat.mtimeMs, record?.lastActivity ?? 0),
    archived: record?.archived ?? false,
    side: (record?.title ?? '').startsWith('btw:'),
  }
}

// MARK: The jobs

async function projects($: Engine, limit: number): Promise<Result> {
  const h = await home($)
  const root = `${h}/.claude/projects`
  const last = new Map<string, number>()
  const counts = new Map<string, number>()
  for (const dir of await $.fs.list(root).catch(() => [])) {
    if (dir.kind !== 'dir') continue
    const full = `${root}/${dir.name}`
    const files = (await $.fs.list(full).catch(() => [])).filter(f => f.kind === 'file' && f.name.endsWith('.jsonl'))
    if (files.length === 0) continue
    const newest = files.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a))
    // The folder's name is lossy; the transcript says the real path.
    const head = await sh($, 'head -c 200000 "$0"', `${full}/${newest.name}`)
    const cwd = head.match(/"cwd":"([^"]+)"/)?.[1]
    if (!cwd || transcriptsDir(h, cwd) !== full) continue
    last.set(cwd, Math.max(last.get(cwd) ?? 0, newest.mtimeMs))
    counts.set(cwd, files.length)
  }
  for (const d of await desktopSessions($)) if (d.cwd) last.set(d.cwd, Math.max(last.get(d.cwd) ?? 0, d.lastActivity))
  const out: Result[] = []
  for (const [folder, at] of [...last].sort((a, b) => b[1] - a[1])) {
    if (out.length >= limit) break
    if (folder === h || folder.startsWith(`${h}/Library/Application Support/Claude/`)) continue
    const stat = await $.fs.stat(folder).catch(() => undefined)
    if (stat?.kind !== 'dir') continue
    out.push({ folder, name: folder.split('/').filter(Boolean).pop() ?? folder, lastActive: at, sessions: counts.get(folder) ?? 0 })
  }
  return { projects: out }
}

async function sessions($: Engine, folder: string, limit: number): Promise<Result> {
  const h = await home($)
  const files = (await $.fs.list(transcriptsDir(h, folder)).catch(() => []))
    .filter(f => f.kind === 'file' && f.name.endsWith('.jsonl') && UUID.test(f.name.slice(0, -6)))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const out: Result[] = []
  for (const f of files) {
    if (out.length >= limit) break
    const id = f.name.slice(0, -6)
    // A transcript a desktop session has moved on from is that session's past, not a session.
    const record = await desktopRecord($, id)
    if (record && record.current !== id && record.localId !== `local_${id}`) continue
    const info = await sessionInfo($, h, id, folder)
    if (!info) continue
    out.push({ id: info.id, name: info.name, lastActive: info.lastActive, ...(info.archived ? { archived: true } : {}), ...(info.side ? { side: true } : {}) })
  }
  return { sessions: out }
}

async function renameSession($: Engine, id: string, folder: string, name: string): Promise<Result> {
  const clean = name.replace(/\s+/g, ' ').trim()
  if (!UUID.test(id) || !clean || clean.length > 120) return { error: 'Give a name of 1 to 120 characters.' }
  const file = `${transcriptsDir(await home($), folder)}/${id}.jsonl`
  if (!(await $.fs.stat(file).catch(() => undefined))) return { error: 'That session’s transcript isn’t on this computer.' }
  const row = JSON.stringify({ type: 'custom-title', customTitle: clean, sessionId: id, uuid: crypto.randomUUID(), timestamp: new Date(await $.clock.now()).toISOString() })
  // Appended as its own line, after a newline where the file doesn't end with one.
  await sh($, '[ -s "$0" ] && [ "$(tail -c 1 "$0")" != "" ] && printf "\\n" >> "$0"; printf "%s\\n" "$1" >> "$0"', file, row)
  return { renamed: clean }
}

async function desktopInstalled($: Engine): Promise<boolean> {
  return (await $.fs.exists('/Applications/Claude.app').catch(() => false)) || (await $.fs.exists(`${await home($)}/Applications/Claude.app`).catch(() => false))
}

/** "desktop" or "terminal": the call's choice, else this computer's setting, else the desktop app when installed. */
async function openTarget($: Engine, requested: unknown): Promise<'desktop' | 'terminal'> {
  if (requested === 'desktop' || requested === 'terminal') return requested
  const config = await readJson($, `${await home($)}/.config/claude-bridge/config.json`)
  if (config?.openIn === 'desktop' || config?.openIn === 'terminal') return config.openIn
  return (await desktopInstalled($)) ? 'desktop' : 'terminal'
}

/** Whether the Claude Code CLI trusts `folder` (or a folder above it). */
async function cliTrusted($: Engine, folder: string): Promise<boolean> {
  const projectsByPath = (await readJson($, `${await home($)}/.claude.json`))?.projects as Record<string, { hasTrustDialogAccepted?: boolean }> | undefined
  if (!projectsByPath) return false
  let path = folder
  while (path) {
    if (projectsByPath[path]?.hasTrustDialogAccepted) return true
    if (path === '/') break
    path = path.slice(0, path.lastIndexOf('/')) || '/'
  }
  return false
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** The newest Claude Code the desktop app ships, else the one on the person's PATH. */
async function claudeBinary($: Engine): Promise<string | undefined> {
  const root = `${await home($)}/Library/Application Support/Claude/claude-code`
  const versions = (await $.fs.list(root).catch(() => [])).map(v => v.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const v of versions) {
    for (const b of await $.fs.list(`${root}/${v}`).catch(() => [])) {
      const path = `${root}/${v}/${b.name}/claude.app/Contents/MacOS/claude`
      if (await $.fs.exists(path).catch(() => false)) return path
    }
  }
  const found = (await sh($, '/bin/zsh -lc "command -v claude"')).trim()
  return found || undefined
}

async function openInTerminal($: Engine, folder: string, args: string[], app?: string): Promise<Result> {
  if (!(await cliTrusted($, folder))) {
    return { error: 'The Claude Code CLI hasn’t been trusted in this folder yet, so it would stop at the trust question. Open it once in a terminal on the computer, or use the desktop app.' }
  }
  const h = await home($)
  const dir = `${h}/.config/claude-bridge/run`
  await $.process.run(['mkdir', '-p', dir])
  const fallback = await claudeBinary($)
  const line = args.map(quote).join(' ')
  const script = `#!/bin/zsh -l\n# Opened by Claude Bridge from the Claude app.\ncd ${quote(folder)} || exit 1\nclear\nif command -v claude >/dev/null 2>&1; then exec claude ${line}; else exec ${fallback ? quote(fallback) : 'claude'} ${line}; fi\n`
  const path = `${dir}/session-${crypto.randomUUID().slice(0, 8)}.command`
  await $.fs.write(path, script)
  await $.process.run(['chmod', '700', path])
  const config = await readJson($, `${h}/.config/claude-bridge/config.json`)
  const chosen = app === 'Terminal' || app === 'iTerm' ? app : typeof config?.terminalApp === 'string' ? config.terminalApp : 'Terminal'
  const r = await $.process.run(['/usr/bin/open', '-a', chosen, path]).catch(error => ({ exitCode: 1, stdout: '', stderr: errorText(error) }))
  return r.exitCode === 0 ? { opened: `opened in a ${chosen} window` } : { error: `${chosen} didn’t open: ${r.stderr.slice(0, 200)}` }
}

async function openSession($: Engine, id: string, folder: string, target: 'desktop' | 'terminal', app?: string, extra: string[] = []): Promise<Result> {
  if (!UUID.test(id)) return { error: 'Not a session id.' }
  if (target === 'terminal') return openInTerminal($, folder, ['--resume', id, ...extra], app)
  rt.desktopCache = undefined
  const record = await desktopRecord($, id)
  const url = record && !record.archived ? `claude://code/continue?session=${record.localId}` : `claude://resume?session=${id}`
  const r = await $.process.run(['/usr/bin/open', url]).catch(error => ({ exitCode: 1, stdout: '', stderr: errorText(error) }))
  return r.exitCode === 0 ? { opened: record && !record.archived ? 'opened in the desktop app' : 'imported into the desktop app' } : { error: `The desktop app didn’t open it: ${r.stderr.slice(0, 200)}` }
}

/** Claude Code run headless for one short turn, with a clean environment (a session's own would turn off saving its transcript). */
async function runClaude($: Engine, folder: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const claude = await claudeBinary($)
  if (!claude) return { ok: false, out: 'Claude Code isn’t installed on this computer.' }
  const h = await home($)
  const user = (await $.env.get('USER').catch(() => undefined)) ?? ''
  const r = await $.process
    .run(
      ['/usr/bin/env', '-i', `HOME=${h}`, `USER=${user}`, `LOGNAME=${user}`, 'PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin', 'LANG=en_US.UTF-8', 'CLAUDE_BRIDGE_BOOTSTRAP=1', claude, ...args],
      { cwd: folder, timeoutMs: 150_000, stdin: '' },
    )
    .catch(error => ({ exitCode: 1, stdout: '', stderr: errorText(error) }))
  return { ok: r.exitCode === 0, out: `${r.stdout}${r.stderr}` }
}

function modelArguments(model: unknown, effort: unknown): string[] {
  const args: string[] = []
  if (typeof model === 'string' && /^[A-Za-z0-9._\-[\]]{1,80}$/.test(model)) args.push('--model', model)
  if (typeof effort === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) args.push('--effort', effort)
  return args
}

const BOOTSTRAP = 'This session was started from the Claude app through Claude Bridge. Its first request follows in the next message. Reply with only: Ready.'

async function knownProject($: Engine, folder: string): Promise<boolean> {
  const list = (await projects($, 500)).projects as Array<{ folder: string }>
  return list.some(p => p.folder === folder)
}

async function startSession($: Engine, folder: string, name: string | undefined, target: 'desktop' | 'terminal'): Promise<Result> {
  const stat = await $.fs.stat(folder).catch(() => undefined)
  if (stat?.kind !== 'dir') return { error: 'That folder isn’t on this computer.' }
  if (!(await knownProject($, folder))) return { error: 'Claude Code has never worked in that folder; start the first session there on the computer.' }
  const id = crypto.randomUUID()
  if (target === 'terminal') {
    const opened = await openInTerminal($, folder, ['--session-id', id, ...(name ? ['-n', name] : [])])
    return opened.error ? opened : { id, opened: opened.opened }
  }
  const r = await runClaude($, folder, ['-p', '--session-id', id, '--output-format', 'json', BOOTSTRAP])
  const h = await home($)
  if (!(await $.fs.exists(`${transcriptsDir(h, folder)}/${id}.jsonl`).catch(() => false))) return { error: `Claude Code didn’t start the session: ${r.out.slice(-300)}` }
  if (name) await renameSession($, id, folder, name)
  const opened = await openSession($, id, folder, 'desktop')
  return opened.error ? { id, error: opened.error } : { id, opened: opened.opened }
}

function forkNote(parent: string, model?: string, effort?: string): string {
  const same = model ? ` It runs on ${model}${effort ? ` at ${effort} effort` : ''}, as the original does.` : ''
  return `## Side chat\nThe person forked this session from the Claude app (Claude Bridge) to work on something else while the original session (${parent}) carries on with its own work.${same} The side task comes in the next message. Leave the original session's work alone unless the person asks otherwise. Reply with only: Ready.`
}

async function forkSession($: Engine, args: Result, folder: string): Promise<Result> {
  const id = String(args.id ?? '')
  const h = await home($)
  if (!UUID.test(id) || !(await $.fs.exists(`${transcriptsDir(h, folder)}/${id}.jsonl`).catch(() => false))) return { error: 'That session’s transcript isn’t on this computer.' }
  const same = modelArguments(args.model, args.effort)
  const fresh = crypto.randomUUID()
  const r = await runClaude($, folder, [
    '-p', '--resume', id, '--fork-session', '--session-id', fresh, '--output-format', 'json', ...same,
    forkNote(id, same.length ? String(args.model) : undefined, typeof args.effort === 'string' ? args.effort : undefined),
  ])
  if (!(await $.fs.exists(`${transcriptsDir(h, folder)}/${fresh}.jsonl`).catch(() => false))) return { error: `Claude Code didn’t fork the session: ${r.out.slice(-300)}` }
  if (typeof args.name === 'string' && args.name) await renameSession($, fresh, folder, args.name)
  const target = await openTarget($, args.open_in)
  const opened = await openSession($, fresh, folder, target, typeof args.terminal_app === 'string' ? args.terminal_app : undefined, same)
  return opened.error ? { id: fresh, error: opened.error } : { id: fresh, opened: opened.opened }
}

/** A call the relay makes of this computer: answered here, as the device agent would answer it. */
export async function runComputer($: Engine, tool: string, args: Result): Promise<Result> {
  const folder = typeof args.folder === 'string' ? args.folder : ''
  try {
    switch (tool) {
      case 'projects':
        return await projects($, Math.min(50, Number(args.limit ?? 25) || 25))
      case 'sessions':
        return await sessions($, folder, Math.min(15, Number(args.limit ?? 15) || 15))
      case 'names': {
        const h = await home($)
        const names: Record<string, string> = {}
        for (const item of (args.sessions as Array<{ id?: string; folder?: string }> | undefined) ?? []) {
          if (!item.id || !item.folder) continue
          const info = await sessionInfo($, h, item.id, item.folder)
          if (info) names[item.id] = info.name
        }
        return { names }
      }
      case 'rename_session':
        return await renameSession($, String(args.id ?? ''), folder, String(args.name ?? ''))
      case 'open_session':
        return await openSession($, String(args.id ?? ''), folder, await openTarget($, args.open_in))
      case 'start_session':
        return await startSession($, folder, typeof args.name === 'string' ? args.name : undefined, await openTarget($, args.open_in))
      case 'fork_session':
        return await forkSession($, args, folder)
      case 'screenshot': {
        const shot = await captureScreen($)
        return { data: shot.data, mimeType: shot.mimeType }
      }
      default:
        return { error: `This computer’s Claude Bridge doesn’t know ${tool}; update the plugin.` }
    }
  } catch (error) {
    return { error: errorText(error) }
  }
}
