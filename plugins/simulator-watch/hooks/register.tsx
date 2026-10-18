import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Claim, Sim, View } from '../types'

const POLL_MS = 30_000
// A session rewrites its claim every poll, so one older than this belongs to a session that has gone.
const STALE_MS = 2 * 60_000

// Xcode MCP tools that run on the scheme's run destination without naming it.
const XCODE_RUN = /^mcp__xcode__(RunProject|RunAllTests|RunSomeTests|DeviceInteraction\w+)$/
const DESIGN = /^mcp__claude-design__/

const view = atom({ plugin: 'simulator-watch', key: 'view' } as const, null as View | null)
const mine = atom({ plugin: 'simulator-watch', key: 'mine' } as const, null as Claim | null)

/** Drops control characters, so a device or project name cannot carry terminal escapes. */
export const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

type SimctlDevice = { udid: string; name: string; state: string }

/** The booted devices in `xcrun simctl list devices booted -j`, with each runtime key read as `iOS 27.2`. */
export function parseBooted(json: { devices?: Record<string, SimctlDevice[]> }): Sim[] {
  return Object.entries(json.devices ?? {}).flatMap(([key, devices]) => {
    const runtime = (key.split('.').pop() ?? key).replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1')

    return devices.filter(d => d.state === 'Booted').map(d => ({ udid: d.udid, name: clean(d.name), runtime }))
  })
}

/**
 * The booted simulators a tool call works on: those it names by UDID or by name (the longest name
 * wins, so `iPhone 18 Pro Max` is not also `iPhone 18 Pro`), else the only booted one when the call
 * says `booted` or is an Xcode run that uses the scheme's destination.
 */
export function simulatorsIn(tool: string, input: Record<string, unknown>, booted: readonly Sim[]): Sim[] {
  const text = tool === 'Bash' ? String(input.command ?? '') : tool.startsWith('mcp__xcode__') ? JSON.stringify(input) : ''
  if (!text || (tool === 'Bash' && !/\b(simctl|xcodebuild|Simulator)\b/.test(text))) return []

  const byUdid = booted.filter(s => text.includes(s.udid))
  if (byUdid.length) return byUdid
  const byName = booted.filter(s => text.includes(s.name))
  const named = byName.filter(s => !byName.some(o => o.name !== s.name && o.name.includes(s.name) && text.includes(o.name)))
  if (named.length) return named

  return booted.length === 1 && (/\bbooted\b/.test(text) || XCODE_RUN.test(tool)) ? [...booted] : []
}

/** Whether the item was used within `holdMs`, by a session still writing its claim. */
const isHeld = (claim: Claim, at: number | undefined, now: number, holdMs: number) =>
  at !== undefined && now - claim.at < STALE_MS && now - at < holdMs

/** Labels the sessions holding an item, this one first. */
export function holders(me: Claim | null, others: readonly Claim[], pick: (c: Claim) => number | undefined, now: number, holdMs: number) {
  const labels = me && isHeld({ ...me, at: now }, pick(me), now, holdMs) ? ['this session'] : []
  for (const other of others) {
    if (isHeld(other, pick(other), now, holdMs)) labels.push(other.project === me?.project ? `another ${other.project} session` : other.project)
  }

  return labels
}

export type Row = { icon: string; label: string; status: string; color: string }

/** The band's rows: every booted simulator in an Xcode project or once this session used one, then this session's Claude Design projects. */
export function rows(v: View, me: Claim | null, now: number, holdMs: number): Row[] {
  const out: Row[] = []
  const hasSims = Object.values(me?.simulators ?? {}).some(s => now - s.at < holdMs)
  if (v.isXcode || hasSims) {
    if (!v.booted.length) out.push({ icon: '📱', label: 'no simulator booted', status: '', color: 'gray' })
    for (const sim of v.booted) {
      const who = holders(me, v.others, c => c.simulators[sim.udid]?.at, now, holdMs)
      out.push({ icon: '📱', label: `${sim.name} (${sim.runtime})`, ...status(who) })
    }
  }
  for (const [id, design] of Object.entries(me?.designs ?? {})) {
    if (now - design.at >= holdMs) continue
    const who = holders(me, v.others, c => c.designs[id]?.at, now, holdMs)
    out.push({ icon: '🎨', label: design.name ?? `design ${id.slice(0, 8)}`, ...status(who) })
  }

  return out
}

