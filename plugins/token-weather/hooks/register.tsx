import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TokenWeatherReading } from '../types'

const HISTORY = 12
const BARS = '▁▂▃▄▅▆▇█'
const FORECAST = [
  { upTo: 25, icon: '☀', word: 'Clear', color: 'yellow' },
  { upTo: 50, icon: '☁', word: 'Cloudy', color: 'cyan' },
  { upTo: 75, icon: '☂', word: 'Showers', color: 'blue' },
  { upTo: 90, icon: '☇', word: 'Storm', color: 'magenta' },
  { upTo: Infinity, icon: '↯', word: 'Compact soon', color: 'red' },
] as const

// Held by the host, so the history survives a hot reload of this file.
const readings = atom({ plugin: 'token-weather', key: 'readings' } as const, [])

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await takeReading($)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // Main-loop turns only, not subagents.
    if (!e.agentId) {
      await takeReading($)
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const history = await read($, readings)
    const now = history.at(-1)

    if (e.props.hasSurvey || now === undefined) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const prev = history.at(-2)
    const f = FORECAST.find(b => now.percent < b.upTo) ?? FORECAST[4]
    const head = `${f.icon}  ${f.word}`
    const percent = `  ${now.percent}% of context`
    const size = `  ${short(now.tokens)} / ${short(now.window)}`
    const spark = sparkline(history)
    const change = prev ? trend(now.tokens - prev.tokens) : ''
    // Add the history only when the whole row fits the band, so it does not wrap.
    const room = e.props.bodyColumns - 2
    const isWide = (head + percent + size + '   last turns ' + spark + change).length <= room
    const hasSize = (head + percent + size).length <= room
    // Stack above whatever the plugins beneath draw, so other bands stay.
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" paddingX={1}>
          <Text color={f.color} bold>
            {head}
          </Text>
          <Text wrap="truncate-end">{percent}</Text>
          {hasSize && <Text dimColor>{size}</Text>}
          {isWide && <Text dimColor>{'   last turns '}</Text>}
          {isWide && <Text color={f.color}>{spark}</Text>}
          {isWide && prev && <Text dimColor>{change}</Text>}
        </Box>
        {below}
      </Box>
    )
  })
}

async function takeReading($: EngineInterface) {
  const { context } = await $.session.usage()

  if (!context?.window || context.tokens === undefined) {
    return
  }

  const reading: TokenWeatherReading = {
    tokens: context.tokens,
    window: context.window,
    percent: context.percent ?? Math.round((context.tokens / context.window) * 100),
  }
  await update($, readings, history => [...(history ?? []), reading].slice(-HISTORY))
}

function sparkline(history: readonly TokenWeatherReading[]) {
  const top = Math.max(...history.map(r => r.tokens), 1)

  return history.map(r => BARS[Math.floor((r.tokens / top) * (BARS.length - 1))]).join('')
}

function trend(delta: number) {
  if (delta === 0) {
    return '  steady'
  }

  return delta > 0 ? `  ▲ +${short(delta)} last turn` : `  ▼ ${short(-delta)} last turn`
}

function short(n: number) {
  if (n >= 1_000_000) {
    return `${+(n / 1_000_000).toFixed(1)}M`
  }

  if (n >= 1_000) {
    return `${+(n / 1_000).toFixed(1)}k`
  }

  return String(n)
}
