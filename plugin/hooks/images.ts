// Pictures for the Claude app: a screenshot of the computer's screen, or an image Claude Code
// chose to share. Each is made a JPEG no wider or taller than 1280 px, small enough for the
// relay's 1 MiB message limit with room for the reply beside it.

import { type Engine, baseName } from './state'

export type Picture = { data: string; mimeType: string; caption?: string }

const MAX_EDGE = 1280
/** Base64 characters one picture may take; several still fit in one relay message. */
const MAX_BASE64 = 450_000
const IMAGE_TYPES = /\.(png|jpe?g|gif|heic|heif|webp|tiff?|bmp)$/i

async function tempPath($: Engine, ext: string): Promise<string> {
  return `/tmp/claude-bridge-${(await $.clock.now()).toString(36)}-${Math.random().toString(36).slice(2, 6)}.${ext}`
}

/** Converts any image macOS reads to a small JPEG, lowering the quality until it fits. */
async function toJpeg($: Engine, source: string): Promise<string> {
  const out = await tempPath($, 'jpg')
  try {
    for (const quality of [70, 55, 40, 30]) {
      const made = await $.process.run(
        ['sips', '-Z', String(MAX_EDGE), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), source, '--out', out],
        { timeoutMs: 30_000 },
      )
      if (made.exitCode !== 0) throw new Error(`Couldn’t read the image: ${made.stderr.trim().slice(0, 200)}`)
      const read = await $.fs.read(out, { as: 'bytes' })
      if (read.base64.length <= MAX_BASE64) return read.base64
    }
    throw new Error('The image is too detailed to send, even at low quality.')
  } finally {
    await $.process.run(['rm', '-f', out]).catch(() => undefined)
  }
}

/** A screenshot of the whole screen, as it is now. */
export async function captureScreen($: Engine): Promise<Picture> {
  const shot = await tempPath($, 'png')
  try {
    const taken = await $.process.run(['screencapture', '-x', '-t', 'png', shot], { timeoutMs: 15_000 })
    const exists = await $.fs.exists(shot)
    if (taken.exitCode !== 0 || !exists) {
      throw new Error(
        'The screen couldn’t be captured. Screen Recording may be off for Claude: System Settings → Privacy & Security → Screen & System Audio Recording.',
      )
    }
    return { data: await toJpeg($, shot), mimeType: 'image/jpeg', caption: 'The computer’s screen just now' }
  } finally {
    await $.process.run(['rm', '-f', shot]).catch(() => undefined)
  }
}

/** An image file Claude Code wants the person to see. */
export async function prepareImage($: Engine, path: string, caption?: string): Promise<Picture> {
  if (!IMAGE_TYPES.test(path)) throw new Error('That isn’t an image file (PNG, JPEG, GIF, HEIC, WebP, TIFF or BMP).')
  const info = await $.fs.stat(path).catch(() => undefined)
  if (!info || info.kind !== 'file') throw new Error(`There is no image at ${path}.`)
  return { data: await toJpeg($, path), mimeType: 'image/jpeg', caption: caption || baseName(path) }
}