function status(who: string[]) {
  if (!who.length) return { status: 'free', color: 'gray' }
  const isMine = who[0] === 'this session'
  if (isMine && who.length > 1) return { status: `⚠ also ${who.slice(1).join(', ')}`, color: 'yellow' }

  return { status: isMine ? 'this session' : who.join(', '), color: isMine ? 'green' : 'cyan' }
}

// The folder every session's claim sits in, and how long a claim holds, set when the session starts.
let dir = ''
let holdMs = 10 * 60_000
// Clashes already toasted, `<item>:<session>`, so each is told once.
const told = new Set<string>()

async function booted($: EngineInterface) {
  const ran = await $.process.run(['xcrun', 'simctl', 'list', 'devices', 'booted', '-j'], { timeoutMs: 15_000 }).catch(() => null)
  if (!ran || ran.exitCode !== 0) return []
  try {
    return parseBooted(JSON.parse(ran.stdout))
  } catch {
    return []
  }
}

async function others($: EngineInterface, session: string) {
  const entries = await $.fs.list(dir).catch(() => [])
  const claims: Claim[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json') || entry.name === `${session}.json`) continue
    try {
      const claim = JSON.parse(await $.fs.read(`${dir}/${entry.name}`)) as Claim
      claims.push({ ...claim, project: clean(claim.project) })
    } catch {
      // A claim mid-write or malformed is read on the next poll.
    }
  }

  return claims
}

async function save($: EngineInterface, claim: Claim) {
  await $.fs.write(`${dir}/${claim.session}.json`, JSON.stringify(claim)).catch(() => undefined)
}

async function refresh($: EngineInterface) {
  const me = await read($, mine)
  if (!me || !dir) return
  const now = await $.clock.now()
  await update($, mine, () => ({ ...me, at: now }))
  await save($, { ...me, at: now })
  const was = await read($, view)
  const isXcode = was?.isXcode ?? false
  const hasSims = Object.values(me.simulators).some(s => now - s.at < holdMs)
  const [sims, claims] = await Promise.all([isXcode || hasSims ? booted($) : Promise.resolve([]), others($, me.session)])
  await update($, view, () => ({ isXcode, booted: sims, others: claims }))
}

/** How a session is named to others: its project, or `another <project> session` beside one of the same project. */
const who = (other: Claim, me: Claim) => (other.project === me.project ? `another ${me.project} session` : `the ${other.project} session`)

/** The message the holding session's model reads when this session picks up what it holds. */
export const holderNote = (me: Claim, label: string) =>
  `simulator-watch: the ${me.project} session (${me.session}) has started using ${label}, which you are also using. ` +
  `If you are in the middle of something on it, reply to this message to ask it to wait or to use another one; otherwise no reply is needed.`

/** The note this session's model reads: who else holds the item, that they were told, and what is free instead. */
export const selfNote = (label: string, holders: string[], free: string[]) =>
  `simulator-watch: ${label} is also in use by ${holders.join(' and ')}, which has been told you are using it. ` +
  `If a reply asks you to wait, wait for its next message or work elsewhere` +
  (free.length ? `; booted simulators no other session holds: ${free.join(', ')}.` : '.')

/**
 * Records this session's use of the items. For each another live session also holds, once per pair,
 * it toasts, messages that session, and tells this session's model who holds it and what is free.
 */
async function claim($: EngineInterface, kind: 'simulators' | 'designs', items: { id: string; name?: string }[]) {
  const me = await read($, mine)
  if (!me || !items.length) return
  const now = await $.clock.now()
  const next: Claim = { ...me, at: now, simulators: { ...me.simulators }, designs: { ...me.designs } }
  for (const { id, name } of items) {
    if (kind === 'simulators') next.simulators[id] = { name: name ?? id, at: now }
    else next.designs[id] = { name: name ?? me.designs[id]?.name, at: now }
  }
  await update($, mine, () => next)
  await save($, next)

  const claims = await others($, me.session)
  const v = await read($, view)
  const booted = v?.booted ?? []
  await update($, view, () => ({ isXcode: v?.isXcode ?? false, booted, others: claims }))
  const free = booted.filter(s => !claims.some(c => isHeld(c, c.simulators[s.udid]?.at, now, holdMs))).map(s => s.name)
  for (const { id, name } of items) {
    const label = name ?? next.designs[id]?.name ?? `Claude Design project ${id.slice(0, 8)}`
    const fresh = claims.filter(c => isHeld(c, c[kind][id]?.at, now, holdMs) && !told.has(`${id}:${c.session}`))
    if (!fresh.length) continue
    for (const other of fresh) {
      told.add(`${id}:${other.session}`)
      $.ui.toast(`${label} is also in use by ${who(other, me)}`, { timeoutMs: 8000 })
      await $.session.send({ to: { sessionId: other.session }, text: holderNote(me, label) }).catch(() => undefined)
    }
    const text = selfNote(label, fresh.map(c => who(c, me)), kind === 'simulators' ? free : [])
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
  }
}

