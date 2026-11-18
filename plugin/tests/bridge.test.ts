import { expect, mock, test } from 'claude-code/testing'

import { filesTouched } from '../hooks/catchup'
import { exchangesFrom, page } from '../hooks/transcript'
import { changesOf } from '../hooks/claude'
import { toolResult } from '../hooks/inside'
import { cleanPrompt, isPersonPrompt } from '../hooks/state'
import { FOOTER, PANE } from './fixtures'

test('a computer not linked yet shows how to link it, on every surface', async ($, on) => {
  mock.clock(on)
  for (const surface of ['desktop', 'terminal', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Not linked|Link this computer/ })).toBeDefined()
    expect(await ui.find({ key: surface === 'terminal' ? 'new-account' : 'connect-mode' })).toBeDefined()
    await ui.unmount()
  }
})

/** A computer that holds the account's key, as the first computer does. */
const LINKED = {
  enabled: true, connected: false, watched: false, paused: false, url: 'https://relay.example/0123456789abcdef0123/mcp',
  key: 'cbrg_' + 'a'.repeat(43), askFirst: false, screen: true, openIn: 'auto', linkCode: '', helpers: 'auto', inside: false,
}

test('with the account key, the connect steps show; Settings opens on a press', async ($, on) => {
  mock.clock(on)
  on('state.get', ($, e, next) => (e.key === 'link' ? { value: { value: LINKED, version: 1 } } : next(e)))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'ask-first' })).toBeUndefined()
  await ui.press({ key: 'settings-toggle' })
  expect(await ui.find({ key: 'copy-url' })).toBeDefined()
  expect(await ui.find({ key: 'copy-key' })).toBeDefined()
  expect(await ui.find({ key: 'connect-mode' })).toBeDefined()
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
  expect(await ui.find({ text: /Linked to an account/ })).toBeDefined()
  expect(await ui.find({ key: 'relink' })).toBeDefined()
  expect(await ui.find({ key: 'connect-mode' })).toBeDefined()
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

test('the transcript gives exchanges labelled by origin, skipping compaction, interrupts and tool results', () => {
  const row = (o: Record<string, unknown>) => JSON.stringify(o)
  const text = [
    row({ type: 'user', uuid: 'u1', timestamp: '2026-11-19T10:00:00Z', origin: { kind: 'human' }, message: { content: 'fix the header' } }),
    row({ type: 'assistant', timestamp: '2026-11-19T10:00:05Z', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Edit', input: { file_path: '/p/src/Header.tsx' } }] } }),
    row({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }),
    row({ type: 'assistant', timestamp: '2026-11-19T10:00:09Z', message: { content: [{ type: 'text', text: 'Fixed the header.' }] } }),
    row({ type: 'user', origin: { kind: 'human' }, message: { content: '[Request interrupted by user]' } }),
    row({ type: 'system', subtype: 'compact_boundary' }),
    row({ type: 'user', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation...' } }),
    row({ type: 'user', uuid: 'u2', timestamp: '2026-11-19T11:00:00Z', origin: { kind: 'plugin', name: 'codebridge', asUser: true }, message: { content: 'deploy it' } }),
    row({ type: 'assistant', timestamp: '2026-11-19T11:00:30Z', message: { content: [{ type: 'text', text: 'Deployed.' }] } }),
  ].join('\n')
  const out = exchangesFrom(text)
  expect(out.map(x => [x.from, x.message, x.reply])).toEqual([
    ['computer', 'fix the header', 'Fixed the header.'],
    ['Claude app', 'deploy it', 'Deployed.'],
  ])
  expect(out[0]!.changes).toEqual(['edited Header.tsx'])
  expect(out[1]!.afterCompaction).toBe(true)
})

test('read_session pages never cut a message: an oversized one continues exactly where it stopped', () => {
  const long = (tag: string, n: number) => `${tag} begins. ${'All of it. '.repeat(Math.ceil(n / 11)).slice(0, n)} ${tag} ends.`
  const x = (id: string, n: number, start: number) => ({ id, start, end: start + 1, from: 'computer', at: '', message: `ask ${id}`, reply: long(id, n), changes: [], finishedAt: 't' })
  const selection = [x('a', 3_000, 0), x('b', 25_000, 10)]
  const first = page(selection, 10_000)
  expect((first.items[0] as { reply: string }).reply).toBe(long('a', 3_000))
  expect(first.stop).toBeDefined()
  // Follow the pages to the end and put b's reply back together.
  let reply = ''
  let stop = first.stop
  let pages = 0
  while (stop && pages++ < 10) {
    const rest = selection.slice(stop.index)
    const p = page(rest, 10_000, stop.offset)
    for (const item of p.items as Array<{ reply?: string }>) reply += item.reply ?? ''
    stop = p.stop ? { index: stop.index + p.stop.index, offset: p.stop.offset } : undefined
  }
  expect(reply).toBe(long('b', 25_000))
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

test('without helper programs, answers are built as the connector builds them', () => {
  const shot = toolResult({ status: 'shown', _images: [{ data: 'abc', mimeType: 'image/jpeg' }] })
  expect(shot).toEqual({ content: [{ type: 'text', text: '{"status":"shown"}' }, { type: 'image', data: 'abc', mimeType: 'image/jpeg' }], isError: false })
  expect(toolResult({ error: 'no' }).isError).toBe(true)
  expect(toolResult({ error: 'no', status: 'partial' }).isError).toBe(false)
  const big = toolResult({ status: 'shown', _images: [{ data: 'x'.repeat(970_000), mimeType: 'image/png' }] }) as { content: Array<{ type: string; text?: string }> }
  expect(big.content.length).toBe(1)
  expect(big.content[0]!.text).toContain('too large')
})

test('the Helper programs setting shows in Settings, with a note when connected from inside Claude', async ($, on) => {
  mock.clock(on)
  on('state.get', ($, e, next) => (e.key === 'link' ? { value: { value: { ...LINKED, inside: true, helpers: 'off' }, version: 1 } } : next(e)))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings-toggle' })
  expect(await ui.find({ key: 'helpers' })).toBeDefined()
  expect(await ui.find({ text: /Connected from inside Claude/ })).toBeDefined()
  await ui.unmount()
})


test('the panel has the box for the instructions to the Claude app', async ($, on) => {
  mock.clock(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'instructions' })).toBeDefined()
  expect(await ui.find({ text: /Instructions for the Claude app/ })).toBeDefined()
  await ui.unmount()
})
