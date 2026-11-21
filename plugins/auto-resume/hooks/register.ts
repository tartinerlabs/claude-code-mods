import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import type { ResumeAt } from '../types'

const PROMPT = 'continue'
// Give the limit a moment past its reset before trying again.
const BUFFER_MS = 60_000
// When nothing says when the limit resets, try again after this long, doubling on each miss up to the cap.
const FALLBACK_MS = 5 * 60_000
const FALLBACK_CAP_MS = 60 * 60_000

// Held by the host, so a pending resume survives a hot reload of this file.
const resumeAt = atom({ plugin: 'auto-resume', key: 'resumeAt' } as const, null as ResumeAt)

// The module's own ticker: a reload drops it, and session.start arms it again.
let ticker: Timer | undefined
// Fallback retries in a row that still hit the limit; a known reset or the person's own prompt clears it.
let misses = 0

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
    misses = 0
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
    // A limit the windows don't report, such as one model's own, still names its reset in the message.
    const message = e.error_details ?? e.last_assistant_message ?? ''
    const resets = [resetOf(rateLimits), resetFromMessage(message, now)].filter((ms): ms is number => ms !== null)
    note($, `rate limited, windows ${JSON.stringify(rateLimits)}, message ${JSON.stringify(message)}`)
    if (resets.length) {
      misses = 0
      await arm($, Math.max(...resets, now) + BUFFER_MS)
    } else {
      await arm($, now + backoff(misses++))
    }

    return result
  }).catch(($, e, next) => next(e))

  // The person picked the session back up themselves.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      // Their own prompt starts any later limit over at the shortest wait.
      misses = 0
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
      misses = 0
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

/** How long to wait after `misses` fallback retries in a row: 5m, 10m, 20m, 40m, then an hour each. */
export function backoff(misses: number) {
  return Math.min(FALLBACK_MS * 2 ** misses, FALLBACK_CAP_MS)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// `You've hit your <any> limit · resets 4pm (Asia/Singapore)`, or `resets Nov 25 at 4:30pm (…)`.
const RESETS = /resets (?:([A-Z][a-z]{2}) (\d{1,2}) at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm) \(([^)]+)\)/i

/**
 * When the limit in a rate-limit message resets, in ms since the epoch, read from its wall-clock time
 * in the named zone; null when the message names none. A time without a date is its next occurrence.
 */
export function resetFromMessage(message: string, now: number): number | null {
  const match = RESETS.exec(message)
  if (!match) return null
  const [, mon, day, hour, minute, half, zone] = match
  const month = mon === undefined ? -1 : MONTHS.findIndex(m => m.toLowerCase() === mon.toLowerCase())
  if (mon !== undefined && month < 0) return null
  const h = (Number(hour) % 12) + (half!.toLowerCase() === 'pm' ? 12 : 0)
  const m = Number(minute ?? 0)

  try {
    const today = wall(zone!, now)
    // The first instant still ahead, else the last: a time the clocks repeat has two.
    const pick = (year: number, month: number, day: number) => {
      const ats = fromWall(zone!, year, month, day, h, m)
      return ats.find(at => at > now) ?? ats.at(-1)!
    }
    if (mon === undefined) {
      const at = pick(today.year, today.month, today.day)
      return at > now ? at : pick(today.year, today.month, today.day + 1)
    }
    const at = pick(today.year, month, Number(day))
    // A date well behind now is next year's, as in a December message naming January.
    return at < now - 86_400_000 ? pick(today.year + 1, month, Number(day)) : at
  } catch {
    // An unknown time zone.
    return null
  }
}

/** The wall-clock date and time in `zone` at `ms`, month from 0. */
function wall(zone: string, ms: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(ms))
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value)

  return { year: get('year'), month: get('month') - 1, day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') }
}

/**
 * The instants a wall-clock time in `zone` names, earliest first: two in the hour the clocks repeat,
 * and in the hour they skip, the time read with the offset before the change. Day and month may
 * overflow, as with `Date.UTC`.
 */
function fromWall(zone: string, year: number, month: number, day: number, hour: number, minute: number) {
  const guess = Date.UTC(year, month, day, hour, minute)
  const offset = (ms: number) => {
    const w = wall(zone, ms)
    return Date.UTC(w.year, w.month, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000
  }
  // A day either side lies beyond any clock change near the time.
  const before = guess - offset(guess - 86_400_000)
  const after = guess - offset(guess + 86_400_000)
  const names = (at: number) => {
    const w = wall(zone, at)
    return w.hour === hour && w.minute === minute
  }
  const ats = [...new Set([before, after])].filter(names).sort((a, b) => a - b)

  return ats.length ? ats : [before]
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