/** Tells every live session that shares an item with this one that this session has let it go. */
async function release($: EngineInterface, me: Claim) {
  const now = await $.clock.now()
  for (const other of await others($, me.session)) {
    const shared = [
      ...Object.entries(me.simulators).filter(([id, s]) => now - s.at < holdMs && isHeld(other, other.simulators[id]?.at, now, holdMs)).map(([, s]) => s.name),
      ...Object.entries(me.designs).filter(([id, d]) => now - d.at < holdMs && isHeld(other, other.designs[id]?.at, now, holdMs)).map(([id, d]) => d.name ?? `Claude Design project ${id.slice(0, 8)}`),
    ]
    if (!shared.length) continue
    const text = `simulator-watch: the ${me.project} session (${me.session}) has ended and is no longer using ${shared.join(', ')}.`
    await $.session.send({ to: { sessionId: other.session }, text }).catch(() => undefined)
  }
}

export const register: Register = (on, options) => {
  holdMs = (typeof options.hold === 'number' && options.hold > 0 ? options.hold : 10) * 60_000

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const home = await $.process.run(['printenv', 'HOME']).catch(() => null)
    if (!home?.stdout.trim()) return result
    dir = `${home.stdout.trim()}/.claude/simulator-watch`
    const root = await $.session.root()
    const session = (await $.session.id()).replace(/[^\w-]/g, '')
    const kept = await read($, mine)
    if (kept?.session !== session) {
      await update($, mine, () => ({ session, project: root.split('/').pop() || root, at: 0, simulators: {}, designs: {} }))
    }

    const tracked = await $.process.run(['git', '-C', root, 'ls-files', '*.xcodeproj/project.pbxproj', '*.xcworkspace/contents.xcworkspacedata'], { timeoutMs: 15_000 }).catch(() => null)
    const listed = tracked?.exitCode === 0 ? [] : await $.fs.list(root).catch(() => [])
    const isXcode = !!tracked?.stdout.trim() || listed.some(f => /\.(xcodeproj|xcworkspace)$/.test(f.name))
    await update($, view, () => ({ isXcode, booted: [], others: [] }))
    await refresh($)
    $.clock.every(POLL_MS, () => void refresh($))

    return result
  })

  on('session.end', async ($, e, next) => {
    const me = await read($, mine)
    if (me && dir) {
      await release($, me)
      await save($, { ...me, at: 0, simulators: {}, designs: {} })
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined) return result
    const input = e as unknown as Record<string, unknown>

    if (e.tool === 'Bash' || e.tool.startsWith('mcp__xcode__')) {
      // After the call, so a simulator it just booted is in the list.
      const sims = simulatorsIn(e.tool, input, await booted($))
      await claim($, 'simulators', sims.map(s => ({ id: s.udid, name: s.name })))
    } else if (DESIGN.test(e.tool) && typeof input.project_id === 'string') {
      await claim($, 'designs', [{ id: input.project_id }])
    } else if (e.tool === 'mcp__claude-design__create_project' && typeof input.name === 'string') {
      const id = /"(?:project_)?id"\s*:\s*"([^"]+)"/.exec(JSON.stringify(result.result ?? ''))?.[1]
      if (id) await claim($, 'designs', [{ id, name: clean(input.name) }])
    }

    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    const me = await read($, mine)
    const list = v && !e.props.hasSurvey ? rows(v, me, await $.clock.now(), holdMs) : []

    if (!list.length) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    // Stack above whatever the plugins beneath draw, so other bands stay.
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" paddingX={1} columnGap={2}>
          {list.map(row => (
            <Text key={row.icon + row.label} color={row.color} wrap="truncate-end">
              {row.icon} {row.label}{row.status ? ` · ${row.status}` : ''}
            </Text>
          ))}
        </Box>
        {below}
      </Box>
    )
  })
}
