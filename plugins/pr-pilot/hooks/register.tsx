import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Checks, Pr, Stack } from '../types'

const FIELDS = 'number,url,headRefOid,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup'
const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

// Held by the host, so a hot reload keeps the band and does not toast the same result twice.
const current = atom({ plugin: 'pr-pilot', key: 'pr' } as const, null as Pr | null)

/** Drops control characters, so a check name or gh output cannot carry terminal escapes. */
export const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

type Rollup = { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string }

/** Tallies `statusCheckRollup`, which mixes check runs (`status`, `conclusion`) and commit statuses (`state`). */
export function tally(rollup: readonly Rollup[]): Checks {
  const checks: Checks = { total: rollup.length, passed: 0, pending: 0, failed: [] }
  for (const check of rollup) {
    const result = check.__typename === 'StatusContext' ? check.state : check.status === 'COMPLETED' ? check.conclusion : 'PENDING'
    if (FAILED.includes(result ?? '')) checks.failed.push(clean(check.name ?? check.context ?? '?'))
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

type StackView = { trunk: string; currentBranch: string; branches: { name: string; isMerged: boolean; pr?: { number: number } }[] }

/** The current branch's place among the unmerged layers of `gh stack view --json`, or null when it is not one. */
export function parseStack(view: StackView): Stack | null {
  const layers = view.branches.filter(b => !b.isMerged).map(b => ({ branch: b.name, pr: b.pr?.number }))
  const index = layers.findIndex(l => l.branch === view.currentBranch)

  return index < 0 ? null : { position: index + 1, total: layers.length, trunk: view.trunk, layers }
}

async function fetchStack($: EngineInterface): Promise<Stack | null> {
  // Exits non-zero off a stack, and where the gh-stack extension is not installed.
  const ran = await $.process.run(['gh', 'stack', 'view', '--json'], { timeoutMs: 15_000 }).catch(() => null)
  if (!ran || ran.exitCode !== 0) return null

  try {
    return parseStack(JSON.parse(ran.stdout))
  } catch {
    return null
  }
}

async function fetchPr($: EngineInterface, number?: number): Promise<Pr | null> {
  const argv = ['gh', 'pr', 'view', ...(number ? [String(number)] : []), '--json', FIELDS]
  const ran = await $.process.run(argv, { timeoutMs: 15_000 }).catch(() => null)
  if (!ran || ran.exitCode !== 0) return null
  const view = JSON.parse(ran.stdout)
  if (view.state !== 'OPEN') return null

  return {
    number: view.number,
    url: view.url,
    head: view.headRefOid,
    isDraft: view.isDraft,
    mergeable: view.mergeable,
    mergeStateStatus: view.mergeStateStatus,
    checks: tally(view.statusCheckRollup ?? []),
  }
}

async function refresh($: EngineInterface) {
  const pr = await fetchPr($)
  const stack = pr && (await fetchStack($))
  if (pr && stack) pr.stack = stack
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

/** True when `branch` is at `head` locally, so merging and deleting it loses no unpushed commits. */
async function isPushed($: EngineInterface, branch: string, head: string) {
  const local = await $.process.run(['git', 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`]).catch(() => null)

  return local?.exitCode === 0 && local.stdout.trim() === head
}

/**
 * Merges the whole stack with `gh stack merge`, after checking every unmerged layer, since it is all
 * or nothing and has no head pin. It runs without an argument, as a number would be read as a stack
 * number before a pull request number.
 */
async function mergeStack($: EngineInterface, pr: Pr, stack: Stack, method: string) {
  const numbers: number[] = []
  for (const layer of stack.layers) {
    if (!layer.pr) return `${layer.branch} has no pull request yet: run gh stack submit first.`
    const one = layer.pr === pr.number ? pr : await fetchPr($, layer.pr)
    if (!one) return `PR #${layer.pr} (${layer.branch}) is not open.`
    if (!isReady(one)) return `PR #${one.number} (${layer.branch}) is not ready to merge: ${checksEntry(one.checks)[0]}, ${mergeEntry(one)[0]}.`
    if (!(await isPushed($, layer.branch, one.head))) return `${layer.branch} is not at PR #${one.number}'s head: push or pull first.`
    numbers.push(one.number)
  }

  const ran = await $.process.run(['gh', 'stack', 'merge', '--yes', `--${method}`], { timeoutMs: 300_000 })
  if (ran.exitCode !== 0) return `gh stack merge failed: ${clean((ran.stderr || ran.stdout).trim())}`

  return `Merged stack: PR #${numbers.join(', #')}.${await deleteLayers($, stack)}`
}

/**
 * Deletes every layer's branch, local and remote, and switches to the trunk, as `gh pr merge -d` does
 * for one pull request, which `gh stack merge` has no flag for. It waits until every pull request has
 * merged, since deleting a head branch while the stack sits in a merge queue would close it.
 */
async function deleteLayers($: EngineInterface, stack: Stack) {
  for (const layer of stack.layers) {
    const state = await $.process.run(['gh', 'pr', 'view', String(layer.pr), '--json', 'state', '--jq', '.state'], { timeoutMs: 15_000 }).catch(() => null)
    if (state?.stdout.trim() !== 'MERGED') return ' Branches kept until every pull request has merged.'
  }
  const checkout = await $.process.run(['git', 'checkout', stack.trunk]).catch(() => null)
  if (checkout?.exitCode !== 0) return ` Could not switch to ${stack.trunk}, so the branches were kept.`
  await $.process.run(['git', 'pull', '--ff-only'], { timeoutMs: 60_000 }).catch(() => null)

  const kept: string[] = []
  for (const { branch } of stack.layers) {
    // Fails harmlessly when the repository already deleted the head branch on merge.
    await $.process.run(['gh', 'api', '-X', 'DELETE', `repos/{owner}/{repo}/git/refs/heads/${branch}`], { timeoutMs: 15_000 }).catch(() => null)
    const deleted = await $.process.run(['git', 'branch', '-D', branch]).catch(() => null)
    if (deleted?.exitCode !== 0) kept.push(branch)
  }

  return kept.length ? ` Switched to ${stack.trunk}, but could not delete ${kept.join(', ')} locally.` : ` Deleted ${stack.layers.map(l => l.branch).join(', ')} and switched to ${stack.trunk}.`
}

export const register: Register = (on, options) => {
  const method = typeof options.method === 'string' ? options.method : 'merge'

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'merge', description: "Merge this branch's pull request, or its whole stack, once checks pass" })
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
    if (pr.stack) {
      const text = await mergeStack($, pr, pr.stack, method)
      await refresh($)

      return { text }
    }
    if (!isReady(pr)) return { text: `PR #${pr.number} is not ready to merge: ${checksEntry(pr.checks)[0]}, ${mergeEntry(pr)[0]}.` }

    // --delete-branch drops the local branch, so refuse while it holds commits the PR does not.
    const local = await $.process.run(['git', 'rev-parse', 'HEAD']).catch(() => null)
    if (local?.stdout.trim() !== pr.head) return { text: `This branch is not at PR #${pr.number}'s head: push or pull first.` }

    // Pinned to the head that was checked, so a push since then is not merged unchecked.
    const ran = await $.process.run(['gh', 'pr', 'merge', String(pr.number), `--${method}`, '--delete-branch', '--match-head-commit', pr.head], { timeoutMs: 120_000 })
    await refresh($)

    return { text: ran.exitCode === 0 ? `Merged PR #${pr.number}.` : `gh pr merge failed: ${clean((ran.stderr || ran.stdout).trim())}` }
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
          {pr.stack && <Text dimColor>stack {pr.stack.position}/{pr.stack.total}</Text>}
          <Text color={checksColour} wrap="truncate-end">{checks}</Text>
          <Text color={mergeColour}>{merge}</Text>
        </Box>
        {below}
      </Box>
    )
  })
}
