import { describe, expect, mock, test as it } from 'claude-code/testing'
import { checksEntry, tally } from './hooks/register'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const run = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const view = (rollup: object[], extra: object = {}) =>
  JSON.stringify({
    number: 42,
    url: 'https://github.com/o/r/pull/42',
    headRefOid: 'abc123',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: rollup,
    ...extra,
  })

const GREEN = [
  { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'StatusContext', context: 'Vercel', state: 'SUCCESS' },
]
const PENDING = [{ __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS' }, GREEN[1]!]

describe('tally', () => {
  it('should count check runs and commit statuses alike', () => {
    expect(
      tally([
        ...GREEN,
        { __typename: 'CheckRun', name: 'lint', status: 'QUEUED' },
        { __typename: 'CheckRun', name: 'SonarCloud', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
      ]),
    ).toEqual({ total: 5, passed: 3, pending: 1, failed: ['SonarCloud'] })
  })

  it('should strip terminal escapes from check names', () => {
    const rollup = [{ __typename: 'CheckRun', name: 'e2e\u001b]52;c;aGk=\u0007\u001b[2J', status: 'COMPLETED', conclusion: 'FAILURE' }]
    expect(tally(rollup).failed).toEqual(['e2e]52;c;aGk=[2J'])
  })

  it('should name failing checks first', () => {
    expect(checksEntry({ total: 3, passed: 1, pending: 1, failed: ['e2e'] })).toEqual(['✗ 1 failing: e2e', 'red'])
    expect(checksEntry({ total: 3, passed: 2, pending: 1, failed: [] })).toEqual(['◐ 2/3 checks', 'yellow'])
  })
})

describe('pr-pilot', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    it(`should draw the pull request and toast once its checks pass on ${surface}`, async ($, on) => {
      const clock = mock.clock(on, { now: 0 })
      const toasts: string[] = []
      let rollup = PENDING
      on('session.start', ($, e) => ({ cwd: e.cwd }))
      on('command.register', () => ({ value: { command: 'merge' } }))
      on('process.run', () => run(view(rollup)))
      on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
      on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'beneath' }))

      await $.session.start({ surface, isInteractive: true, cwd: '/work' })
      const ui = await $.ui.mount({ plugin: 'pr-pilot', surface, component: 'AbovePrompt', props: BAND })
      expect(await ui.find({ type: 'Text', text: '◐ 1/2 checks', props: { color: 'yellow' } })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeDefined()

      rollup = GREEN
      await clock.advance(60_000)
      expect(await ui.find({ type: 'Text', text: '✓ 2/2 checks', props: { color: 'green' } })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'ready · /merge' })).toBeDefined()
      expect(toasts).toEqual(['PR #42 checks passed, ready to /merge'])

      await clock.advance(60_000)
      expect(toasts).toHaveLength(1)
      await ui.unmount()
    })
  }

  it('should draw nothing without an open pull request', async ($, on) => {
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: { command: 'merge' } }))
    on('process.run', () => run('', 1))
    on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'beneath' }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ plugin: 'pr-pilot', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'PR #42' })).toBeUndefined()
  })

  it('should merge with the configured method only once ready', { options: { method: 'squash' } }, async ($, on) => {
    const ran: string[] = []
    let rollup = PENDING
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: { command: 'merge' } }))
    on('process.run', ($, e) => (ran.push(e.argv.join(' ')), run(e.argv[0] === 'git' ? 'abc123\n' : e.argv[2] === 'merge' ? '' : view(rollup))))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const early = await $.command.run({ command: 'merge', args: '' })
    expect(early.text).toBe('PR #42 is not ready to merge: ◐ 1/2 checks, waiting.')
    expect(ran.some(c => c.startsWith('gh pr merge'))).toBe(false)

    rollup = GREEN
    const merged = await $.command.run({ command: 'merge', args: '' })
    expect(merged.text).toBe('Merged PR #42.')
    expect(ran).toContain('gh pr merge 42 --squash --delete-branch --match-head-commit abc123')
  })

  it('should not merge while the local branch is ahead of the pull request', async ($, on) => {
    const ran: string[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: { command: 'merge' } }))
    on('process.run', ($, e) => (ran.push(e.argv.join(' ')), run(e.argv[0] === 'git' ? 'def456\n' : view(GREEN))))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const refused = await $.command.run({ command: 'merge', args: '' })
    expect(refused.text).toBe("This branch is not at PR #42's head: push or pull first.")
    expect(ran.some(c => c.startsWith('gh pr merge'))).toBe(false)
  })
})
