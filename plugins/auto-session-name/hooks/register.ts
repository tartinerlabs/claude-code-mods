import type { Register } from 'claude-code'

const PROMPT = `Write a 3-5 word title for a coding session that starts with the request below. Reply with the title only: no quotes, no trailing punctuation.

<request>
{prompt}
</request>`

export const register: Register = (on) => {
  // /color can't run while the turn waits on UserPromptSubmit, so it waits for turn.complete.
  let colorPending = false

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    // Leave sessions named by -n, /rename or another hook, and machine-sent turns.
    if (e.session_title || result.sessionTitle) return result
    if (e.source !== undefined && e.source !== 'user') return result
    const prompt = e.prompt.trim()
    if (!prompt || prompt.startsWith('/')) return result

    const reply = await $.model.complete({
      model: 'haiku',
      prompt: PROMPT.replace('{prompt}', prompt.slice(0, 2000)),
      maxTokens: 30,
      timeoutMs: 5000,
    })
    if (!reply.isAnswered) return result
    const title = (reply.text.split('\n')[0] ?? '').replace(/^["'`]+|["'`.]+$/g, '').trim().slice(0, 60)
    if (!title) return result
    colorPending = true
    return { ...result, sessionTitle: title }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!colorPending || e.agentId !== undefined) return result
    colorPending = false
    // Bare /color picks a random prompt bar colour for the session.
    $.command.run({ command: 'color' }).catch(() => {})
    return result
  })
}
