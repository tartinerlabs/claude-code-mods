import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Checks, Pr } from '../types'

const FIELDS = 'number,url,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup'
const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

// Held by the host, so a hot reload keeps the band and does not toast the same result twice.
const current = atom({ plugin: 'pr-pilot', key: 'pr' } as const, null as Pr | null)

type Rollup = { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string }

/** Tallies `statusCheckRollup`, which mixes check runs (`status`, `conclusion`) and commit statuses (`state`). */
export function tally(rollup: readonly Rollup[]): Checks {
  const checks: Checks = { total: rollup.length, passed: 0, pending: 0, failed: [] }
  for (const check of rollup) {
    const result = check.__typename === 'StatusContext' ? check.state : check.status === 'COMPLETED' ? check.conclusion : 'PENDING'
    if (FAILED.includes(result ?? '')) checks.failed.push(check.name ?? check.context ?? '?')
    else if (result === 'PENDING' || result === 'EXPECTED' || !result) checks.pending += 1
    else checks.passed += 1
  }

  return checks
}

/** True once the pull request can merge as is: open, checks green, nothing blocking it. */
export function isReady(pr: Pr) {
  return !pr.isDraft && pr.mergeable === 'MERGEABLE' && pr.checks.failed.length === 0 && pr.checks.pending === 0 && ['CLEAN', 'HAS_HOOKS'].includes(pr.mergeStateStatus)
}

/** The band's checks entry and its colour. */
export function checksEntry({ total, passed, pending, failed }: Checks): [string, string] {
  if (total === 0) return ['no checks', 'gray']
  if (failed.length) return [`✗ ${failed.length} failing: ${failed.join(', ')}`, 'red']
  if (pending) return [`◐ ${passed}/${total} checks`, 'yellow']

  return [`✓ ${total}/${total} checks`, 'green']
}

/** The band's merge entry and its colour. */
export function mergeEntry(pr: Pr): [string, string] {
  if (pr.isDraft) return ['draft', 'gray']
  if (pr.mergeable === 'CONFLICTING') return ['conflicts', 'red']
  if (pr.mergeStateStatus === 'BEHIND') return ['behind base', 'yellow']
  if (pr.mergeStateStatus === 'BLOCKED') return ['blocked', 'yellow']
  if (isReady(pr)) return ['ready · /merge', 'green']

  return ['waiting', 'gray']
}

async function fetchPr($: EngineInterface): Promise<Pr | null> {
  const ran = await $.process.run(['gh', 'pr', 'view', '--json', FIELDS], { timeoutMs: 15_000 }).catch(() => null)
  if (!ran || ran.exitCode !== 0) return null
  const view = JSON.parse(ran.stdout)
  if (view.state !== 'OPEN') return null

  return {
    number: view.number,
    url: view.url,
    isDraft: view.isDraft,
    mergeable: view.mergeable,
    mergeStateStatus: view.mergeStateStatus,
    checks: tally(view.statusCheckRollup ?? []),
  }
}

async function refresh($: EngineInterface) {
  const pr = await fetchPr($)
  const was = await read($, current)
  await update($, current, () => pr)

  // Toast when the same pull request's checks finish, not on first sight.
  if (!pr || was?.number !== pr.number || !was.checks.pending || pr.checks.pending) return
  $.ui.toast(
    pr.checks.failed.length
      ? `PR #${pr.number} checks failed: ${pr.checks.failed.join(', ')}`
      : `PR #${pr.number} checks passed${isReady(pr) ? ', ready to /merge' : ''}`,
    { timeoutMs: 8000 },
  )
}

export const register: Register = (on, options) => {
  const method = typeof options.method === 'string' ? options.method : 'merge'

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'merge', description: "Merge this branch's pull request once its checks pass" })
    await refresh($)
    $.clock.every(60_000, () => refresh($))

    return result
  })

  // A turn may have pushed or opened a pull request.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) void refresh($)

    return result
  })

  on('command.run', { command: 'merge' }, async $ => {
    await refresh($)
    const pr = await read($, current)
    if (!pr) return { text: 'No open pull request for this branch.' }
    if (!isReady(pr)) return { text: `PR #${pr.number} is not ready to merge: ${checksEntry(pr.checks)[0]}, ${mergeEntry(pr)[0]}.` }

    const ran = await $.process.run(['gh', 'pr', 'merge', String(pr.number), `--${method}`, '--delete-branch'], { timeoutMs: 120_000 })
    await refresh($)

    return { text: ran.exitCode === 0 ? `Merged PR #${pr.number}.` : `gh pr merge failed: ${(ran.stderr || ran.stdout).trim()}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const pr = await read($, current)

    if (e.props.hasSurvey || !pr) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const [checks, checksColour] = checksEntry(pr.checks)
    const [merge, mergeColour] = mergeEntry(pr)
    // Stack above whatever the plugins beneath draw, so other bands stay.
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" paddingX={1} gap={2}>
          <Text dimColor>PR #{pr.number}</Text>
          <Text color={checksColour} wrap="truncate-end">{checks}</Text>
          <Text color={mergeColour}>{merge}</Text>
        </Box>
        {below}
      </Box>
    )
  })
}
