/** This session's line to the Claude app, through the Claude Bridge relay. */
export type LinkState = {
  enabled: boolean
  /** The connector holds its WebSocket to the relay. */
  connected: boolean
  /** The Claude app watches this session: its news reaches the app, and so do its questions. */
  watched: boolean
  /** The person paused Claude Bridge (from any session): the app's calls are all refused. */
  paused: boolean
  /** The connector URL to add in the Claude app, and the key to paste on its sign-in page. */
  url: string
  key: string
  /** While this computer isn't linked to an account yet: the code to read to the Claude app. */
  linkCode: string
  /** This session puts the app's messages in its prompt box for the person to send, instead of running them. */
  askFirst: boolean
  /** This computer lets the Claude app take screenshots (show_screen). */
  screen: boolean
  /** Where sessions the Claude app starts or resumes open on this computer; `auto`: the desktop app if installed. */
  openIn: 'auto' | 'desktop' | 'terminal'
  /** This computer's choice of connection: the background service and helper programs (`on`), none (`off`), or `auto` (them, unless macOS refuses them). */
  helpers: 'auto' | 'on' | 'off'
  /** This session is connected from inside Claude, with no helper programs (the no-helper mode). */
  inside: boolean
}

export type ClaudeReply = { text: string; at: number; changes: string[] }

/** What Claude Code is doing, as the turn and tool events tell it. */
export type ClaudeActivity = {
  isWorking: boolean
  turnId?: string
  startedAt?: number
  /** What the turn was asked, short. */
  task?: string
  tools: string[]
  replies: ClaudeReply[]
}

/** Where a message from the Claude app stands. */
export type MessageStatus = 'queued' | 'sending' | 'working' | 'done' | 'stopped' | 'failed' | 'held'

export type LogKind = 'app' | 'reply' | 'answer' | 'event'

/** One line of the panel's activity list. */
export type LogEntry = {
  id: string
  kind: LogKind
  text: string
  status?: MessageStatus
  at: number
}

export type QuestionOption = { label: string; description?: string }

export type BridgeQuestion = {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

/** A question Claude Code asked (AskUserQuestion) while the Claude app was waiting on it. */
export type PendingQuestion = {
  id: string
  questions: BridgeQuestion[]
  /** What the person has picked in the panel so far, per question. */
  picks: string[][]
}

declare module 'claude-code' {
  interface PluginState {
    codebridge: {
      link: LinkState
      claude: ClaudeActivity
      log: LogEntry[]
      question: PendingQuestion | null
      settingsOpen: boolean
      /** The panel's Settings subsection is open. */
      settingsShown: boolean
      paneShown: boolean
      /** Counts seconds while Claude Code works, so its timer redraws. */
      tick: number
      /** The app's messages waiting to join a turn, and those the running turn carries: kept in
       * the session's state so a plugin reload between a send and its turn keeps the "for the app" mark. */
      turnMarks: { entering: string[]; turnEntries: string[] }
    }
  }
}
