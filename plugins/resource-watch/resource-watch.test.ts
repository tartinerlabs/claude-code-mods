import { describe, expect, mock, test as it } from 'claude-code/testing'
import { DETECTORS, findClaude, parseBooted, parsePs, portsIn, rows, selfNote, servedPorts, simulatorsIn } from './hooks/register'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const PRO = { udid: 'BA196662-63D7-4B7C-B5FE-B0EC7A336C04', name: 'iPhone 18 Pro', runtime: 'iOS 27.2' }
const MAX = { udid: 'C0FFEE00-0000-4000-8000-000000000001', name: 'iPhone 18 Pro Max', runtime: 'iOS 27.2' }

const SIMCTL = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-2': [{ udid: PRO.udid, name: PRO.name, state: 'Booted' }],
    'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [{ udid: 'W', name: 'Watch', state: 'Shutdown' }],
  },
})

// launchd, the terminal's shell, this session's claude with a dev server two levels down, and another claude's server.
const PS = ['    1     0 /sbin/launchd', '  500     1 -zsh', '  600   500 claude', '  700   600 /bin/zsh', '  710   700 node', '  800   500 claude', '  810   800 node'].join('\n')
const LSOF = ['p710', 'f20', 'n*:3000', 'f21', 'n[::1]:3000', 'p810', 'f20', 'n127.0.0.1:5173'].join('\n')

const run = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const detect = (kind: string, tool: string, input: Record<string, unknown>) =>
  DETECTORS.find(d => d.kind === kind)!.detect({ tool, input, booted: [PRO], root: '/work/app' })

describe('parseBooted', () => {
  it('should keep booted devices and read the runtime key', () => {
    expect(parseBooted(JSON.parse(SIMCTL))).toEqual([PRO])
  })
})

describe('simulatorsIn', () => {
  it('should match a simulator by UDID or by its longest name', () => {
    expect(simulatorsIn('Bash', { command: `xcrun simctl install ${PRO.udid} App.app` }, [PRO, MAX])).toEqual([PRO])
    expect(simulatorsIn('Bash', { command: "xcodebuild -destination 'name=iPhone 18 Pro Max' test" }, [PRO, MAX])).toEqual([MAX])
  })

  it('should take the only booted simulator for booted and for Xcode runs', () => {
    expect(simulatorsIn('Bash', { command: 'xcrun simctl openurl booted myapp://x' }, [PRO])).toEqual([PRO])
    expect(simulatorsIn('mcp__xcode__RunProject', {}, [PRO])).toEqual([PRO])
    expect(simulatorsIn('mcp__xcode__RunProject', {}, [PRO, MAX])).toEqual([])
  })

  it('should ignore commands that do not touch a simulator', () => {
    expect(simulatorsIn('Bash', { command: `echo ${PRO.name}` }, [PRO])).toEqual([])
  })
})

describe('detectors', () => {
  it('should take a file by its absolute path and name it inside the root', () => {
    expect(detect('files', 'Edit', { file_path: '/work/app/src/index.ts' })).toEqual([{ id: '/work/app/src/index.ts', name: 'src/index.ts' }])
    expect(detect('files', 'NotebookEdit', { notebook_path: '/elsewhere/a.ipynb' })).toEqual([{ id: '/elsewhere/a.ipynb', name: '/elsewhere/a.ipynb' }])
    expect(detect('files', 'Read', { file_path: '/work/app/src/index.ts' })).toEqual([])
  })

  it('should take the Xcode app on calls that change its state and leave reads alone', () => {
    expect(detect('xcode', 'mcp__xcode__XcodeSwitchScheme', { scheme: 'App' })).toEqual([{ id: 'Xcode', name: 'the Xcode app' }])
    expect(detect('xcode', 'mcp__xcode__BuildProject', {})).toHaveLength(1)
    expect(detect('xcode', 'mcp__xcode__XcodeRead', { path: 'a.swift' })).toEqual([])
  })

  it('should take a Claude Design project by its id', () => {
    expect(detect('designs', 'mcp__claude-design__render_preview', { project_id: 'p1', path: 'a.html' })).toEqual([{ id: 'p1', name: '' }])
  })
})

