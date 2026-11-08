// The panel, and the small Bridge button in the prompt's footer. Pure: state in, tree out.

import type { Elements, RenderChildren, RenderSurface } from 'claude-code'

import type { ClaudeActivity, LinkState, LogEntry, PendingQuestion } from '../types'

export type ViewModel = {
  link: LinkState
  claude: ClaudeActivity
  log: LogEntry[]
  question: PendingQuestion | null
  setupOpen: boolean
  settingsShown: boolean
  tick: number
  now: number
  rows: number
}

export type Actions = {
  setWatched: (on: boolean) => void
  /** Pauses Claude Bridge everywhere (every session, every computer), or resumes it. */
  togglePause: () => void
  toggleSetup: () => void
  toggleSettings: () => void
  setEnabled: (on: boolean) => void
  setAskFirst: (on: boolean) => void
  setScreen: (on: boolean) => void
  setOpenIn: (where: 'auto' | 'desktop' | 'terminal') => void
  newKey: () => void
  copy: (text: string, surface: RenderSurface) => void
  clear: () => void
  pick: (question: number, label: string) => void
  sendPicks: () => void
  answerOnScreen: () => void
  openPane: () => void
  /** The first computer of an account: make its key here. */
  startNewAccount: () => void
}

const ON_OFF = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
]

const OPEN_IN = [
  { value: 'auto', label: 'Auto' },
  { value: 'desktop', label: 'Desktop app' },
  { value: 'terminal', label: 'Terminal' },
]

const MESSAGES = [
  { value: 'run', label: 'Run them' },
  { value: 'ask', label: 'Ask me first' },
]

export function linkLine(l: LinkState): { text: string; color: string } {
  if (!l.enabled) return { text: 'Off', color: 'inactive' }
  if (!l.key) return { text: 'Not linked to your account yet', color: 'inactive' }
  if (!l.connected) return { text: 'Connecting…', color: 'warning' }
  if (l.paused) return { text: 'Paused · the Claude app can’t reach any session', color: 'inactive' }
  if (l.watched) return { text: 'Watched by the Claude app', color: 'success' }
  return { text: 'Connected · the Claude app can reach it, not watching', color: 'suggestion' }
}

/** The one word the header's status shows. */
function statusWord(l: LinkState): string {
  if (!l.enabled) return 'Off'
  if (!l.key) return 'Not linked'
  if (!l.connected) return 'Connecting'
  if (l.paused) return 'Paused'
  return l.watched ? 'Watched' : 'Connected'
}

/** What the Claude app sent this session: only whether each was answered. */
function appMessages(m: ViewModel): Array<{ id: string; text: string; answered: boolean; at: number }> {
  return m.log
    .filter(entry => entry.kind === 'app')
    .slice(-12)
    .map(entry => ({ id: entry.id, text: entry.text.trim(), answered: entry.status === 'done', at: entry.at }))
}

type Ui = Elements['mobile'] & Partial<Pick<Elements['desktop'], 'Select'>>

