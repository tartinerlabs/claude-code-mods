import { describe, expect, test } from 'claude-code/testing'

const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

describe('auto-session-name', () => {
  test('names an unnamed session from its prompt', async ($, on) => {
    on('classic.UserPromptSubmit', () => ({}))
    on('model.complete', () => ({ value: { isAnswered: true, text: '"Fix login redirect bug."\n', usage } }))
    const result = await $.classic.UserPromptSubmit({ prompt: 'the login page redirects in a loop', source: 'user' })
    expect(result.sessionTitle).toBe('Fix login redirect bug')
  })

  test('colours the prompt bar once the named turn completes', { options: { color: 'cyan' } }, async ($, on) => {
    on('classic.UserPromptSubmit', () => ({}))
    on('model.complete', () => ({ value: { isAnswered: true, text: 'Fix login redirect bug', usage } }))
    on('turn.complete', () => ({ text: '' }))
    const ran: string[] = []
    on('command.run', (_, e) => { ran.push(`${e.command} ${e.args}`.trim()); return { text: '' } })
    await $.classic.UserPromptSubmit({ prompt: 'the login page redirects in a loop', source: 'user' })
    await $.turn.complete({ reason: 'answer', answer: 'done' })
    await $.turn.complete({ reason: 'answer', answer: 'done again' })
    expect(ran).toEqual(['color cyan'])
  })

  test('leaves the prompt bar colour alone by default', async ($, on) => {
    on('classic.UserPromptSubmit', () => ({}))
    on('model.complete', () => ({ value: { isAnswered: true, text: 'Fix login redirect bug', usage } }))
    on('turn.complete', () => ({ text: '' }))
    const ran: string[] = []
    on('command.run', (_, e) => { ran.push(`${e.command} ${e.args}`.trim()); return { text: '' } })
    await $.classic.UserPromptSubmit({ prompt: 'the login page redirects in a loop', source: 'user' })
    await $.turn.complete({ reason: 'answer', answer: 'done' })
    expect(ran).toEqual([])
  })

  test('leaves a named session alone', async ($, on) => {
    on('classic.UserPromptSubmit', () => ({}))
    let asked = false
    on('model.complete', () => { asked = true; return { value: { isAnswered: true, text: 'Other', usage } } })
    const result = await $.classic.UserPromptSubmit({ prompt: 'carry on', session_title: 'My session' })
    expect(result.sessionTitle).toBeUndefined()
    expect(asked).toBe(false)
  })

  test('skips machine-sent turns and slash commands', async ($, on) => {
    on('classic.UserPromptSubmit', () => ({}))
    let asked = false
    on('model.complete', () => { asked = true; return { value: { isAnswered: true, text: 'Other', usage } } })
    await $.classic.UserPromptSubmit({ prompt: 'task finished', source: 'system' })
    await $.classic.UserPromptSubmit({ prompt: '/clear' })
    expect(asked).toBe(false)
  })

  test('passes the prompt through unnamed when the model fails', async ($, on) => {
    on('classic.UserPromptSubmit', () => ({}))
    on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage } }))
    const result = await $.classic.UserPromptSubmit({ prompt: 'add a test' })
    expect(result.sessionTitle).toBeUndefined()
  })
})
