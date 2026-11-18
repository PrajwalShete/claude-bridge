// The person's own instructions for the Claude app's assistant: how it talks and behaves with them.
// Written in the panel, kept by the relay (the account's Durable Object), read by the assistant
// with get_instructions at the start of every conversation. The panel reads and saves them over
// HTTPS with this computer's credential (the account's key, or a linked computer's own).

import { atom, update } from 'claude-code'

import { relayUrl, savedCredential } from './connector'
import { type Engine, errorText, note, INITIAL_LINK } from './state'

const link = atom({ plugin: 'codebridge', key: 'link' } as const, INITIAL_LINK)

async function call($: Engine, method: 'GET' | 'PUT', text?: string): Promise<{ text?: string; updatedAt?: string; error?: string }> {
  const credential = await savedCredential($)
  if (!credential) return { error: 'This computer isn’t connected to an account yet.' }
  const r = await $.http.fetch(`${relayUrl()}/api/instructions`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    ...(method === 'PUT' ? { body: JSON.stringify({ text }) } : {}),
  })
  return JSON.parse(r.text) as { text?: string; updatedAt?: string; error?: string }
}

/** Reads the saved instructions into the panel. */
export async function loadInstructions($: Engine): Promise<void> {
  try {
    const got = await call($, 'GET')
    if (got.error) return void (await note($, `instructions: ${got.error}`))
    await update($, link, s => ({ ...s, instructions: got.text ?? '', instructionsNote: got.updatedAt ? `Saved ${got.updatedAt.slice(0, 16).replace('T', ' ')} UTC` : '' }))
  } catch (error) {
    await note($, `instructions: couldn't read them: ${errorText(error)}`)
  }
}

/** Saves the instructions; the Claude app's assistant reads them in its next conversation. */
export async function saveInstructions($: Engine, text: string): Promise<void> {
  await update($, link, s => ({ ...s, instructions: text, instructionsNote: 'Saving…' }))
  try {
    const got = await call($, 'PUT', text)
    await update($, link, s => ({
      ...s,
      instructionsNote: got.error ? `Not saved: ${got.error}` : 'Saved. The Claude app uses them from its next conversation.',
    }))
  } catch (error) {
    await update($, link, s => ({ ...s, instructionsNote: `Not saved: ${errorText(error)}` }))
  }
}
