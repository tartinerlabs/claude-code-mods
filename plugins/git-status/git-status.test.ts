import { describe, expect, mock, test as it } from 'claude-code/testing'
import { format, parse } from './hooks/register'

const run = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const DIRTY = [
  '# branch.oid 1234567890abcdef',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -1',
  '1 M. N... 100644 100644 100644 aaa bbb staged.ts',
  '1 .M N... 100644 100644 100644 aaa bbb modified.ts',
  '1 MM N... 100644 100644 100644 aaa bbb both.ts',
  '2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\told.ts',
  '? notes.md',
  '? scratch.ts',
  '',
].join('\n')

const CONFLICTED = [
  '# branch.oid 1234567890abcdef',
  '# branch.head (detached)',
  'u UU N... 100644 100644 100644 100644 aaa bbb ccc clash.ts',
  '',
].join('\n')

describe('parse', () => {
  it('should count ahead, behind, staged, modified and untracked', () => {
    expect(parse(DIRTY)).toEqual({ branch: 'main', ahead: 2, behind: 1, staged: 3, modified: 2, untracked: 2, conflicts: 0 })
  })

  it('should show a detached HEAD as its short commit and count conflicts', () => {
    expect(parse(CONFLICTED)).toMatchObject({ branch: '1234567', conflicts: 1 })
  })
})

describe('format', () => {
  it('should tick a clean branch', () => {
    expect(format(parse('# branch.head main\n'))).toBe('🌿 main ✓')
  })

  it('should list only the counts that are not zero', () => {
    expect(format(parse(DIRTY), 1, 'REBASING')).toBe('🌿 main ↑2 ↓1 +3 !2 ?2 ⚑1 REBASING')
  })
})

describe('git-status', () => {
  it('should pin the tree to the status line and toast when a rebase stops on conflicts', async ($, on) => {
    mock.clock(on, { now: 0 })
    const lines: (string | undefined)[] = []
    const toasts: string[] = []
    let status = DIRTY
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('process.run', ($, e) => {
      // No gh here, so the pull request band stays empty.
      if (e.argv[0] !== 'git') return run('', 1)
      const args = e.argv.slice(2)
      if (args[0] === 'status') return run(status)
      if (args[0] === 'rev-list') return run('', 128)

      return run(args.filter((_, i) => i % 2 === 1 && i > 1).map(marker => `/work/.git/${marker}`).join('\n'))
    })
    on('fs.exists', ($, e) => ({ value: status === CONFLICTED && e.path === '/work/.git/rebase-merge' }))
    on('ui.status', ($, e) => (lines.push(e.text), { value: undefined }))
    on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    expect(lines.at(-1)).toBe('🌿 main ↑2 ↓1 +3 !2 ?2')

    status = CONFLICTED
    await $.tool.call({ tool: 'Bash', command: 'git rebase main', description: 'Rebase' })
    expect(lines.at(-1)).toBe('🌿 1234567 ✖1 REBASING')
    expect(toasts).toEqual(['Rebasing stopped on 1 conflict'])
  })

  it('should clear the status line outside a repository', async ($, on) => {
    mock.clock(on, { now: 0 })
    const lines: (string | undefined)[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('process.run', () => run('', 128))
    on('ui.status', ($, e) => (lines.push(e.text), { value: undefined }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp' })
    expect(lines).toEqual([undefined])
  })
})
