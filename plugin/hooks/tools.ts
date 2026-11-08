// The tools the Claude app calls through the relay (their names and descriptions live in
// relay/src/tools.ts). None of them waits for Claude Code to work: send_message and
// answer_question return at once, and what Claude Code does next reaches the app as news
// (register.tsx sends it; the relay's feed hands it on).

import { catchUp } from './catchup'
import { sendMessage, stopClaude } from './claude'
import { type Picture, captureScreen } from './images'
import { ask } from './side'
import { type ConnectorEvent, post } from './connector'
import { computerSetting } from './device'
import { answerFromApp } from './questions'
import { type Engine, addLog, errorText, rt } from './state'

type Result = Record<string, unknown>

export async function answerTool($: Engine, event: Extract<ConnectorEvent, { t: 'tool' }>): Promise<void> {
  let response: Result
  try {
    response = await runTool($, event.name, event.args ?? {})
  } catch (error) {
    response = { error: errorText(error) }
  }
  await post($, '/tool_response', { id: event.id, response }).catch(() => undefined)
}

async function runTool($: Engine, name: string, args: Record<string, unknown>): Promise<Result> {
  switch (name) {
    case 'send_message':
      return sendMessage($, String(args.text ?? ''), args.mode === 'draft' ? 'draft' : 'send')
    case 'answer_question': {
      const answered = await answerFromApp($, args)
      if (answered.status !== 'answered') return answered
      return { status: 'answered', note: 'Claude Code carries on with the answer. What it does next comes as an update from this session.' }
    }
    case 'catch_up':
      return catchUp($, args)
    case 'ask':
      return ask($, String(args.question ?? ''))
    case 'session_setting':
      // The relay asks this when forking a side chat from this session: what it runs on now.
      return {
        model: rt.model || (await $.session.model().catch(() => '')),
        effort: rt.effort || ((await $.env.get('CLAUDE_EFFORT').catch(() => undefined)) ?? ''),
      }
    case 'stop_session':
      return stopClaude($)
    case 'show_screen': {
      if ((await computerSetting($, 'screen')) === false) {
        return { error: 'Screenshots are turned off on this computer (Claude Bridge panel, setup). The person can turn them on there.' }
      }
      const shot = await captureScreen($)
      await addLog($, { kind: 'event', text: 'Showed the screen to the Claude app' })
      return { status: 'shown', note: 'A screenshot of the screen is attached, with a private link to open it. Give the person the link.', _images: [picture(shot)] }
    }
    default:
      return { error: `No tool named ${name}. The Claude app may have an old tool list: remove and add the connector again.` }
  }
}

function picture(p: Picture): { data: string; mimeType: string } {
  return { data: p.data, mimeType: p.mimeType }
}
