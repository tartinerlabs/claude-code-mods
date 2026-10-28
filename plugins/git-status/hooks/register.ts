import type { EngineInterface, Register, Timer } from 'claude-code'

// Catches edits made outside Claude Code, between tool calls.
const POLL_MS = 15_000
// --no-optional-locks keeps the poll from taking index.lock while the person runs git themselves.
const GIT = ['git', '--no-optional-locks']
// Marker files git leaves in its directory while an operation is stopped, first match wins.
const OPERATIONS = [
  ['rebase-merge', 'REBASING'],
  ['rebase-apply', 'REBASING'],
  ['MERGE_HEAD', 'MERGING'],
  ['CHERRY_PICK_HEAD', 'CHERRY-PICKING'],
  ['REVERT_HEAD', 'REVERTING'],
  ['BISECT_LOG', 'BISECTING'],
] as const

export type Tree = {
  branch: string
  ahead: number
  behind: number
  staged: number
  modified: number
  untracked: number
  conflicts: number
}

// The module's own state: a reload drops it, and session.start starts it again.
let timer: Timer | undefined
let running: Promise<void> | undefined
let isQueued = false
let lastConflicts = 0

async function git($: EngineInterface, args: string[]) {
  const ran = await $.process.run([...GIT, ...args]).catch(() => null)

  return ran?.exitCode === 0 ? ran.stdout : null
}

async function operation($: EngineInterface) {
  const paths = await git($, ['rev-parse', '--path-format=absolute', ...OPERATIONS.flatMap(([marker]) => ['--git-path', marker])])
  if (paths === null) return undefined
  const lines = paths.trim().split('\n')
  for (const [i, [, label]] of OPERATIONS.entries()) {
    if (await $.fs.exists(lines[i]!).catch(() => false)) return label
  }

  return undefined
}

async function stashes($: EngineInterface) {
  // Fails when there is no stash at all.
  const count = await git($, ['rev-list', '--walk-reflogs', '--count', 'refs/stash'])

  return count === null ? 0 : Number(count.trim()) || 0
}

async function show($: EngineInterface) {
  const status = await git($, ['status', '--porcelain=v2', '--branch'])
  if (status === null) {
    $.ui.status(undefined)
    return
  }
  const tree = parse(status)
  const [stash, op] = await Promise.all([stashes($), operation($)])
  $.ui.status(format(tree, stash, op))

  if (tree.conflicts > 0 && lastConflicts === 0) {
    $.ui.toast(`${op ? `${op[0]}${op.slice(1).toLowerCase()} stopped on` : 'Git has'} ${plural(tree.conflicts, 'conflict')}`)
  }
  lastConflicts = tree.conflicts
}

/** Runs one refresh at a time, and one more after it when asked meanwhile. */
function refresh($: EngineInterface) {
  if (running) {
    isQueued = true
    return running
  }
  running = show($)
    .catch(() => $.ui.status(undefined))
    .finally(() => {
      running = undefined
      if (isQueued) {
        isQueued = false
        void refresh($)
      }
    })

  return running
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    timer?.cancel()
    timer = $.clock.every(POLL_MS, () => void refresh($))
    await refresh($)

    return result
  })

  // Any tool may have changed the tree: Bash, Edit, Write, or an MCP tool.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    await refresh($)

    return result
  }).catch(($, e, next) => next(e))
}

/** Reads `git status --porcelain=v2 --branch`. */
export function parse(status: string): Tree {
  const tree: Tree = { branch: '', ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0 }
  let oid = ''
  for (const line of status.split('\n')) {
    if (line.startsWith('# branch.oid ')) oid = line.slice(13)
    else if (line.startsWith('# branch.head ')) tree.branch = line.slice(14)
    else if (line.startsWith('# branch.ab ')) {
      const [ahead, behind] = line.slice(12).split(' ')
      tree.ahead = Number(ahead) || 0
      tree.behind = Math.abs(Number(behind) || 0)
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      if (line[2] !== '.') tree.staged++
      if (line[3] !== '.') tree.modified++
    } else if (line.startsWith('u ')) tree.conflicts++
    else if (line.startsWith('? ')) tree.untracked++
  }
  // A detached HEAD reads as its short commit.
  if (tree.branch === '(detached)') tree.branch = oid === '(initial)' ? oid : oid.slice(0, 7)

  return tree
}

/** The status line: `🌿 main ↑2 ↓1 +3 !1 ?2 ✖1 ⚑1 REBASING`, or `✓` when there is nothing to show. */
export function format(tree: Tree, stash = 0, operation?: string) {
  const parts = [
    tree.ahead && `↑${tree.ahead}`,
    tree.behind && `↓${tree.behind}`,
    tree.staged && `+${tree.staged}`,
    tree.modified && `!${tree.modified}`,
    tree.untracked && `?${tree.untracked}`,
    tree.conflicts && `✖${tree.conflicts}`,
    stash && `⚑${stash}`,
    operation,
  ].filter(Boolean)

  return `🌿 ${tree.branch} ${parts.length ? parts.join(' ') : '✓'}`
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
