import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Claim, Item, Kind, Sim, View } from '../types'

const POLL_MS = 30_000
// A session rewrites its claim every poll, so one older than this belongs to a session that has gone.
const STALE_MS = 2 * 60_000

// Xcode MCP tools that run on the scheme's run destination without naming it.
const XCODE_RUN = /^mcp__xcode__(RunProject|RunAllTests|RunSomeTests|DeviceInteraction\w+)$/
// Xcode MCP tools that drive the one Xcode app every session shares: its scheme, destination, workspace, builds and runs.
const XCODE_STATE = /^mcp__xcode__(XcodeSwitch\w+|XcodeOpenWorkspace|XcodeCloseWorkspace|BuildProject|RunProject|StopProject|RunAllTests|RunSomeTests)$/
const DESIGN = /^mcp__claude-design__/
const SIM_COMMAND = /\b(simctl|xcodebuild|Simulator)\b/
const PORT = /(?:--port[= ]|\bPORT=|\blocalhost:|\b127\.0\.0\.1:|\b0\.0\.0\.0:)(\d{2,5})\b/g

const view = atom({ plugin: 'resource-watch', key: 'view' } as const, null as View | null)
const mine = atom({ plugin: 'resource-watch', key: 'mine' } as const, null as Claim | null)

/** Drops control characters, so a device, project or file name cannot carry terminal escapes. */
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
  if (!text || (tool === 'Bash' && !SIM_COMMAND.test(text))) return []

  const byUdid = booted.filter(s => text.includes(s.udid))
  if (byUdid.length) return byUdid
  const byName = booted.filter(s => text.includes(s.name))
  const named = byName.filter(s => !byName.some(o => o.name !== s.name && o.name.includes(s.name) && text.includes(o.name)))
  if (named.length) return named

  return booted.length === 1 && (/\bbooted\b/.test(text) || XCODE_RUN.test(tool)) ? [...booted] : []
}

/** The local ports a shell command names, as `--port 3000`, `PORT=3000` or `localhost:3000`. */
export function portsIn(command: string): Found[] {
  const ports = [...command.matchAll(PORT)].map(m => Number(m[1])).filter(p => p > 0 && p < 65536)

  return [...new Set(ports)].map(p => ({ id: String(p), name: `localhost:${p}` }))
}

type Proc = { ppid: number; comm: string }

/** The `ps -A -o pid=,ppid=,comm=` table, by pid. */
export function parsePs(text: string): Map<number, Proc> {
  const table = new Map<number, Proc>()
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3]!.trim() })
  }

  return table
}

/** The nearest `claude` process at or above `start`, the one every Bash call of this session runs under; `start` when there is none. */
export function findClaude(table: Map<number, Proc>, start: number) {
  for (let pid = start, steps = 0; pid > 1 && steps < 64; steps += 1) {
    const proc = table.get(pid)
    if (!proc) break
    if (/(^|\/)claude$/.test(proc.comm)) return pid
    pid = proc.ppid
  }

  return start
}

const descends = (table: Map<number, Proc>, pid: number, root: number) => {
  for (let at = pid, steps = 0; at > 1 && steps < 64; steps += 1) {
    if (at === root) return true
    at = table.get(at)?.ppid ?? 0
  }

  return false
}

/** The TCP ports listening in `lsof -nP -iTCP -sTCP:LISTEN -Fpn` output whose process runs under `root`. */
export function servedPorts(lsof: string, table: Map<number, Proc>, root: number): Found[] {
  const ports = new Set<number>()
  let pid = 0
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && descends(table, pid, root)) {
      const port = Number(line.slice(line.lastIndexOf(':') + 1))
      if (port) ports.add(port)
    }
  }

  return [...ports].sort((a, b) => a - b).map(p => ({ id: String(p), name: `localhost:${p}` }))
}

export type Found = { id: string; name: string }
type Context = { tool: string; input: Record<string, unknown>; booted: readonly Sim[]; root: string }

/**
 * What each kind of shared thing a tool call uses. Simulators and Claude Design projects are the
 * baseline; ports are found by what this session's processes serve, so they are not here.
 */