describe('ports', () => {
  it('should read the ports a command names', () => {
    expect(portsIn('PORT=4000 pnpm dev && curl -s localhost:3000/api --port=8080').map(p => p.id)).toEqual(['4000', '3000', '8080'])
    expect(portsIn('mkdir -p 3000 && git log -n 3000')).toEqual([])
  })

  it('should find this session among its ancestors and keep only the ports it serves', () => {
    const table = parsePs(PS)
    expect(findClaude(table, 700)).toBe(600)
    expect(findClaude(table, 600)).toBe(600)
    expect(servedPorts(LSOF, table, 600)).toEqual([{ id: '3000', name: 'localhost:3000' }])
  })
})

describe('rows', () => {
  const me = { session: 'a', project: 'app', at: 0, items: { designs: { d1: { name: 'Onboarding', at: 0 } }, files: { '/work/app/a.ts': { name: 'a.ts', at: 0 } } } }

  it('should show free simulators in an Xcode project and this session’s designs, and hide files nobody shares', () => {
    expect(rows({ isXcode: true, booted: [PRO], others: [] }, me, 1000, 60_000)).toEqual([
      { icon: '📱', label: 'iPhone 18 Pro (iOS 27.2)', status: 'free', color: 'gray' },
      { icon: '🎨', label: 'Onboarding', status: 'this session', color: 'green' },
    ])
  })

  it('should show a file once another session edits it too', () => {
    const other = { session: 'b', project: 'app', at: 1000, items: { files: { '/work/app/a.ts': { name: 'a.ts', at: 900 } } } }
    expect(rows({ isXcode: false, booted: [], others: [other] }, me, 1000, 60_000)).toContainEqual({ icon: '📄', label: 'a.ts', status: '⚠ also another app session', color: 'yellow' })
  })

  it('should drop a claim from a session that stopped writing it', () => {
    const gone = { session: 'b', project: 'web', at: -10 * 60_000, items: { simulators: { [PRO.udid]: { name: PRO.name, at: 0 } } } }
    expect(rows({ isXcode: true, booted: [PRO], others: [gone] }, null, 1000, 60 * 60_000)[0]?.status).toBe('free')
  })
})

describe('selfNote', () => {
  it('should name the free simulators when there are some', () => {
    expect(selfNote('iPhone 18 Pro', ['the web session'], ['iPad Air'])).toMatch(/told you are using it\. If a reply asks you to wait, wait for its next message or work elsewhere; booted simulators no other session holds: iPad Air\.$/)
    expect(selfNote('Onboarding', ['another app session'], [])).toMatch(/work elsewhere\.$/)
  })
})

/** Stands in for the machine: HOME, this session's claude at 600, the booted iPhone, an Xcode project and the listening ports. */
const machine = ($: unknown, e: { argv: readonly string[] }) => {
  const [cmd] = e.argv
  if (cmd === 'printenv') return run('/home/me\n')
  if (cmd === 'sh') return run('600\n')
  if (cmd === 'ps') return run(PS)
  if (cmd === 'lsof') return run(LSOF)
  if (cmd === 'git') return run('App.xcodeproj/project.pbxproj\n')

  return run(SIMCTL)
}

