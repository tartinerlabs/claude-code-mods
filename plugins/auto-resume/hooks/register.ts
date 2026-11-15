import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import type { ResumeAt } from '../types'

const PROMPT = 'continue'
// Give the limit a moment past its reset before trying again.
const BUFFER_MS = 60_000
// When no exhausted window says when it resets, try again after this long.
const FALLBACK_MS = 5 * 60_000

// Held by the host, so a pending resume survives a hot reload of this file.
const resumeAt = atom({ plugin: 'auto-resume', key: 'resumeAt' } as const, null as ResumeAt)

// The module's own ticker: a reload drops it, and session.start arms it again.
let ticker: Timer | undefined

// Each step goes to the debug log, so a resume that never came can be traced.
function note($: EngineInterface, text: string) {
  $.ui.log(`auto-resume: ${text}`, { to: 'debug' })
}

async function cancel($: EngineInterface) {
  ticker?.cancel()
  ticker = undefined
  $.ui.status(undefined)
  await update($, resumeAt, () => null)
}

async function arm($: EngineInterface, at: number) {
  ticker?.cancel()
  await update($, resumeAt, () => at)
  const now = await $.clock.now()
  note($, `armed for ${new Date(at).toISOString()}`)
  $.ui.status(`⏸ auto-resume in ${countdown(at - now)}`)
  // Each tick reads the time, so a wait the machine slept through still ends on waking.
  ticker = $.clock.every(1000, async () => {
    // A tick landing after a cancel must neither redraw the line nor resume.
    if ((await read($, resumeAt)) !== at) return
    const left = at - (await $.clock.now())
    if (left > 0) return $.ui.status(`⏸ auto-resume in ${countdown(left)}`)
    await resume($)
  })
}

async function resume($: EngineInterface) {
  await cancel($)
  try {
    note($, 'sending continue')
    $.ui.toast('Usage limit reset, resuming')
    await $.prompt.submit({ text: PROMPT })
  } catch (error) {
    note($, `send failed, trying again: ${error}`)
    await arm($, (await $.clock.now()) + FALLBACK_MS)
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'auto-resume',
      description: 'Show when the session resumes after a usage limit; "cancel" to stop it',
      argumentHint: '[cancel]',
    })
    // Re-arm a resume planned before a reload.
    const at = await read($, resumeAt)
    if (at !== null) await arm($, at)

    return result
  })

  on('classic.StopFailure', async ($, e, next) => {
    const result = await next(e)
    if (e.error !== 'rate_limit') return result

    const { rateLimits } = await $.session.usage()
    const now = await $.clock.now()
    const reset = resetOf(rateLimits)
    note($, `rate limited, windows ${JSON.stringify(rateLimits)}`)
    await arm($, reset === null ? now + FALLBACK_MS : Math.max(reset, now) + BUFFER_MS)

    return result
  }).catch(($, e, next) => next(e))

  // The person picked the session back up themselves.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      if ((await read($, resumeAt)) !== null) {
        note($, `cancelled by a ${e.origin.kind} prompt`)
        await cancel($)
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'auto-resume' }, async ($, e) => {
    const at = await read($, resumeAt)
    if (e.args?.trim() === 'cancel') {
      if (at === null) return { text: 'No resume pending.' }
      note($, 'cancelled by /auto-resume cancel')
      await cancel($)

      return { text: 'Auto-resume cancelled.' }
    }
    if (at === null) return { text: 'No resume pending.' }

    return { text: `Resuming in ${span(at - (await $.clock.now()))}.` }
  })
}

/** When the last exhausted window resets, in ms since the epoch; null when none says. */
export function resetOf(limits: readonly SessionRateLimit[]) {
  const resets = limits
    .filter(limit => limit.percentUsed >= 100 && limit.resetsAt)
    .map(limit => Date.parse(limit.resetsAt!))
    .filter(ms => !Number.isNaN(ms))

  return resets.length ? Math.max(...resets) : null
}

export function span(ms: number) {
  const m = Math.max(0, Math.ceil(ms / 60_000))
  if (m < 60) return `${m}m`

  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** A ticking clock for the status line: `1:59:42`, or `4:59` under an hour. */
export function countdown(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')

  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