export const DETECTORS: { kind: Exclude<Kind, 'ports'>; detect: (c: Context) => Found[] }[] = [
  { kind: 'simulators', detect: c => simulatorsIn(c.tool, c.input, c.booted).map(s => ({ id: s.udid, name: s.name })) },
  { kind: 'designs', detect: c => (DESIGN.test(c.tool) && typeof c.input.project_id === 'string' ? [{ id: c.input.project_id, name: '' }] : []) },
  { kind: 'xcode', detect: c => (XCODE_STATE.test(c.tool) ? [{ id: 'Xcode', name: 'the Xcode app' }] : []) },
  {
    kind: 'files',
    detect: c => {
      const path = c.tool === 'NotebookEdit' ? c.input.notebook_path : ['Edit', 'Write'].includes(c.tool) ? c.input.file_path : undefined
      if (typeof path !== 'string' || !path) return []
      const id = path.startsWith('/') ? path : `${c.root}/${path}`

      return [{ id, name: clean(id.startsWith(`${c.root}/`) ? id.slice(c.root.length + 1) : id) }]
    },
  },
]

const ICON: Record<Kind, string> = { simulators: '📱', designs: '🎨', xcode: '🛠', ports: '🔌', files: '📄' }
const ALSO: Record<Kind, string> = {
  simulators: 'which you are also using',
  designs: 'which you are also working on',
  xcode: 'which you are also driving',
  ports: 'which you are serving',
  files: 'which you have also been editing',
}

/** How an item reads in the band, a toast and a message. */
export const label = (kind: Kind, id: string, item?: Item) =>
  kind === 'designs' ? item?.name || `Claude Design project ${id.slice(0, 8)}` : (item?.name ?? id)

/** Whether the item was used within `holdMs`, by a session still writing its claim. */
const isHeld = (claim: Claim, at: number | undefined, now: number, holdMs: number) =>
  at !== undefined && now - claim.at < STALE_MS && now - at < holdMs

/** How a session is named to others: `the <project> session`, or `another <project> session` beside one of the same project. */
const who = (other: Claim, me: Claim | null) => (other.project === me?.project ? `another ${other.project} session` : `the ${other.project} session`)

/** Labels the sessions holding an item, this one first. */
export function holders(me: Claim | null, others: readonly Claim[], kind: Kind, id: string, now: number, holdMs: number) {
  const labels = me && isHeld({ ...me, at: now }, me.items[kind]?.[id]?.at, now, holdMs) ? ['this session'] : []
  for (const other of others) {
    if (isHeld(other, other.items[kind]?.[id]?.at, now, holdMs)) labels.push(who(other, me))
  }

  return labels
}

export type Row = { icon: string; label: string; status: string; color: string }

/**
 * The band's rows: every booted simulator in an Xcode project or once this session used one, then
 * the Claude Design projects, Xcode app and ports this session holds, then the files it shares with
 * another session.
 */
export function rows(v: View, me: Claim | null, now: number, holdMs: number): Row[] {
  const out: Row[] = []
  const held = (kind: Kind) => Object.entries(me?.items[kind] ?? {}).filter(([, item]) => now - item.at < holdMs)
  if (v.isXcode || held('simulators').length) {
    if (!v.booted.length) out.push({ icon: ICON.simulators, label: 'no simulator booted', status: '', color: 'gray' })
    for (const sim of v.booted) {
      out.push({ icon: ICON.simulators, label: `${sim.name} (${sim.runtime})`, ...status(holders(me, v.others, 'simulators', sim.udid, now, holdMs)) })
    }
  }
  for (const kind of ['designs', 'xcode', 'ports', 'files'] as const) {
    for (const [id, item] of held(kind)) {
      const who = holders(me, v.others, kind, id, now, holdMs)
      if (kind === 'files' && who.length < 2) continue
      out.push({ icon: ICON[kind], label: label(kind, id, item), ...status(who) })
    }
  }

  return out
}

function status(who: string[]) {
  if (!who.length) return { status: 'free', color: 'gray' }
  const isMine = who[0] === 'this session'
  if (isMine && who.length > 1) return { status: `⚠ also ${who.slice(1).join(', ')}`, color: 'yellow' }

  return { status: isMine ? 'this session' : who.join(', '), color: isMine ? 'green' : 'cyan' }
}

