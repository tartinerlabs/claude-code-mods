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
    const isWide = e.props.bodyColumns >= 60

    return (
      <Box flexDirection="row" paddingX={1}>
        <Text color={f.color} bold>
          {`${f.icon}  ${f.word}`}
        </Text>
        <Text>{`  ${now.percent}% of context`}</Text>
        <Text dimColor>{`  ${short(now.tokens)} / ${short(now.window)}`}</Text>
        {isWide && <Text dimColor>{'   last turns '}</Text>}
        {isWide && <Text color={f.color}>{sparkline(history)}</Text>}
        {isWide && prev && <Text dimColor>{trend(now.tokens - prev.tokens)}</Text>}
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
