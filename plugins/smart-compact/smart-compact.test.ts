import { describe, expect, mock, test as it } from 'claude-code/testing'

import { areAllDone, bashCheckpoint, digestText, parseVerdict, shouldAsk } from './hooks/register'

const USAGE = { input_tokens: 900, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

describe('smart-compact', () => {
  it('should ask the decider only past the floor and once the context has grown 20 points since the last compaction', () => {
    expect(shouldAsk({ percent: 35, floor: 40, baseline: 0 })).toBe(false)
    expect(shouldAsk({ percent: 42, floor: 40, baseline: 0 })).toBe(true)
    expect(shouldAsk({ percent: 35, floor: 40, fiveHourPercent: 85, baseline: 0 })).toBe(true)
    // A large summary left 35%: 50% is past the floor but only 15 points of new work.
    expect(shouldAsk({ percent: 50, floor: 40, baseline: 35 })).toBe(false)
    expect(shouldAsk({ percent: 55, floor: 40, baseline: 35 })).toBe(true)
    // Compacted, with no reading since: nothing to measure growth from yet.
    expect(shouldAsk({ percent: 90, floor: 40, baseline: null })).toBe(false)
  })

  it('should read a verdict and its reason, and nothing from a stray reply', () => {
    expect(parseVerdict('compact: commit finished the fix')).toEqual({ compact: true, reason: 'commit finished the fix' })
    expect(parseVerdict('**Wait** - tests still failing')).toEqual({ compact: false, reason: 'tests still failing' })
    expect(parseVerdict('compact')).toEqual({ compact: true, reason: 'compact' })
    expect(parseVerdict('I think it depends.')).toBeNull()
    // Seen from Haiku: both verdicts in one line is no answer, never a compaction.
    expect(parseVerdict('compact: wait: test still failing, cache investigation open')).toBeNull()
  })

  it('should hand the decider the turn, its tools and the checkpoint seen', () => {
    const text = digestText({
      prompt: 'Fix the login bug',
      answer: 'Fixed and committed.',
      tools: ['Edit: /work/login.ts', 'Bash: git commit -m "fix: login"'],
      percent: 52,
      checkpoint: 'commit',
      openCount: 0,
    })
    expect(text).toContain('Context: 52% full')
    expect(text).toContain('Checkpoint seen: committed')
    expect(text).toContain('- Bash: git commit -m "fix: login"')
    expect(text).toContain('Fixed and committed.')
  })

  it('should read commits, PRs and branch switches off a Bash command', () => {
    expect(bashCheckpoint('git add -A && git commit -m "feat: x"')).toBe('commit')
    expect(bashCheckpoint('git -C repo commit --amend')).toBe('commit')
    expect(bashCheckpoint('gh pr create --fill')).toBe('pr')
    expect(bashCheckpoint('gh stack submit')).toBe('pr')
    expect(bashCheckpoint('gh pr merge 42 --squash')).toBe('merge')
    expect(bashCheckpoint('git switch -c feat/next')).toBe('switch')
    expect(bashCheckpoint('git checkout main')).toBe('switch')
    expect(bashCheckpoint('git checkout -- src/a.ts')).toBeNull()
    expect(bashCheckpoint('git checkout .')).toBeNull()
    expect(bashCheckpoint('git log --oneline')).toBeNull()
  })

  it('should call a todo list done only when it has items and all are completed', () => {
    expect(areAllDone([])).toBe(false)
    expect(areAllDone([{ status: 'completed' }, { status: 'in_progress' }])).toBe(false)
    expect(areAllDone([{ status: 'completed' }, { status: 'completed' }])).toBe(true)
  })

  it('should compact when Haiku calls a break, ask once per idle stretch, and wait for the context to grow again', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    let percent: number | undefined = 52
    let typed = ''
    let verdict = 'wait: still debugging'
    const asked: { model: string; prompt: string }[] = []
    const instructions: (string | undefined)[] = []
    const toasts: string[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent }, rateLimits: [] } }))
    on('session.compact', ($, e) => {
      instructions.push(e.instructions)
      percent = undefined

      return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }
    })
    on('model.complete', ($, e) => {
      asked.push({ model: e.model, prompt: String(e.prompt) })

      return { value: { isAnswered: true as const, text: verdict, usage: USAGE } }
    })
    on('prompt.read', () => ({ value: { text: typed, cursor: typed.length } }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: 'ok' }))
    on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
    const run = async (turnId: string, command?: string, fill = 52) => {
      percent = fill
      await $.turn.start({ text: 'fix the login bug', turnId })
      if (command) {
        await $.tool.call({ tool: 'Bash', command, description: 'Run' })
      }
      await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId, reason: 'end_turn' })
    }

    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })

    // Haiku says wait: no compaction, and no second call while the session idles.
    await run('t1', 'pnpm test')
    await clock.advance(5 * 60_000)
    expect(asked).toHaveLength(1)
    expect(asked[0].model).toBe('haiku')
    expect(instructions).toEqual([])

    // A follow-up half typed: Haiku is not asked until the box is clear.
    verdict = 'compact: login fix committed'
    await run('t2', 'git commit -m "fix: login"')
    typed = 'now the'
    await clock.advance(30_000)
    expect(asked).toHaveLength(1)

    typed = ''
    await clock.advance(15_000)
    expect(asked).toHaveLength(2)
    expect(asked[1].prompt).toContain('Checkpoint seen: committed')
    expect(instructions).toHaveLength(1)
    expect(instructions[0]).toMatch(/just committed/)
    expect(toasts).toEqual(['Compacted at 52%: login fix committed'])

    // The first turn after compacting reads 52%: no growth past that yet, so no call.
    await run('t3', 'git commit -m "fix: logout"')
    await clock.advance(60_000)
    expect(asked).toHaveLength(2)

    // One heavy turn later it has grown 25 points: worth asking again, however soon.
    await run('t4', 'git commit -m "fix: signup"', 77)
    await clock.advance(30_000)
    expect(asked).toHaveLength(3)
    expect(instructions).toHaveLength(2)
  })

  it('should measure growth from Claude Code\'s own compaction too', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const asked: string[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: 60 }, rateLimits: [] } }))
    on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }))
    on('model.complete', ($, e) => (asked.push(e.model), { value: { isAnswered: true as const, text: 'wait: midway', usage: USAGE } }))
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: 'ok' }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'earlier work', toolUses: [] }] })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn' })
    await clock.advance(60_000)
    expect(asked).toEqual([])
  })

  it('should continue after compacting only while todos are open and the turn ended on its own', { options: { continue: 'tasks', decider: 'sonnet' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    let percent: number | undefined = 75
    const sent: string[] = []
    const toasts: string[] = []
    const models: string[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent }, rateLimits: [] } }))
    on('session.compact', () => {
      // What the summary leaves, read at the next turn's end.
      percent = 10

      return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }
    })
    on('model.complete', ($, e) => (models.push(e.model), { value: { isAnswered: true as const, text: 'compact: part a done', usage: USAGE } }))
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
    on('tool.call', { tool: 'TodoWrite' }, () => ({ result: {}, text: 'ok' }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: 'ok' }))
    on('prompt.submit', ($, e) => (sent.push(e.text), e))
    on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
    const run = async (turnId: string, answer: string, isAborted = false) => {
      await $.turn.start({ text: 'go', turnId })
      await $.tool.call({
        tool: 'TodoWrite',
        todos: [
          { content: 'a', status: 'completed', activeForm: 'Doing a' },
          { content: 'b', status: 'pending', activeForm: 'Doing b' },
        ],
      })
      await $.turn.complete({ answer, durationMs: 1, isAborted, turnId, reason: 'end_turn' })
      // Grown well past the summary each time, so every run reaches the decider.
      percent = 75
      await clock.advance(30_000)
    }

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    await run('t1', 'Which database should I use?')
    await run('t2', 'Stopped.', true)
    expect(sent).toEqual([])

    await run('t3', 'Done with a, moving on.')
    expect(sent).toEqual(['Continue with the remaining tasks.'])
    expect(toasts.at(-1)).toBe('Compacted at 75%: part a done; continuing')
    expect(models.every(model => model === 'sonnet')).toBe(true)
  })
})
