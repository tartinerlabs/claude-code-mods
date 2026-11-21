import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Deploy, Watch } from '../types'

const POLL_MS = 15_000
// A commit no Vercel status names by then is in a project Vercel does not deploy.
const NONE_MS = 3 * 60_000
// Stop following a deployment still running after this long.
const MAX_MS = 30 * 60_000

const PUSH = /(^|[\s;&|(])git\s+push\b/
const MERGE = /(^|[\s;&|(])gh\s+pr\s+merge\b/

// Held by the host, so a hot reload keeps the band drawn.
const watch = atom({ plugin: 'vercel-watch', key: 'watch' } as const, null as Watch)

// The module's own poll: a reload drops it, and session.start picks the watch up again.
let timer: Timer | undefined
// Whether this watch has seen a deployment still to finish, so one already done before the push stays quiet.
let isFresh = false

async function run($: EngineInterface, argv: string[]) {
  const ran = await $.process.run(argv, { timeoutMs: 15_000 }).catch(() => null)

  return ran?.exitCode === 0 ? ran.stdout.trim() : null
}

/** The latest Vercel status per context, from `GET /repos/{owner}/{repo}/commits/{sha}/statuses` (newest first). */
export function parseStatuses(json: string): Deploy[] {
  const statuses = JSON.parse(json) as { context: string; state: string; description: string | null; target_url: string | null }[]
  const seen = new Set<string>()
  const deploys: Deploy[] = []
  for (const s of statuses) {
    if (!s.context.startsWith('Vercel') || seen.has(s.context)) continue
    seen.add(s.context)
    const state = s.state === 'success' || s.state === 'failure' || s.state === 'error' ? s.state : 'pending'
    deploys.push({ project: projectOf(s.context, s.target_url ?? ''), state, description: s.description ?? '', url: s.target_url ?? '' })
  }

  return deploys.sort((a, b) => a.project.localeCompare(b.project))
}

/** The project from an inspector URL (`https://vercel.com/<team>/<project>/<id>`), else from the context (`Vercel – web`). */
export function projectOf(context: string, url: string) {
  const path = url.match(/^https:\/\/vercel\.com\/[^/]+\/([^/]+)\//)

  return path?.[1] ?? (context.replace(/^Vercel\s*[–-]?\s*/, '') || 'Vercel')
}

/** What Claude is told when a deployment fails; reading its logs is left to the Vercel tools. */
export function failureNote(d: Deploy, sha: string, branch: string) {
  const id = d.url.split('/').at(-1)

  return [
    `The Vercel deployment of ${d.project} for commit ${sha.slice(0, 7)} on ${branch} failed${d.description ? `: ${d.description}` : ''}.`,
    `Inspector: ${d.url}${id ? ` (deployment dpl_${id})` : ''}.`,
    'Tell the user, and read the build logs before changing anything.',
  ].join('\n')
}

async function stop($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  await update($, watch, () => null)
}

async function poll($: EngineInterface, sha: string) {
  const w = await read($, watch)
  if (!w || w.sha !== sha) return
  const now = await $.clock.now()
  const json = await run($, ['gh', 'api', `repos/{owner}/{repo}/commits/${sha}/statuses?per_page=100`])
  if (json === null) return
  const deploys = parseStatuses(json)

  if (!deploys.length) {
    isFresh = true
    if (now - w.startedAt > NONE_MS) return stop($)
    // A fresh copy redraws the band, so its minutes move while nothing has been reported yet.
    await update($, watch, () => ({ ...w }))
    return
  }
  if (deploys.some(d => d.state === 'pending')) {
    isFresh = true
    if (now - w.startedAt > MAX_MS) return stop($)
    await update($, watch, () => ({ ...w, deploys }))
    return
  }

  await stop($)
  // Already finished before this push: nothing new to say.
  if (!isFresh) return
  for (const d of deploys) {
    if (d.state === 'success') {
      $.ui.toast(`▲ ${d.project} deployed (${w.branch})`)
      continue
    }
    $.ui.toast(`▲ ${d.project} deploy failed (${w.branch})`)
    await $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text: failureNote(d, sha, w.branch) }] } })
      .catch(() => {})
  }
}

async function start($: EngineInterface, sha: string, branch: string) {
  timer?.cancel()
  isFresh = false
  const startedAt = await $.clock.now()
  await update($, watch, () => ({ sha, branch, startedAt, deploys: [] }))
  timer = $.clock.every(POLL_MS, () => void poll($, sha))
  await poll($, sha)
}

/** The default branch and its head on GitHub. */
async function defaultHead($: EngineInterface) {
  const out = await run($, ['gh', 'repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name + " " + .defaultBranchRef.target.oid'])
  const [branch, sha] = out?.split(' ') ?? []

  return branch && sha ? { branch, sha } : null
}

/** After a push: the pushed commit, unless the push failed or the branch has an open pull request the app already follows. */
async function afterPush($: EngineInterface) {
  const [head, upstream, branch] = await Promise.all([
    run($, ['git', 'rev-parse', 'HEAD']),
    run($, ['git', 'rev-parse', '@{u}']),
    run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD']),
  ])
  if (!head || head !== upstream || !branch) return
  if ((await read($, watch))?.sha === head) return
  if ((await run($, ['gh', 'pr', 'view', '--json', 'state', '--jq', '.state'])) === 'OPEN') return
  await start($, head, branch)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // Pick up a watch from before a reload.
    const w = await read($, watch)
    if (w) {
      timer?.cancel()
      isFresh = true
      timer = $.clock.every(POLL_MS, () => void poll($, w.sha))
    }

    return result
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = e.command
    if (MERGE.test(command)) {
      const before = await defaultHead($).catch(() => null)
      const result = await next(e)
      void defaultHead($)
        .then(after => (after && after.sha !== before?.sha ? start($, after.sha, after.branch) : undefined))
        .catch(() => {})

      return result
    }
    const result = await next(e)
    if (PUSH.test(command)) void afterPush($).catch(() => {})

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const w = await read($, watch)
    if (e.props.hasSurvey || !w) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const minutes = Math.max(0, Math.floor(((await $.clock.now()) - w.startedAt) / 60_000))
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" paddingX={1} gap={2}>
          <Text>▲ {w.branch}</Text>
          {w.deploys.length === 0 && <Text dimColor>waiting for Vercel</Text>}
          {w.deploys.map(d => (
            <Text key={d.project} color={d.state === 'pending' ? 'yellow' : d.state === 'success' ? 'green' : 'red'} wrap="truncate-end">
              {d.state === 'pending' ? '⏳' : d.state === 'success' ? '✅' : '❌'} {d.project}
            </Text>
          ))}
          <Text dimColor>{minutes}m</Text>
        </Box>
        {below}
      </Box>
    )
  })
}