/** The message the holding session's model reads when this session picks up what it holds. */
export const holderNote = (me: Claim, kind: Kind, name: string) =>
  `resource-watch: the ${me.project} session (${me.session}) has started using ${name}, ${ALSO[kind]}. ` +
  `If you are in the middle of something on it, reply to this message to ask it to wait or to use another one; otherwise no reply is needed.`

/** The note this session's model reads: who else holds the item, that they were told, and which simulators are free instead. */
export const selfNote = (name: string, holders: string[], free: string[]) =>
  `resource-watch: ${name} is also in use by ${holders.join(' and ')}, which has been told you are using it. ` +
  `If a reply asks you to wait, wait for its next message or work elsewhere` +
  (free.length ? `; booted simulators no other session holds: ${free.join(', ')}.` : '.')

// The folder every session's claim sits in, this session's root and its claude process, and how long a claim holds, set when the session starts.
let dir = ''
let root = ''
let claudePid = 0
let holdMs = 10 * 60_000
// Clashes already told, `<kind>:<item>:<session>`, so each is told once.
const told = new Set<string>()

async function bootedSims($: EngineInterface) {
  const ran = await $.process.run(['xcrun', 'simctl', 'list', 'devices', 'booted', '-j'], { timeoutMs: 15_000 }).catch(() => null)
  if (!ran || ran.exitCode !== 0) return []
  try {
    return parseBooted(JSON.parse(ran.stdout))
  } catch {
    return []
  }
}

async function psTable($: EngineInterface) {
  const ran = await $.process.run(['ps', '-A', '-o', 'pid=,ppid=,comm='], { timeoutMs: 15_000 }).catch(() => null)

  return parsePs(ran?.stdout ?? '')
}

async function served($: EngineInterface) {
  if (!claudePid) return []
  // lsof exits 1 when nothing listens, with nothing to read.
  const [lsof, table] = await Promise.all([
    $.process.run(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { timeoutMs: 15_000 }).catch(() => null),
    psTable($),
  ])

  return servedPorts(lsof?.stdout ?? '', table, claudePid)
}

async function others($: EngineInterface, session: string) {
  const entries = await $.fs.list(dir).catch(() => [])
  const claims: Claim[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json') || entry.name === `${session}.json`) continue
    try {
      const claim = JSON.parse(await $.fs.read(`${dir}/${entry.name}`)) as Claim
      claims.push({ ...claim, project: clean(claim.project), items: claim.items ?? {} })
    } catch {
      // A claim mid-write or malformed is read on the next poll.
    }
  }

  return claims
}

async function save($: EngineInterface, claim: Claim) {
  await $.fs.write(`${dir}/${claim.session}.json`, JSON.stringify(claim)).catch(() => undefined)
}

/** Records this session's use of the items; `replace` swaps the kind's whole set, as for the ports it serves now. */
async function record($: EngineInterface, kind: Kind, found: Found[], replace = false) {
  const me = await read($, mine)
  if (!me) return null
  const now = await $.clock.now()
  const kept = replace ? {} : { ...me.items[kind] }
  for (const { id, name } of found) kept[id] = { name: name || (me.items[kind]?.[id]?.name ?? ''), at: now }
  const next: Claim = { ...me, at: now, items: { ...me.items, [kind]: kept } }
  await update($, mine, () => next)
  await save($, next)

  return next
}

/**
 * For each item another live session also holds, once per pair: toasts, messages that session, and
 * tells this session's model who holds it and, for a simulator, which booted ones are free.
 */
