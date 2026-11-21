import { describe, expect, mock, test as it } from 'claude-code/testing'

import { failureNote, parseStatuses, projectOf } from './hooks/register'

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const SHA = 'abc1234def5678'
const INSPECT = 'https://vercel.com/acme/web/AbCd123'

const run = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const status = (state: string, context = 'Vercel', url = INSPECT, description = '') => ({ context, state, description, target_url: url })

/** Stands in for git and gh: a pushed main with no pull request, whose statuses the test sets. */
function host(on: Parameters<Parameters<typeof it>[1]>[1], repo: { statuses: unknown[]; pr?: string; upstream?: string }) {
  const ran: string[] = []
  on('process.run', ($, e) => {
    const cmd = e.argv.join(' ')
    ran.push(cmd)
    if (cmd === 'git rev-parse HEAD') return run(SHA)
    if (cmd === 'git rev-parse @{u}') return run(repo.upstream ?? SHA)
    if (cmd === 'git rev-parse --abbrev-ref HEAD') return run('main')
    if (cmd.startsWith('gh pr view')) return repo.pr ? run(repo.pr) : run('', 1)
    if (cmd.startsWith('gh api')) return run(JSON.stringify(repo.statuses))

    return run('', 1)
  })

  return ran
}

describe('vercel-watch', () => {
  for (const surface of ['desktop', 'terminal'] as const) {
    it(`should follow a pushed commit's deployment and toast once it is ready on ${surface}`, async ($, on) => {
      const clock = mock.clock(on, { now: 0 })
      const repo = { statuses: [] as unknown[] }
      host(on, repo)
      const toasts: string[] = []
      on('session.start', ($, e) => ({ cwd: e.cwd }))
      on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
      on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'beneath' }))
      on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))

      await $.session.start({ surface, isInteractive: true, cwd: '/work' })
      await $.tool.call({ tool: 'Bash', command: 'git commit -m "x" && git push', description: 'Push' })
      await clock.advance(1)
      const ui = await $.ui.mount({ plugin: 'vercel-watch', surface, component: 'AbovePrompt', props: BAND })
      expect(await ui.find({ type: 'Text', text: 'waiting for Vercel' })).toBeDefined()
      await clock.advance(60_000)
      expect(await ui.find({ type: 'Text', text: '1m' })).toBeDefined()

      repo.statuses = [status('pending')]
      await clock.advance(15_000)
      expect(await ui.find({ type: 'Text', text: '⏳ web', props: { color: 'yellow' } })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeDefined()

      repo.statuses = [status('success'), status('pending')]
      await clock.advance(15_000)
      expect(toasts).toEqual(['▲ web deployed (main)'])
      expect(await ui.find({ type: 'Text', text: /web/ })).toBeUndefined()
      await ui.unmount()
    })
  }

  it('should tell Claude when a deployment fails', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const repo = { statuses: [status('pending')] as unknown[] }
    host(on, repo)
    const toasts: string[] = []
    const notes: string[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
    on('session.append', ($, e, next) => {
      notes.push(e.message.content.map(b => ('text' in b ? b.text : '')).join(''))
      return next(e)
    })
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))

    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Bash', command: 'git push', description: 'Push' })
    await clock.advance(1)
    repo.statuses = [status('failure', 'Vercel', INSPECT, 'Deployment has failed')]
    await clock.advance(15_000)
    expect(toasts).toEqual(['▲ web deploy failed (main)'])
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('web for commit abc1234 on main failed: Deployment has failed')
    expect(notes[0]).toContain('dpl_AbCd123')
  })

  it('should leave a branch with an open pull request to the app', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const ran = host(on, { statuses: [status('pending')], pr: 'OPEN' })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))

    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Bash', command: 'git push', description: 'Push' })
    await clock.advance(15_000)
    expect(ran.some(c => c.startsWith('gh api'))).toBe(false)
  })

  it('should not follow a push that did not reach the remote', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const ran = host(on, { statuses: [status('pending')], upstream: 'older' })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))

    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Bash', command: 'git push', description: 'Push' })
    await clock.advance(15_000)
    expect(ran.some(c => c.startsWith('gh api'))).toBe(false)
  })

  it('should stay quiet about a deployment already finished before the push', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    host(on, { statuses: [status('success')] })
    const toasts: string[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))

    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Bash', command: 'git push', description: 'Push' })
    await clock.advance(15_000)
    expect(toasts).toEqual([])
  })

  it('should give up quietly on a repository Vercel does not deploy', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const ran = host(on, { statuses: [] })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))

    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Bash', command: 'git push', description: 'Push' })
    await clock.advance(4 * 60_000)
    const polls = ran.filter(c => c.startsWith('gh api')).length
    await clock.advance(5 * 60_000)
    expect(ran.filter(c => c.startsWith('gh api')).length).toBe(polls)
  })

  it('should follow the default branch after a merge', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    let head = 'old1111 '
    const toasts: string[] = []
    on('process.run', ($, e) => {
      const cmd = e.argv.join(' ')
      if (cmd.startsWith('gh repo view')) return run(`main ${head.trim()}`)
      if (cmd.startsWith('gh api')) return run(JSON.stringify(cmd.includes('new2222') ? [status('pending')] : []))

      return run('', 1)
    })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
    on('tool.call', { tool: 'Bash' }, () => {
      head = 'new2222'
      return { result: { stdout: '', stderr: '', interrupted: false }, text: '' }
    })

    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Bash', command: 'gh pr merge 12 --merge -d', description: 'Merge' })
    await clock.advance(1)
    const ui = await $.ui.mount({ plugin: 'vercel-watch', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Text', text: '⏳ web' })).toBeDefined()
    await ui.unmount()
  })
})

describe('parseStatuses', () => {
  it('should keep the latest status of each Vercel project and drop other contexts', () => {
    const deploys = parseStatuses(
      JSON.stringify([
        status('success', 'Vercel – api', 'https://vercel.com/acme/api/X1'),
        status('failure', 'Vercel – web', 'https://vercel.com/acme/web/Y2', 'Deployment has failed'),
        status('pending', 'Vercel – api', 'https://vercel.com/acme/api/X1'),
        status('success', 'SonarCloud', 'https://sonarcloud.io'),
      ]),
    )
    expect(deploys.map(d => `${d.project}:${d.state}`)).toEqual(['api:success', 'web:failure'])
  })

  it('should name the project from the context when the URL does not', () => {
    expect(projectOf('Vercel – stockfind-web', '')).toBe('stockfind-web')
    expect(projectOf('Vercel', '')).toBe('Vercel')
  })

  it('should point Claude at the deployment without prescribing a fix', () => {
    const note = failureNote({ project: 'web', state: 'error', description: '', url: INSPECT }, SHA, 'main')
    expect(note).toContain('Inspector: https://vercel.com/acme/web/AbCd123 (deployment dpl_AbCd123).')
  })
})