describe('resource-watch', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    it(`should warn when another session already holds the simulator on ${surface}`, async ($, on) => {
      mock.clock(on, { now: 1_000_000 })
      const toasts: string[] = []
      const sent: { to: string; text: string }[] = []
      const session = mock.session(on)
      const written: Record<string, string> = {}
      const other = { session: 'other', project: 'web', at: 1_000_000, items: { simulators: { [PRO.udid]: { name: PRO.name, at: 1_000_000 } } } }
      on('session.start', ($, e) => ({ cwd: e.cwd }))
      on('session.id', () => ({ value: 'mine' }))
      on('session.root', () => ({ value: '/work/app' }))
      on('process.run', machine)
      on('fs.list', () => ({ value: [{ name: 'other.json', kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }] }))
      on('fs.read', () => ({ value: JSON.stringify(other) }))
      on('fs.write', ($, e) => ((written[e.path] = e.text), { value: undefined }))
      on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
      on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
      on('session.send', ($, e) => (sent.push({ to: e.to, text: e.text }), { isDelivered: true as const }))
      on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'beneath' }))

      await $.session.start({ surface, isInteractive: true, cwd: '/work/app' })
      const ui = await $.ui.mount({ plugin: 'resource-watch', surface, component: 'AbovePrompt', props: BAND })
      expect(await ui.find({ type: 'Text', text: '📱 iPhone 18 Pro (iOS 27.2) · the web session', props: { color: 'cyan' } })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '🔌 localhost:3000 · this session', props: { color: 'green' } })).toBeDefined()

      await $.tool.call({ tool: 'Bash', command: 'xcrun simctl launch booted com.example.app', description: 'Launch' })
      expect(toasts).toEqual(['iPhone 18 Pro is also in use by the web session'])
      expect(sent).toHaveLength(1)
      expect(sent[0]!.text).toMatch(/^resource-watch: the app session \(mine\) has started using iPhone 18 Pro, which you are also using\./)
      const note = session.appended().find(r => r.door === 'note')
      expect(JSON.stringify(note?.message.content)).toContain('iPhone 18 Pro is also in use by the web session, which has been told')
      expect(JSON.parse(written['/home/me/.claude/resource-watch/mine.json']!).items.simulators[PRO.udid].name).toBe(PRO.name)
      expect(await ui.find({ type: 'Text', text: '📱 iPhone 18 Pro (iOS 27.2) · ⚠ also the web session', props: { color: 'yellow' } })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeDefined()

      // The same clash is told once.
      await $.tool.call({ tool: 'Bash', command: 'xcrun simctl launch booted com.example.app', description: 'Launch' })
      expect(sent).toHaveLength(1)
      await ui.unmount()
    })
  }

  it('should tell the session serving a port another session uses', async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    const sent: string[] = []
    const other = { session: 'other', project: 'web', at: 1_000_000, items: { ports: { '5173': { name: 'localhost:5173', at: 1_000_000 } } } }
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 'mine' }))
    on('session.root', () => ({ value: '/work/app' }))
    on('process.run', machine)
    on('fs.list', () => ({ value: [{ name: 'other.json', kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }] }))
    on('fs.read', () => ({ value: JSON.stringify(other) }))
    on('fs.write', () => ({ value: undefined }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
    on('ui.toast', () => ({ value: undefined }))
    on('session.send', ($, e) => (sent.push(e.text), { isDelivered: true as const }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })
    await $.tool.call({ tool: 'Bash', command: 'curl -s localhost:5173/', description: 'Fetch' })
    expect(sent).toEqual([expect.stringMatching(/has started using localhost:5173, which you are serving\./)])
  })

  it('should tell the sessions it shared a file with when it ends', async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    const sent: string[] = []
    const other = { session: 'other', project: 'app', at: 1_000_000, items: { files: { '/work/app/a.ts': { name: 'a.ts', at: 1_000_000 } } } }
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 'mine' }))
    on('session.root', () => ({ value: '/work/app' }))
    on('process.run', machine)
    on('fs.list', () => ({ value: [{ name: 'other.json', kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }] }))
    on('fs.read', () => ({ value: JSON.stringify(other) }))
    on('fs.write', () => ({ value: undefined }))
    on('tool.call', { tool: 'Edit' }, () => ({ result: {}, text: 'ok' }))
    on('ui.toast', () => ({ value: undefined }))
    on('session.send', ($, e) => (sent.push(e.text), { isDelivered: true as const }))
    on('session.end', () => ({ sessionId: 'mine' }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/app/a.ts', old_string: 'a', new_string: 'b' })
    expect(sent).toEqual([expect.stringMatching(/has started using a\.ts, which you have also been editing\./)])
    await $.session.end({ reason: 'other' })
    expect(sent[1]).toBe('resource-watch: the app session (mine) has ended and is no longer using a.ts.')
  })
})
