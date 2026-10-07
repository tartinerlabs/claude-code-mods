import { describe, expect, test as it } from 'claude-code/testing'

describe('token-weather', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    it(`should follow the context window in the band on ${surface}`, async ($, on) => {
      // Hooks registered here sit beneath the mod and stand in for Claude Code.
      let tokens: number | undefined = 36_100
      on('session.start', ($, e) => ({ cwd: e.cwd }))
      on('session.usage', () => ({
        value: {
          startedAt: 0,
          rateLimits: [],
          context: {
            tokens,
            window: 200_000,
            percent: tokens === undefined ? undefined : Math.round(tokens / 2_000),
          },
        },
      }))
      on('turn.complete', () => ({ text: '' }))
      // The engine's own band: empty.
      on('ui.render', ($, e) => $.ui.resolve(e).Box({}))

      await $.session.start({ surface, isInteractive: true, cwd: '/work' })
      const ui = await $.ui.mount({
        plugin: 'token-weather',
        surface,
        component: 'AbovePrompt',
        props: {
          hasSurvey: false,
          isWorking: false,
          maxRows: 10,
          bodyColumns: 120,
          scroll: { offset: 0, bodyRows: 10 },
          view: {},
        },
      })
      expect(await ui.find({ type: 'Text', text: /Clear/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /18% of context/ })).toBeDefined()

      tokens = 134_400
      await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })
      expect(await ui.find({ type: 'Text', text: /Showers/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /67% of context/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /134\.4k \/ 200k/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /▲ \+98\.3k last turn/ })).toBeDefined()

      // A subagent's turn takes no reading.
      tokens = 190_000
      await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'sub' })
      expect(await ui.find({ type: 'Text', text: /Showers/ })).toBeDefined()

      await ui.unmount()
    })
  }

  it('should drop the history, then the token counts, as the band narrows', async ($, on) => {
    let tokens = 36_100
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.usage', () => ({
      value: { startedAt: 0, rateLimits: [], context: { tokens, window: 200_000, percent: Math.round(tokens / 2_000) } },
    }))
    on('turn.complete', () => ({ text: '' }))
    on('ui.render', ($, e) => $.ui.resolve(e).Box({}))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    tokens = 134_400
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })

    const band = { hasSurvey: false, isWorking: false, maxRows: 10, scroll: { offset: 0, bodyRows: 10 }, view: {} }
    const medium = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'AbovePrompt', props: { ...band, bodyColumns: 60 } })
    expect(await medium.find({ type: 'Text', text: /134\.4k \/ 200k/ })).toBeDefined()
    expect(await medium.find({ type: 'Text', text: /last turn/ })).toBeUndefined()
    await medium.unmount()

    const narrow = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'AbovePrompt', props: { ...band, bodyColumns: 30 } })
    expect(await narrow.find({ type: 'Text', text: /67% of context/ })).toBeDefined()
    expect(await narrow.find({ type: 'Text', text: /200k/ })).toBeUndefined()
    await narrow.unmount()
  })
})
