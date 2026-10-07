import { describe, expect, test as it } from 'claude-code/testing'

const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

describe('auto-session-name', () => {
  it('should name an unnamed session from its prompt', async ($, on) => {
    on('classic.UserPromptSubmit', () => ({}))
    on('model.complete', () => ({ value: { isAnswered: true, text: '"Fix login redirect bug."\n', usage } }))
    const result = await $.classic.UserPromptSubmit({ prompt: 'the login page redirects in a loop', source: 'user' })
    expect(result.sessionTitle).toBe('Fix login redirect bug')
  })

  it('should colour the prompt bar once the named turn completes', { options: { color: 'cyan' } }, async ($, on) => {
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

  it('should keep a colour already set with /color', { options: { color: 'cyan' } }, async ($, on) => {
    on('classic.UserPromptSubmit', () => ({}))
    on('model.complete', () => ({ value: { isAnswered: true, text: 'Fix login redirect bug', usage } }))
    on('turn.complete', () => ({ text: '' }))
    const ran: string[] = []
    on('command.run', (_, e) => { ran.push(`${e.command} ${e.args}`.trim()); return { text: '' } })
    await $.command.run({ command: 'color', args: 'red', origin: { kind: 'composer' } })
    await $.classic.UserPromptSubmit({ prompt: 'the login page redirects in a loop', source: 'user' })
    await $.turn.complete({ reason: 'answer', answer: 'done' })
    expect(ran).toEqual(['color red'])
  })

  it('should leave the prompt bar colour alone by default', async ($, on) => {
    on('classic.UserPromptSubmit', () => ({}))
    on('model.complete', () => ({ value: { isAnswered: true, text: 'Fix login redirect bug', usage } }))
    on('turn.complete', () => ({ text: '' }))
    const ran: string[] = []
    on('command.run', (_, e) => { ran.push(`${e.command} ${e.args}`.trim()); return { text: '' } })
    await $.classic.UserPromptSubmit({ prompt: 'the login page redirects in a loop', source: 'user' })
    await $.turn.complete({ reason: 'answer', answer: 'done' })
    expect(ran).toEqual([])
  })

  it('should leave a named session alone', async ($, on) => {
    on('classic.UserPromptSubmit', () => ({}))
    let asked = false
    on('model.complete', () => { asked = true; return { value: { isAnswered: true, text: 'Other', usage } } })
    const result = await $.classic.UserPromptSubmit({ prompt: 'carry on', session_title: 'My session' })
    expect(result.sessionTitle).toBeUndefined()
    expect(asked).toBe(false)
  })

  it('should skip machine-sent turns and slash commands', async ($, on) => {
    on('classic.UserPromptSubmit', () => ({}))
    let asked = false
    on('model.complete', () => { asked = true; return { value: { isAnswered: true, text: 'Other', usage } } })
    await $.classic.UserPromptSubmit({ prompt: 'task finished', source: 'system' })
    await $.classic.UserPromptSubmit({ prompt: '/clear' })
    expect(asked).toBe(false)
  })

  it('should pass the prompt through unnamed when the model fails', async ($, on) => {
    on('classic.UserPromptSubmit', () => ({}))
    on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage } }))
    const result = await $.classic.UserPromptSubmit({ prompt: 'add a test' })
    expect(result.sessionTitle).toBeUndefined()
  })
})
