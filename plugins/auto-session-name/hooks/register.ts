import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Naming } from '../types'

const PROMPT = `Write a 3-5 word title for a coding session from the requests below, oldest first. Title what the session is about now. Reply with the title only: no quotes, no trailing punctuation.

{requests}`

// A first prompt shorter than this ("continue", "look at this") is too thin to title from alone.
const THIN = 40
// The prompt that re-titles a session whose first prompt was thin.
const RETITLE_AT = 4
const MAX_PROMPT = 800

// Held by the host, so a hot reload doesn't re-title a finished session.
const naming = atom(
  { plugin: 'auto-session-name', key: 'naming' } as const,
  { turns: 0, prompts: [], title: null, isDone: false } as Naming,
)

export const register: Register = (on, options) => {
  // `default` leaves the prompt bar colour alone.
  const color = typeof options.color === 'string' && options.color !== 'default' ? options.color : undefined
  // /color can't run while the turn waits on UserPromptSubmit, so it waits for turn.complete.
  let colorPending = false
  // A /color from the person or another plugin wins over the configured one.
  let colorChosen = false

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    if (e.source !== undefined && e.source !== 'user') return result
    const prompt = e.prompt.trim()
    if (!prompt || prompt.startsWith('/')) return result
    const state = await read($, naming)
    if (state.isDone) return result
    // Stop for good once -n, /rename or another hook names the session.
    if (result.sessionTitle || (e.session_title && e.session_title !== state.title)) {
      await update($, naming, s => ({ ...s, isDone: true }))
      return result
    }

    const turns = state.turns + 1
    const prompts = [...state.prompts, prompt.slice(0, MAX_PROMPT)].slice(-RETITLE_AT)
    const isFirst = turns === 1
    const isDone = turns >= RETITLE_AT || (isFirst && prompt.length >= THIN)
    await update($, naming, s => ({ ...s, turns, prompts, isDone }))
    if (!isFirst && turns !== RETITLE_AT) return result

    const reply = await $.model.complete({
      model: 'haiku',
      prompt: PROMPT.replace('{requests}', prompts.map(p => `<request>\n${p}\n</request>`).join('\n\n')),
      maxTokens: 30,
      timeoutMs: 5000,
    })
    if (!reply.isAnswered) return result
    const title = (reply.text.split('\n')[0] ?? '').replace(/^["'`]+|["'`.]+$/g, '').trim().slice(0, 60)
    if (!title || title === state.title) return result
    await update($, naming, s => ({ ...s, title }))
    // Colour only when the session is first named, not on a re-title.
    if (state.title === null) colorPending = color !== undefined && !colorChosen
    return { ...result, sessionTitle: title }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'color' }, ($, e, next) => {
    if (e.origin.kind !== 'plugin' || e.origin.name !== 'auto-session-name') {
      colorChosen = true
      colorPending = false
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!colorPending || e.agentId !== undefined) return result
    colorPending = false
    $.command.run({ command: 'color', args: color }).catch(() => {})
    return result
  })
}
