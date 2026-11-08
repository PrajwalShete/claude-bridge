import { expect, mock, test } from 'claude-code/testing'

import { exchangesOf, filesTouched } from '../hooks/catchup'
import { changesOf } from '../hooks/claude'
import { cleanPrompt, isPersonPrompt } from '../hooks/state'
import { FOOTER, PANE } from './fixtures'

test('a computer not linked yet shows how to link it, on every surface', async ($, on) => {
  mock.clock(on)
  for (const surface of ['desktop', 'terminal', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Not linked|Link this computer/ })).toBeDefined()
    expect(await ui.find({ key: 'new-account' })).toBeDefined()
    await ui.unmount()
  }
})

/** A computer that holds the account's key, as the first computer does. */
const LINKED = {
  enabled: true, connected: false, watched: false, paused: false, url: 'https://relay.example/0123456789abcdef0123/mcp',
  key: 'cbrg_' + 'a'.repeat(43), askFirst: false, screen: true, openIn: 'auto', linkCode: '',
}

test('with the account key, the connect steps show; Settings opens on a press', async ($, on) => {
  mock.clock(on)
  on('state.get', ($, e, next) => (e.key === 'link' ? { value: { value: LINKED, version: 1 } } : next(e)))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'ask-first' })).toBeUndefined()
  await ui.press({ key: 'settings-toggle' })
  expect(await ui.find({ key: 'copy-url' })).toBeDefined()
  expect(await ui.find({ key: 'copy-key' })).toBeDefined()
  expect(await ui.find({ key: 'enabled' })).toBeDefined()
  expect(await ui.find({ key: 'ask-first' })).toBeDefined()
  expect(await ui.find({ key: 'screen' })).toBeDefined()
  expect(await ui.find({ key: 'open-in' })).toBeDefined()
  await ui.unmount()
})

test('a computer linked from the app shows it is linked, and no key to copy', async ($, on) => {
  mock.clock(on)
  const linked = { ...LINKED, key: 'cbd_0123456789abcdef0123_' + 'b'.repeat(64) }
  on('state.get', ($, e, next) => (e.key === 'link' ? { value: { value: linked, version: 1 } } : next(e)))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /Linked from the Claude app/ })).toBeDefined()
  expect(await ui.find({ key: 'copy-key' })).toBeUndefined()
  await ui.unmount()
})

test("the panel lists only the app's messages, each answered or not", async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const log = [
    { id: 'm1', kind: 'app', text: 'fix the header', status: 'done', at: 990_000 },
    { id: 'r1', kind: 'reply', text: 'Fixed the header.', at: 995_000 },
    { id: 'm2', kind: 'app', text: 'deploy it', status: 'working', at: 998_000 },
  ]
  on('state.get', ($, e, next) => (e.key === 'log' ? { value: { value: log, version: 1 } } : next(e)))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /fix the header/ })).toBeDefined()
  expect(await ui.find({ text: /· Answered/ })).toBeDefined()
  expect(await ui.find({ text: /Not answered/ })).toBeDefined()
  expect(await ui.find({ text: /Fixed the header/ })).toBeUndefined()
  await ui.unmount()
})

test("Claude Code's questions go to its own dialog when the app isn't waiting", async ($, on) => {
  mock.clock(on)
  let reached = false
  on('tool.call', () => {
    reached = true
    return { result: { questions: [], answers: {} } }
  })
  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which one?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }],
  })
  expect(reached).toBe(true)
})

test('/bridge opens the panel', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  const ran = await $.command.run({ command: 'bridge', args: '' } as Parameters<typeof $.command.run>[0])
  expect(opened).toEqual(['claude-bridge'])
  expect(ran.text).toContain('panel is open')
})

test('changes are summarised from the tool uses', () => {
  expect(
    changesOf([
      { tool_use_id: 't1', tool: 'Edit', input: { file_path: '/a/b/view.tsx' } },
      { tool_use_id: 't2', tool: 'Edit', input: { file_path: '/a/b/view.tsx' } },
      { tool_use_id: 't3', tool: 'Bash', input: { command: 'npm test', description: 'Run the tests' }, isError: true },
      { tool_use_id: 't4', tool: 'Read', input: { file_path: '/a/x.ts' } },
      { tool_use_id: 't5', tool: 'Read', input: { file_path: '/a/y.ts' } },
    ]),
  ).toEqual(['edited view.tsx', 'ran: Run the tests (it failed)', 'read 2 files'])
})

test('share_image tells Claude Code plainly when the file is not an image', async ($, on) => {
  mock.clock(on)
  const shared = await $.tool.call({ tool: 'mcp__codebridge__share_image', path: '/tmp/notes.txt' } as Parameters<typeof $.tool.call>[0])
  expect(JSON.stringify(shared)).toContain('isn’t an image file')
})

test('prompts are shown without the notes the app wraps around them', () => {
  expect(cleanPrompt('<system-reminder>\n## The user forked this session\n</system-reminder>\nWhy did it fail?')).toBe('Why did it fail?')
  expect(cleanPrompt('<agent-message from="a1">Report: done</agent-message>')).toBe('Report: done')
  expect(cleanPrompt('  fix   the\nbug ')).toBe('fix the bug')
})

test('catch_up reads exchanges from the transcript, typed or sent from the app, skipping notices', () => {
  const use = (tool: string, input: Record<string, unknown>) => ({ tool, input }) as never
  const messages = [
    { role: 'user', text: 'fix the header', toolUses: [] },
    { role: 'assistant', text: 'Looking.', toolUses: [use('Edit', { file_path: '/p/src/Header.tsx' })] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'x', text: 'ok' }] },
    { role: 'assistant', text: 'Fixed the header.', toolUses: [] },
    { role: 'user', text: '[Subagent hand-back] report', toolUses: [] },
    { role: 'assistant', text: 'Noted.', toolUses: [] },
    { role: 'user', text: '<system-reminder>x</system-reminder>deploy it', toolUses: [] },
    { role: 'assistant', text: 'Deployed.', toolUses: [use('Write', { file_path: '/p/notes.md' })] },
  ] as never
  const out = exchangesOf(messages, text => text === 'deploy it')
  expect(out.map(x => [x.from, x.message, x.reply])).toEqual([
    ['computer', 'fix the header', 'Noted.'],
    ['Claude app', 'deploy it', 'Deployed.'],
  ])
  expect(out[0]!.changes).toEqual(['edited Header.tsx'])
  expect(filesTouched(messages)).toEqual(['/p/notes.md', '/p/src/Header.tsx'])
})

test('notices are not the person speaking: hand-backs, fork notes, the bridge side-chat note', () => {
  expect(isPersonPrompt('fix the header')).toBe(true)
  expect(isPersonPrompt('[Subagent hand-back] report')).toBe(false)
  expect(isPersonPrompt('## The user forked this session from another session')).toBe(false)
  expect(isPersonPrompt('## Side chat\nThe person forked this session from the Claude app')).toBe(false)
  expect(isPersonPrompt('we talked about "The user forked this session" earlier')).toBe(true)
})

test('the footer carries one small Bridge button that opens the panel, keeping the mode labels', async ($, on) => {
  mock.clock(on)
  const ui = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect(await ui.find({ key: 'bridge-open' })).toBeDefined()
  expect(await ui.find({ text: /focus/ })).toBeDefined()
  await ui.unmount()
})
