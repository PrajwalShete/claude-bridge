import { expect, test } from 'claude-code/testing'

import { PIECE, exchangesFrom, readForward, scanBack, stepLines } from '../hooks/transcript'

/** A transcript of 400 exchanges, over 10 MB, all multi-byte text, and a reader that behaves as
 * Claude Code's does: bytes as base64, refusing an answer over 4 MiB. */
function fixture() {
  const line = (o: Record<string, unknown>) => JSON.stringify(o)
  const rows: string[] = []
  const words = 'नमस्ते दुनिया, यह एक लंबा संदेश है। '
  for (let i = 0; i < 400; i++) {
    rows.push(line({ type: 'user', uuid: `u${i}`, timestamp: `2026-11-19T10:${String(i % 60).padStart(2, '0')}:00Z`, origin: { kind: 'human' }, message: { content: `message ${i} ${words.repeat(200)}` } }))
    rows.push(line({ type: 'assistant', timestamp: `2026-11-19T10:${String(i % 60).padStart(2, '0')}:30Z`, message: { content: [{ type: 'text', text: `reply ${i} ${words.repeat(400)} end ${i}` }] } }))
  }
  const bytes = new TextEncoder().encode(rows.join('\n') + '\n')
  const reads: Array<[number, number]> = []
  const read = async (offset: number, length: number) => {
    const slice = bytes.subarray(offset, offset + length)
    let bin = ''
    for (const b of slice) bin += String.fromCharCode(b)
    const base64 = btoa(bin)
    if (base64.length > 4 * 1024 * 1024) throw new Error(`fs.read: the answer would be over 4 MiB (${base64.length})`)
    reads.push([offset, length])
    return { base64 }
  }
  return { bytes, read, reads, words }
}

test('the last exchange of a 10 MB transcript is found by reading only the newest piece', async () => {
  const { bytes, read, reads, words } = fixture()
  expect(bytes.length).toBeGreaterThan(10 * 1024 * 1024)
  const scan = await scanBack(read, bytes.length, list => list.length >= 1)
  expect(reads.length).toBe(1)
  expect(scan.bytesRead).toBeLessThanOrEqual(PIECE)
  expect(scan.exchanges.at(-1)?.reply).toBe(`reply 399 ${words.repeat(400)} end 399`)
})

test('a full scan reads each byte once, within the limit, with no character cut where pieces meet', async () => {
  const { bytes, read, reads, words } = fixture()
  const scan = await scanBack(read, bytes.length, () => false)
  expect(scan.atStart).toBe(true)
  expect(scan.bytesRead).toBe(bytes.length)
  // No byte read twice: the ranges tile the file exactly.
  const sorted = [...reads].sort((a, b) => a[0] - b[0])
  let at = 0
  for (const [o, n] of sorted) {
    expect(o).toBe(at)
    at = o + n
  }
  expect(at).toBe(bytes.length)
  expect(scan.exchanges.length).toBe(400)
  for (const x of scan.exchanges) expect(x.reply.includes('\uFFFD') || x.message.includes('\uFFFD')).toBe(false)
  expect(scan.exchanges[123]!.message).toBe(`message 123 ${words.repeat(200)}`.trim())
})

test('a page continues by reading only its own bytes, from where it starts', async () => {
  const { bytes, read, words } = fixture()
  const all = (await scanBack(read, bytes.length, () => false)).exchanges
  const from = all[390]!
  const { exchanges, bytesRead } = await readForward(read, from.start, bytes.length)
  expect(exchanges.map(x => x.id)).toEqual(all.slice(390).map(x => x.id))
  expect(bytesRead).toBe(bytes.length - from.start)
  expect(exchanges.at(-1)?.reply).toBe(`reply 399 ${words.repeat(400)} end 399`)
})

test('a running turn reads as steps: messages whole, tool calls as one line, reads grouped, the call going now', () => {
  const r = (o: Record<string, unknown>) => JSON.stringify(o)
  const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input })
  const result = (id: string, error = false) => ({ type: 'tool_result', tool_use_id: id, content: 'long output', is_error: error })
  const text = [
    r({ type: 'user', uuid: 'u1', timestamp: '2026-11-19T10:00:00Z', origin: { kind: 'plugin', name: 'codebridge' }, message: { content: 'fix the date bug' } }),
    r({ type: 'assistant', timestamp: '2026-11-19T10:00:05Z', message: { content: [{ type: 'text', text: "I'm starting on this: looking at how dates are parsed." }, use('a', 'Read', { file_path: '/p/src/date.ts' }), use('b', 'Read', { file_path: '/p/src/parse.ts' })] } }),
    r({ type: 'user', message: { content: [result('a'), result('b')] } }),
    r({ type: 'assistant', timestamp: '2026-11-19T10:01:00Z', message: { content: [{ type: 'text', text: 'Found it: the month is off by one. Editing parse.ts now.' }, use('c', 'Edit', { file_path: '/p/src/parse.ts' }), use('d', 'Bash', { command: 'npm test', description: 'Run the tests' })] } }),
    r({ type: 'user', message: { content: [result('c'), result('d', true)] } }),
    r({ type: 'assistant', timestamp: '2026-11-19T10:02:00Z', message: { content: [use('e', 'Bash', { command: 'npm test -- --fix', description: 'Run the tests again' })] } }),
  ].join('\n')
  const turn = exchangesFrom(text).at(-1)!
  turn.running = true
  const { lines, now } = stepLines(turn, Date.parse('2026-11-19T10:05:00Z'))
  expect(lines).toEqual([
    "10:00 said: I'm starting on this: looking at how dates are parsed.",
    '10:00 Read 2 files: date.ts, parse.ts',
    '10:01 said: Found it: the month is off by one. Editing parse.ts now.',
    '10:01 Edited parse.ts',
    '10:01 Ran: Run the tests (failed)',
  ])
  expect(now).toBe('Running: Run the tests again (for 3 min so far)')
  // Finished, its final words are the reply, not a step.
  const done = exchangesFrom(text + '\n' + r({ type: 'assistant', timestamp: '2026-11-19T10:06:00Z', message: { content: [{ type: 'text', text: 'Fixed; the tests pass.' }] } })).at(-1)!
  const finished = stepLines(done, 0)
  expect(finished.now).toBeUndefined()
  expect(finished.lines.at(-1)).toBe('10:02 Ran: Run the tests again')
  expect(done.reply).toBe('Fixed; the tests pass.')
})
