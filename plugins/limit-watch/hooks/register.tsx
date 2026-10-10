import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Limit, Warned } from '../types'

const LEVELS = [95, 80]
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const ICONS: Record<string, string> = { five_hour: '🕔', seven_day: '📅', spend_limit: '💳' }

// Held by the host, so a hot reload keeps the band and does not toast the same threshold twice.
const limits = atom({ plugin: 'limit-watch', key: 'limits' } as const, [] as Limit[])
const warned = atom({ plugin: 'limit-watch', key: 'warned' } as const, {} as Warned)

async function refresh($: EngineInterface, latest: readonly SessionRateLimit[]) {
  await update($, limits, () => [...latest])

  const now = await $.clock.now()
  const seen = await read($, warned)
  for (const limit of latest) {
    const level = LEVELS.find(l => limit.percentUsed >= l)
    const resetsAt = limit.resetsAt ?? ''
    const last = seen[limit.kind]
    if (level === undefined || (last?.resetsAt === resetsAt && last.level >= level)) continue

    const reset = limit.resetsAt ? `, resets in ${span(Date.parse(limit.resetsAt) - now)}` : ''
    $.ui.toast(`${label(limit.kind)} limit at ${limit.percentUsed}%${reset}`, { timeoutMs: 8000 })
    await update($, warned, w => ({ ...w, [limit.kind]: { resetsAt, level } }))
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($, (await $.session.usage()).rateLimits)
    // Redraw each minute so the countdowns tick between measurements.
    $.clock.every(60_000, () => $.ui.invalidate('ui.render'))

    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await refresh($, e.rateLimits)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const latest = await read($, limits)

    if (e.props.hasSurvey || latest.length === 0) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    // Drop the reset countdowns when the full row would not fit the band.
    const width = latest.reduce((n, l) => n + heading(l.kind).length + 1 + entry(l, now).length, 0) + 2 * (latest.length - 1)
    const isWide = width <= e.props.bodyColumns - 2
    // Stack above whatever the plugins beneath draw, so other bands stay.
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" paddingX={1} gap={2}>
          {latest.map(limit => (
            <Text key={limit.kind} wrap="truncate-end">
              <Text dimColor>{heading(limit.kind)} </Text>
              <Text color={colour(limit.percentUsed)}>{isWide ? entry(limit, now) : `${limit.percentUsed}%`}</Text>
            </Text>
          ))}
        </Box>
        {below}
      </Box>
    )
  })
}

/** Green under 60%, yellow to 80%, red past it, as the status line colours them. */
export function colour(percent: number) {
  return percent >= 80 ? 'red' : percent >= 60 ? 'yellow' : 'green'
}

export function entry(limit: SessionRateLimit, now: number) {
  const reset = limit.resetsAt ? ` · ${span(Date.parse(limit.resetsAt) - now)}` : ''

  return `${limit.percentUsed}%${reset}`
}

function label(kind: string) {
  return LABELS[kind] ?? kind
}

/** The band's label, its emoji first. Each emoji is two UTF-16 units and two columns, so `.length` still measures it. */
function heading(kind: string) {
  return ICONS[kind] ? `${ICONS[kind]} ${label(kind)}` : label(kind)
}

export function span(ms: number) {
  const m = Math.max(0, Math.ceil(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m % 60}m`

  return `${m}m`
}
