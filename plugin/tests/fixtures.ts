export const PANE = {
  plugin: 'codebridge',
  component: 'Pane',
  requestId: 'claude-bridge',
  props: { title: 'Claude Bridge', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  viewport: { columns: 140, rows: 48, isFullscreen: true },
} as const

export const FOOTER = {
  plugin: 'codebridge',
  component: 'SessionMode',
  props: { modes: ['focus'] },
  viewport: { columns: 120, rows: 40, isFullscreen: false },
} as const