async function warn($: EngineInterface, kind: Kind, found: Found[]) {
  const me = await read($, mine)
  if (!me || !found.length) return
  const now = await $.clock.now()
  const claims = await others($, me.session)
  const v = await read($, view)
  const booted = v?.booted ?? []
  await update($, view, () => ({ isXcode: v?.isXcode ?? false, booted, others: claims }))
  const free = kind === 'simulators' ? booted.filter(s => !claims.some(c => isHeld(c, c.items.simulators?.[s.udid]?.at, now, holdMs))).map(s => s.name) : []

  for (const thing of found) {
    const { id } = thing
    const name = label(kind, id, me.items[kind]?.[id] ?? { ...thing, at: 0 })
    const fresh = claims.filter(c => isHeld(c, c.items[kind]?.[id]?.at, now, holdMs) && !told.has(`${kind}:${id}:${c.session}`))
    if (!fresh.length) continue
    for (const other of fresh) {
      told.add(`${kind}:${id}:${other.session}`)
      $.ui.toast(`${name} is also in use by ${who(other, me)}`, { timeoutMs: 8000 })
      await $.session.send({ to: { sessionId: other.session }, text: holderNote(me, kind, name) }).catch(() => undefined)
    }
    const text = selfNote(name, fresh.map(c => who(c, me)), free)
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
  }
}

async function refresh($: EngineInterface) {
  const me = await record($, 'ports', await served($), true)
  if (!me) return
  const now = await $.clock.now()
  const was = await read($, view)
  const isXcode = was?.isXcode ?? false
  const hasSims = Object.values(me.items.simulators ?? {}).some(s => now - s.at < holdMs)
  const [sims, claims] = await Promise.all([isXcode || hasSims ? bootedSims($) : Promise.resolve([]), others($, me.session)])
  await update($, view, () => ({ isXcode, booted: sims, others: claims }))
}

/** Tells every live session that shares an item with this one that this session has let it go. */
async function release($: EngineInterface, me: Claim) {
  const now = await $.clock.now()
  for (const other of await others($, me.session)) {
    const shared = Object.entries(me.items).flatMap(([kind, items]) =>
      Object.entries(items ?? {})
        .filter(([id, item]) => now - item.at < holdMs && isHeld(other, other.items[kind as Kind]?.[id]?.at, now, holdMs))
        .map(([id, item]) => label(kind as Kind, id, item)),
    )
    if (!shared.length) continue
    const text = `resource-watch: the ${me.project} session (${me.session}) has ended and is no longer using ${shared.join(', ')}.`
    await $.session.send({ to: { sessionId: other.session }, text }).catch(() => undefined)
  }
}

export const register: Register = (on, options) => {
  holdMs = (typeof options.hold === 'number' && options.hold > 0 ? options.hold : 10) * 60_000

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const [home, parent] = await Promise.all([
      $.process.run(['printenv', 'HOME']).catch(() => null),
      $.process.run(['sh', '-c', 'echo $PPID']).catch(() => null),
    ])
    if (!home?.stdout.trim()) return result
    dir = `${home.stdout.trim()}/.claude/resource-watch`
    root = await $.session.root()
    claudePid = findClaude(await psTable($), Number(parent?.stdout.trim()) || 0)
    const session = (await $.session.id()).replace(/[^\w-]/g, '')
    const kept = await read($, mine)
    if (kept?.session !== session) {
      await update($, mine, () => ({ session, project: root.split('/').pop() || root, at: 0, items: {} }))
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
      await save($, { ...me, at: 0, items: {} })
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined) return result
    const input = e as unknown as Record<string, unknown>
    const command = e.tool === 'Bash' ? String(input.command ?? '') : ''

    // After the call, so a simulator it just booted is in the list.
    const booted = SIM_COMMAND.test(command) || e.tool.startsWith('mcp__xcode__') ? await bootedSims($) : []
    for (const { kind, detect } of DETECTORS) {
      const found = detect({ tool: e.tool, input, booted, root })
      if (found.length && (await record($, kind, found))) await warn($, kind, found)
    }
    if (e.tool === 'mcp__claude-design__create_project' && typeof input.name === 'string') {
      const id = /"(?:project_)?id"\s*:\s*"([^"]+)"/.exec(JSON.stringify(result.result ?? ''))?.[1]
      if (id) await record($, 'designs', [{ id, name: clean(input.name) }])
    }
    // A port another session serves is warned about, not taken; what this session serves is found by the poll, or now for a background server.
    if (command) await warn($, 'ports', portsIn(command))
    if (input.run_in_background === true) await refresh($)

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
