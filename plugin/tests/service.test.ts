import { type TestBody, expect, mock, test } from 'claude-code/testing'

/**
 * A fake Mac: files in a map, commands answered by `run`. launchd's answers say whether macOS
 * lets the background service run (`allowed`).
 */
function fakeMac(on: Parameters<TestBody>[1], allowed: boolean) {
  const HOME = '/Users/t'
  const files = new Map<string, string>([
    [`${HOME}/.config/claude-bridge/key`, `cbrg_${'a'.repeat(43)}\n`],
    [`${HOME}/.config/claude-bridge/device.json`, '{"id":"dev-1"}'],
    [`${HOME}/.config/claude-bridge/bin/claude-bridge-device`, 'bin'],
    [`${HOME}/.config/claude-bridge/bin/claude-bridge-device.sha256`, 'x\n'],
    [`${HOME}/.config/claude-bridge/bin/claude-bridge-connector`, 'bin'],
    [`${HOME}/.config/claude-bridge/bin/claude-bridge-connector.sha256`, 'y\n'],
  ])
  const ran: string[] = []
  const fetched: string[] = []
  let bootstrapped = false
  const sha = { 'device.swift': 'x', 'connector.swift': 'y' }
  const value = <T,>(v: T) => ({ value: v }) as never
  on('env.get', ($, e) => value(e.name === 'HOME' ? HOME : undefined))
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('session.id', () => value('11111111-2222-4333-8444-555555555555'))
  on('session.root', () => value('/Users/t/proj'))
  on('session.messages', () => value([]))
  on('session.model', () => value('claude-opus-5-5'))
  on('command.register', () => value(undefined))
  on('tool.register', () => value(undefined))
  on('ui.open', () => value({ isPlaced: false }))
  on('ui.log', () => value(undefined))
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/connector/device.swift') || e.path.endsWith('/connector/connector.swift')) return value('source')
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return value(text)
  })
  on('fs.write', ($, e) => (files.set(e.path, e.text), value(undefined)))
  on('fs.exists', ($, e) => value(files.has(e.path)))
  on('fs.stat', ($, e) => {
    if (!files.has(e.path)) throw new Error(`ENOENT ${e.path}`)
    return value({ kind: 'file', size: 1, mtimeMs: 0 })
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    ran.push(argv.join(' '))
    const ok = (stdout = '') => value({ exitCode: 0, stdout, stderr: '' })
    if (argv[0] === 'id') return ok('501\n')
    if (argv[0] === 'launchctl' && argv[1] === 'bootstrap') {
      bootstrapped = true
      return allowed ? ok() : value({ exitCode: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' })
    }
    if (argv[0] === 'launchctl' && argv[1] === 'print') {
      if (!bootstrapped) return value({ exitCode: 113, stdout: '', stderr: 'Could not find service' })
      return ok(allowed ? 'state = running\n\tpid = 4242\n' : 'state = not running\n\tlast exit code = 9\n')
    }
    if (argv[0] === 'launchctl' && argv[1] === 'bootout') bootstrapped = false
    if (argv[0] === 'rm') for (const path of argv.slice(2)) files.delete(path)
    return ok()
  })
  // The relay welcomes the session once, then is unreachable: the session's retry waits on the
  // test's clock, which never moves, so its loop ends there.
  on('http.fetch', ($, e) => {
    fetched.push(e.url)
    return fetched.length === 1
      ? value({ status: 200, ok: true, headers: {}, text: '{"messages":[{"type":"welcome"}]}' })
      : value({ status: 503, ok: false, headers: {}, text: '{}' })
  })
  // A connector that says it started, then ends: the test asks only whether one was started.
  const spawned: string[] = []
  on('process.spawn', async function* ($, e) {
    spawned.push(String(e.argv[0]))
    yield { stream: 'stdout', text: '{"t":"started","pid":1}\n' } as never
    return value({ code: 0, signal: null })
  })
  return { HOME, files, ran, fetched, spawned, sha }
}

/** Lets the plugin's work left running after session.start finish, up to 3 s. */
async function settle(until: () => boolean) {
  for (let i = 0; i < 300 && !until(); i++) await new Promise(resolve => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout(() => resolve(undefined), 10))
}

test('Auto on a Mac that refuses the background service: removed at once, and the session connects from inside Claude', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const mac = fakeMac(on, false)
  await $.session.start({ cwd: '/Users/t/proj', surface: null, isInteractive: false } as never)
  await settle(() => mac.fetched.some(url => url.endsWith('/peer')))
  const plist = `${mac.HOME}/Library/LaunchAgents/com.claudebridge.device.plist`
  expect(mac.ran.some(c => c.startsWith('launchctl bootstrap'))).toBe(true)
  expect(mac.ran.some(c => c === `rm -f ${plist}`)).toBe(true)
  expect(mac.files.has(plist)).toBe(false)
  expect(JSON.parse(mac.files.get(`${mac.HOME}/.config/claude-bridge/config.json`) ?? '{}').helpersBlocked).toBe(true)
  expect(mac.fetched.some(url => url.endsWith('/peer'))).toBe(true)
  // No connector was tried after the refusal: one macOS prompt at most.
  expect(mac.spawned).toEqual([])
})

test('Auto on a Mac that runs it: the background service is installed for login, and stays', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const mac = fakeMac(on, true)
  await $.session.start({ cwd: '/Users/t/proj', surface: null, isInteractive: false } as never)
  await settle(() => mac.spawned.length > 0)
  const plist = mac.files.get(`${mac.HOME}/Library/LaunchAgents/com.claudebridge.device.plist`) ?? ''
  expect(plist).toContain('<key>RunAtLoad</key><true/>')
  expect(plist).toContain('<key>KeepAlive</key><true/>')
  expect(JSON.parse(mac.files.get(`${mac.HOME}/.config/claude-bridge/config.json`) ?? '{}').helpersBlocked).toBeUndefined()
  expect(mac.fetched.some(url => url.endsWith('/peer'))).toBe(false)
  expect(mac.spawned[0]).toContain('claude-bridge-connector')
})