/** Small line icons beside each row, as the app's own panels have them (16 px, Tabler-style strokes). */
const ICON = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgb(150,150,150)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const ICONS = {
  status: ICON('<circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="9"/>'),
  pause: ICON('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'),
  watch: ICON('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  messages: ICON('<path d="M4 5h16v11H8l-4 4z"/>'),
  openIn: ICON('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>'),
  screen: ICON('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  connection: ICON('<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0z"/><path d="M12 16v5"/>'),
  link: ICON('<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>'),
  key: ICON('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>'),
}
const DIVIDER =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1" viewBox="0 0 1000 1" preserveAspectRatio="none"><rect width="1000" height="1" fill="rgba(128,128,128,0.28)"/></svg>'

export function panelView(ui: Ui, m: ViewModel, a: Actions) {
  const { Box, Text, Button, Select, Svg } = ui
  const l = linkLine(m.link)
  const messages = appMessages(m)
  const setupShown = m.setupOpen || !m.link.connected
  const live = m.link.enabled && m.link.connected

  /** One row: icon and label on the left, its value or control on the right, one line. */
  const row = (key: string, icon: string, label: string, control: RenderChildren) => (
    <Box key={key} flexDirection="row" alignItems="center" justifyContent="space-between" gap="sm">
      <Box flexDirection="row" alignItems="center" gap="sm" flexShrink={1}>
        <Svg source={icon} alt={label} width={16} height={16} />
        <Text wrap="truncate-end">{label}</Text>
      </Box>
      <Box flexShrink={0}>{control}</Box>
    </Box>
  )
  /** A subsection: its title (and anything at its right), then its rows. */
  const section = (key: string, title: string, body: RenderChildren, right?: RenderChildren) => (
    <Box key={key} flexDirection="column" gap="sm">
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text weight="medium">{title}</Text>
        {right}
      </Box>
      {body}
    </Box>
  )
  const divider = (key: string) => <Svg key={key} source={DIVIDER} alt="Divider" height={1} />

  return (
    <Box flexDirection="column" gap="md" paddingX="md" paddingY="sm">
      {section(
        'bridge',
        'Bridge',
        <Box flexDirection="column" gap="sm">
          {row('status-row', ICONS.status, 'Status', <Text color={l.color}>● {statusWord(m.link)}</Text>)}
          {live &&
            row(
              'pause-row',
              ICONS.pause,
              m.link.paused ? 'Paused everywhere' : 'Pause everywhere',
              <Button key="pause" variant={m.link.paused ? 'primary' : 'secondary'} label={m.link.paused ? 'Resume' : 'Pause'} onPress={a.togglePause} />,
            )}
          {live &&
            !m.link.paused &&
            row(
              'watch-row',
              ICONS.watch,
              'Watch this session',
              <Button key="watch" variant="secondary" label={m.link.watched ? 'Stop' : 'Watch'} onPress={() => a.setWatched(!m.link.watched)} />,
            )}
        </Box>,
      )}

      {!m.link.key && m.link.enabled && divider('link-divider')}
      {!m.link.key &&
        m.link.enabled &&
        section(
          'link',
          'Link this computer',
          <Box flexDirection="column" gap="sm">
            {row(
              'code-row',
              ICONS.key,
              m.link.linkCode ? m.link.linkCode.replace(/(.{4})(?=.)/g, '$1 ') : 'Making a code…',
              m.link.linkCode ? <Button key="copy-code" variant="secondary" label="Copy" onPress={p => a.copy(m.link.linkCode, p.surface)} /> : undefined,
            )}
            <Text size="footnote" dimColor>
              Tell the Claude app: “link my computer, code {m.link.linkCode ? m.link.linkCode.replace(/(.{4})(?=.)/g, '$1 ') : '…'}”. It connects by itself a few seconds later.
            </Text>
            <Box flexDirection="row">
              <Button key="new-account" plain dimColor label="This is my first computer: start a new account" onPress={a.startNewAccount} />
            </Box>
          </Box>,
        )}

      {m.question && divider('question-divider')}
      {m.question &&
        section(
          'question',
          'Claude Code is asking',
          <Box flexDirection="column" gap="sm">
            {m.question.questions.map((q, i) => (
              <Box flexDirection="column" gap="xs">
                <Text>{q.question}</Text>
                {q.options.length > 0 && (
                  <Box flexDirection="row" flexWrap="wrap" gap="xs">
                    {q.options.map(option => (
                      <Button
                        key={`pick-${i}-${option.label}`}
                        label={option.label}
                        variant={m.question?.picks[i]?.includes(option.label) ? 'primary' : 'secondary'}
                        onPress={() => a.pick(i, option.label)}
                      />
                    ))}
                  </Box>
                )}
              </Box>
            ))}
            <Box flexDirection="row" gap="xs">
              {m.question.questions.some(q => q.multiSelect) && m.question.picks.every(list => list.length > 0) && (
                <Button key="send-picks" variant="primary" label="Send answers" onPress={a.sendPicks} />
              )}
              <Button key="on-screen" plain dimColor label="Answer here instead" onPress={a.answerOnScreen} />
            </Box>
          </Box>,
        )}

      {m.link.key && divider('connect-divider')}
      {m.link.key &&
        m.link.key.startsWith('cbd_') &&
        section(
          'connect',
          'Your account',
          row('linked-row', ICONS.link, 'Linked from the Claude app', <Text color="success">✓</Text>),
        )}
      {m.link.key &&
        !m.link.key.startsWith('cbd_') &&
        section(
        'connect',
        'Connect the Claude app',
        setupShown ? (
          <Box flexDirection="column" gap="sm">
            {row('url-row', ICONS.link, 'Connector URL', <Button key="copy-url" variant="secondary" label="Copy" onPress={p => a.copy(m.link.url, p.surface)} />)}
            {row('key-row', ICONS.key, 'Key', <Button key="copy-key" variant="secondary" label="Copy" onPress={p => a.copy(m.link.key, p.surface)} />)}
            <Text size="footnote" dimColor>
              In the Claude app: Settings, Connectors, Add custom connector with the URL, then paste the key. Another computer joins with /bridge key.
            </Text>
            <Box flexDirection="row">
              <Button key="new-key" plain dimColor label="Make a new key" onPress={a.newKey} />
            </Box>
          </Box>
        ) : undefined,
        <Button key="setup" plain dimColor label={setupShown ? 'Hide' : 'Show'} onPress={a.toggleSetup} />,
      )}

      {divider('settings-divider')}
      {section(
        'settings',
        'Settings',
        m.settingsShown ? <Box flexDirection="column" gap="sm">
          {Select &&
            row(
              'ask-row',
              ICONS.messages,
              'Messages from the app',
              <Select key="ask-first" value={m.link.askFirst ? 'ask' : 'run'} options={MESSAGES} onSelect={v => a.setAskFirst(v === 'ask')} />,
            )}
          {Select &&
            row(
              'open-row',
              ICONS.openIn,
              'Sessions open in',
              <Select key="open-in" value={m.link.openIn} options={OPEN_IN} onSelect={v => a.setOpenIn(v === 'desktop' || v === 'terminal' ? v : 'auto')} />,
            )}
          {Select &&
            row('screen-row', ICONS.screen, 'Screenshots', <Select key="screen" value={m.link.screen ? 'on' : 'off'} options={ON_OFF} onSelect={v => a.setScreen(v === 'on')} />)}
          {Select &&
            row('connection-row', ICONS.connection, 'Connection', <Select key="enabled" value={m.link.enabled ? 'on' : 'off'} options={ON_OFF} onSelect={v => a.setEnabled(v === 'on')} />)}
        </Box> : undefined,
        <Button key="settings-toggle" plain dimColor label={m.settingsShown ? 'Hide' : 'Show'} onPress={a.toggleSettings} />,
      )}

      {divider('messages-divider')}
      {section(
        'messages',
        'Activity',
        messages.length === 0 ? (
          <Text size="footnote" dimColor>
            Messages from the Claude app show up here.
          </Text>
        ) : (
          <Box flexDirection="column" gap="sm">
            {messages.map(message => (
              <Box key={message.id} flexDirection="column">
                <Text size="caption">
                  <Text weight="medium" color="claude">
                    From the Claude app
                  </Text>
                  <Text dimColor> · {message.answered ? 'Answered' : 'Not answered'}</Text>
                </Text>
                <Text size="footnote" wrap="wrap">
                  {message.text}
                </Text>
              </Box>
            ))}
          </Box>
        ),
        messages.length > 0 ? <Button key="clear" plain dimColor label="Clear" onPress={a.clear} /> : undefined,
      )}
    </Box>
  )
}

export function terminalView(ui: Elements['terminal'], m: ViewModel, a: Actions) {
  const { Box, Text, Button, Select } = ui
  const l = linkLine(m.link)
  const room = Math.max(0, m.rows - (m.setupOpen ? 18 : 12) - (m.question ? 6 : 0))
  const messages = appMessages(m).slice(0, Math.max(0, room))
  const live = m.link.enabled && m.link.connected

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text bold>Claude Bridge</Text> <Text color={l.color}>● {statusWord(m.link)}</Text>
      </Text>
      {!m.link.key && m.link.enabled && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Link this computer: tell the Claude app “link my computer, code{' '}
            <Text bold>{m.link.linkCode ? m.link.linkCode.replace(/(.{4})(?=.)/g, '$1 ') : '…'}</Text>”.
          </Text>
          <Button key="new-account" plain dimColor label="This is my first computer: start a new account" onPress={a.startNewAccount} />
        </Box>
      )}
      <Box flexDirection="row" gap={1} marginTop={1}>
        {live && <Button key="pause" label={m.link.paused ? 'Resume' : 'Pause everywhere'} onPress={a.togglePause} />}
        {live && !m.link.paused && <Button key="watch" label={m.link.watched ? 'Stop watching' : 'Watch'} onPress={() => a.setWatched(!m.link.watched)} />}
      </Box>
      {m.question && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="claude" paddingX={1}>
          <Text color="claude" bold>
            Claude Code is asking
          </Text>
          {m.question.questions.map((q, i) => (
            <Box flexDirection="column">
              <Text wrap="wrap">{q.question}</Text>
              <Box flexDirection="row" flexWrap="wrap" gap={1}>
                {q.options.map(option => (
                  <Button
                    key={`pick-${i}-${option.label}`}
                    label={option.label}
                    variant={m.question?.picks[i]?.includes(option.label) ? 'primary' : undefined}
                    onPress={() => a.pick(i, option.label)}
                  />
                ))}
              </Box>
            </Box>
          ))}
          <Box flexDirection="row" gap={1}>
            {m.question.questions.some(q => q.multiSelect) && m.question.picks.every(list => list.length > 0) && (
              <Button key="send-picks" variant="primary" label="Send" onPress={a.sendPicks} />
            )}
            <Button key="on-screen" label="Answer here" onPress={a.answerOnScreen} />
          </Box>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Select key="ask-first" label="Messages from the app " value={m.link.askFirst ? 'ask' : 'run'} options={MESSAGES} onSelect={v => a.setAskFirst(v === 'ask')} />
        <Select key="open-in" label="Sessions open in " value={m.link.openIn} options={OPEN_IN} onSelect={v => a.setOpenIn(v === 'desktop' || v === 'terminal' ? v : 'auto')} />
        <Select key="screen" label="Screenshots " value={m.link.screen ? 'on' : 'off'} options={ON_OFF} onSelect={v => a.setScreen(v === 'on')} />
        <Select key="enabled" label="Connection " value={m.link.enabled ? 'on' : 'off'} options={ON_OFF} onSelect={v => a.setEnabled(v === 'on')} />
      </Box>
      {messages.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>From the Claude app</Text>
          {messages.map(message => (
            <Text wrap="truncate-end">
              <Text color={message.answered ? 'success' : 'inactive'}>{message.answered ? '✓ ' : '· '}</Text>
              {message.text}
            </Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Button key="setup" plain dimColor label={m.setupOpen ? 'Connect the Claude app ▾' : 'Connect the Claude app ▸'} onPress={a.toggleSetup} />
        {m.setupOpen && (
          <>
            <Box flexDirection="row" gap={1}>
              <Button key="copy-url" label="Copy connector URL" onPress={p => a.copy(m.link.url, p.surface)} />
              <Button key="copy-key" label="Copy key" onPress={p => a.copy(m.link.key, p.surface)} />
            </Box>
            <Button key="new-key" plain dimColor label="Make a new key" onPress={a.newKey} />
          </>
        )}
      </Box>
    </Box>
  )
}

/**
 * The small Bridge button in the prompt's footer, beside the mode labels (kept): opens the panel.
 * Its dot is green while Claude Bridge runs, grey while it is paused (or off).
 */
export function footerView(ui: Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'>, m: ViewModel, a: Actions, modes: readonly string[]) {
  const { Box, Text, Button } = ui
  return (
    <Box flexDirection="row" gap="sm" alignItems="center">
      <Box flexDirection="row" alignItems="center">
        {/* A Button draws its children in its own colour, so the dot sits just outside it. */}
        <Text size="footnote" color={m.link.paused || !m.link.enabled || !m.link.key ? 'inactive' : 'success'}>
          ●
        </Text>
        <Button key="bridge-open" plain dimColor label="Bridge" onPress={a.openPane} />
      </Box>
      {modes.length > 0 && (
        <Text size="footnote" dimColor>
          {modes.join(' & ')}
        </Text>
      )}
    </Box>
  )
}

/** The same in the terminal's footer, as text. */
export function terminalFooterView(ui: Pick<Elements['terminal'], 'Box' | 'Text'>, m: ViewModel, modes: readonly string[]) {
  const { Box, Text } = ui
  const l = linkLine(m.link)
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={l.color}>●</Text>
      <Text dimColor>bridge</Text>
      {modes.length > 0 && <Text dimColor>· {modes.join(' & ')}</Text>}
    </Box>
  )
}
