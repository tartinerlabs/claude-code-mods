import { describe, expect, mock, test as it } from 'claude-code/testing'
import { parseBooted, rows, selfNote, simulatorsIn } from './hooks/register'

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

const run = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

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

describe('rows', () => {
  const me = { session: 'a', project: 'app', at: 0, simulators: {}, designs: { d1: { name: 'Onboarding', at: 0 } } }

  it('should show free simulators in an Xcode project and this session’s designs', () => {
    expect(rows({ isXcode: true, booted: [PRO], others: [] }, me, 1000, 60_000)).toEqual([
      { icon: '📱', label: 'iPhone 18 Pro (iOS 27.2)', status: 'free', color: 'gray' },
      { icon: '🎨', label: 'Onboarding', status: 'this session', color: 'green' },
    ])
  })

  it('should drop a claim from a session that stopped writing it', () => {
    const gone = { session: 'b', project: 'web', at: -10 * 60_000, simulators: { [PRO.udid]: { name: PRO.name, at: 0 } }, designs: {} }
    expect(rows({ isXcode: true, booted: [PRO], others: [gone] }, null, 1000, 60 * 60_000)[0]?.status).toBe('free')
  })
})

describe('selfNote', () => {
  it('should name the free simulators when there are some', () => {
    expect(selfNote('iPhone 18 Pro', ['the web session'], ['iPad Air'])).toMatch(/told you are using it\. If a reply asks you to wait, wait for its next message or work elsewhere; booted simulators no other session holds: iPad Air\.$/)
    expect(selfNote('Onboarding', ['another app session'], [])).toMatch(/work elsewhere\.$/)
  })
})

describe('simulator-watch', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    it(`should warn when another session already holds the simulator on ${surface}`, async ($, on) => {
      mock.clock(on, { now: 1_000_000 })
      const toasts: string[] = []
      const sent: { to: string; text: string }[] = []
      const session = mock.session(on)
      const written: Record<string, string> = {}
      const other = { session: 'other', project: 'web', at: 1_000_000, simulators: { [PRO.udid]: { name: PRO.name, at: 1_000_000 } }, designs: {} }
      on('session.start', ($, e) => ({ cwd: e.cwd }))
      on('session.id', () => ({ value: 'mine' }))
      on('session.root', () => ({ value: '/work/app' }))
      on('process.run', ($, e) => {
        if (e.argv[0] === 'printenv') return run('/home/me\n')
        if (e.argv[0] === 'git') return run('App.xcodeproj/project.pbxproj\n')

        return run(SIMCTL)
      })
      on('fs.list', () => ({ value: [{ name: 'other.json', kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }] }))
      on('fs.read', () => ({ value: JSON.stringify(other) }))
      on('fs.write', ($, e) => ((written[e.path] = e.text), { value: undefined }))
      on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
      on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
      on('session.send', ($, e) => (sent.push({ to: e.to, text: e.text }), { isDelivered: true as const }))
      on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'beneath' }))

      await $.session.start({ surface, isInteractive: true, cwd: '/work/app' })
      const ui = await $.ui.mount({ plugin: 'simulator-watch', surface, component: 'AbovePrompt', props: BAND })
      expect(await ui.find({ type: 'Text', text: '📱 iPhone 18 Pro (iOS 27.2) · web', props: { color: 'cyan' } })).toBeDefined()

      await $.tool.call({ tool: 'Bash', command: 'xcrun simctl launch booted com.example.app', description: 'Launch' })
      expect(toasts).toEqual(['iPhone 18 Pro is also in use by the web session'])
      expect(sent).toHaveLength(1)
      expect(sent[0]!.text).toMatch(/^simulator-watch: the app session \(mine\) has started using iPhone 18 Pro/)
      const note = session.appended().find(r => r.door === 'note')
      expect(JSON.stringify(note?.message.content)).toContain('iPhone 18 Pro is also in use by the web session, which has been told')

      // The same clash is told once.
      await $.tool.call({ tool: 'Bash', command: 'xcrun simctl launch booted com.example.app', description: 'Launch' })
      expect(sent).toHaveLength(1)
      expect(JSON.parse(written['/home/me/.claude/simulator-watch/mine.json']!).simulators[PRO.udid].name).toBe(PRO.name)
      expect(await ui.find({ type: 'Text', text: '📱 iPhone 18 Pro (iOS 27.2) · ⚠ also web', props: { color: 'yellow' } })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeDefined()
      await ui.unmount()
    })
  }
})
