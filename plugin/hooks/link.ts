// Linking a new computer to the person's account, with no key copied between machines.
//
// A computer with no credential shows a code (12 letters and digits, kept in
// ~/.config/claude-bridge/link.json so every session on it shows the same one) and offers it to
// the relay. The person reads the code to the Claude app, which is signed in to the account; it
// links the computer (link_computer), and the relay hands this computer its own credential, which
// every session here then uses. The first computer of an account makes its key instead
// (Start a new account here).

import { atom, update } from 'claude-code'

import { bridgeKey, relayUrl, savedCredential, startConnector } from './connector'
import { ensureDeviceAgent } from './device'
import { type Engine, errorText, note, rt, INITIAL_LINK } from './state'

const link = atom({ plugin: 'codebridge', key: 'link' } as const, INITIAL_LINK)

/** No I, O, 0 or 1: a code read aloud can't be misheard as another. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

async function linkFile($: Engine): Promise<string> {
  return `${(await $.env.get('HOME').catch(() => undefined)) ?? '/tmp'}/.config/claude-bridge/link.json`
}

/** The code this computer offers, the same in every session on it, made anew when it ran out. */
async function currentCode($: Engine): Promise<string> {
  const path = await linkFile($)
  try {
    const saved = JSON.parse(String(await $.fs.read(path))) as { code?: string; expires?: number }
    if (saved.code && (saved.expires ?? 0) > (await $.clock.now()) + 60_000) return saved.code
  } catch {
    // none yet
  }
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  const code = [...bytes].map(b => ALPHABET[b % ALPHABET.length]).join('')
  const offered = await $.http.fetch(`${relayUrl()}/link/${code}`, { method: 'POST' })
  const { expires } = JSON.parse(offered.text) as { expires: number }
  await $.fs.write(path, JSON.stringify({ code, expires }))
  return code
}

/** Shows the code and waits for the person to link this computer from the Claude app. */
export async function startLinking($: Engine): Promise<void> {
  if (rt.linking) return
  rt.linking = true
  try {
    while (rt.linking) {
      // Another session here may have been handed the credential already.
      if (await savedCredential($)) break
      let code: string
      try {
        code = await currentCode($)
      } catch (error) {
        await note($, `linking: couldn't reach the relay: ${errorText(error)}`)
        await $.clock.sleep(15_000)
        continue
      }
      await update($, link, s => ({ ...s, linkCode: code }))
      const waited = await $.http.fetch(`${relayUrl()}/link/${code}`, { method: 'GET' }).catch(() => undefined)
      if (!waited?.ok) {
        await $.clock.sleep(5_000)
        continue
      }
      const answer = JSON.parse(waited.text) as { credential?: string; expired?: true; pending?: true }
      if (answer.credential) {
        await bridgeKey($, false, answer.credential)
        await note($, 'linked to the account from the Claude app')
        break
      }
      if (answer.expired) await $.fs.write(await linkFile($), '{}')
    }
  } finally {
    rt.linking = false
  }
  if (await savedCredential($)) {
    await update($, link, s => ({ ...s, linkCode: '' }))
    await startConnector($)
    await ensureDeviceAgent($)
  }
}

/** The first computer of an account: its key is made here, and the Claude app is connected with it. */
export async function startNewAccount($: Engine): Promise<void> {
  rt.linking = false
  await bridgeKey($, true)
  await update($, link, s => ({ ...s, linkCode: '' }))
  await startConnector($)
  await ensureDeviceAgent($)
}
