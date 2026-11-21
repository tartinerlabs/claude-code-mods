import { describe, expect, mock, test as it } from 'claude-code/testing'

import { backoff, resetFromMessage } from './hooks/register'

const NOW = Date.parse('2026-10-07T10:00:00Z')
const RESET = '2026-10-07T12:00:00Z'
const TWO_HOURS = 2 * 60 * 60_000
const EXHAUSTED = [
  { kind: 'five_hour', percentUsed: 100, resetsAt: RESET },
  { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-10-10T00:00:00Z' },
]

describe('auto-resume', () => {
  it('should send continue a minute after the exhausted window resets', async ($, on) => {
    // Hooks registered here sit beneath the mod and stand in for Claude Code.
    const clock = mock.clock(on, { now: NOW })
    const sent: string[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: undefined }))
    on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: EXHAUSTED } }))
    on('classic.StopFailure', () => ({}))
    on('prompt.submit', ($, e) => (sent.push(e.text), e))
    const status: (string | undefined)[] = []
    on('ui.status', ($, e) => (status.push(e.text), { value: undefined }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.classic.StopFailure({ error: 'rate_limit' })
    expect((await $.command.run({ command: 'auto-resume' })).text).toBe('Resuming in 2h 1m.')
    expect(status.at(-1)).toBe('⏸ auto-resume in 2:01:00')

    await clock.advance(1000)
    expect(status.at(-1)).toBe('⏸ auto-resume in 2:00:59')
    await clock.advance(TWO_HOURS - 1000)
    expect(status.at(-1)).toBe('⏸ auto-resume in 1:00')
    expect(sent).toEqual([])
    await clock.advance(60_000)
    expect(sent).toEqual(['continue'])
    expect(status.at(-1)).toBeUndefined()
    expect((await $.command.run({ command: 'auto-resume' })).text).toBe('No resume pending.')
  })

  it('should ignore other API errors', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const sent: string[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: undefined }))
    on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: EXHAUSTED } }))
    on('classic.StopFailure', () => ({}))
    on('prompt.submit', ($, e) => (sent.push(e.text), e))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.classic.StopFailure({ error: 'overloaded' })
    await clock.advance(TWO_HOURS * 10)
    expect(sent).toEqual([])
  })

  it('should retry after five minutes when no window says when it resets', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const sent: string[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: undefined }))
    on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
    on('classic.StopFailure', () => ({}))
    on('prompt.submit', ($, e) => (sent.push(e.text), e))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.classic.StopFailure({ error: 'rate_limit' })
    await clock.advance(5 * 60_000)
    expect(sent).toEqual(['continue'])
  })

  it('should stop a pending resume on /auto-resume cancel', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const sent: string[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: undefined }))
    on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: EXHAUSTED } }))
    on('classic.StopFailure', () => ({}))
    on('prompt.submit', ($, e) => (sent.push(e.text), e))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.classic.StopFailure({ error: 'rate_limit' })
    expect((await $.command.run({ command: 'auto-resume', args: 'cancel' })).text).toBe('Auto-resume cancelled.')
    await clock.advance(TWO_HOURS * 2)
    expect(sent).toEqual([])
  })

  it('should try again five minutes later when sending continue fails', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const sent: string[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: undefined }))
    on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
    on('classic.StopFailure', () => ({}))
    on('prompt.submit', ($, e) => {
      sent.push(e.text)
      if (sent.length === 1) throw new Error('refused')

      return e
    })

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.classic.StopFailure({ error: 'rate_limit' })
    await clock.advance(5 * 60_000)
    expect(sent).toEqual(['continue'])
    expect((await $.command.run({ command: 'auto-resume' })).text).toBe('Resuming in 5m.')
    await clock.advance(5 * 60_000)
    expect(sent).toEqual(['continue', 'continue'])
  })

  it('should wait for a limit the windows do not report, read from its message', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const sent: string[] = []
    // A model's own limit: the 5-hour and weekly windows are not used up.
    const windows = [{ kind: 'five_hour', percentUsed: 30, resetsAt: RESET }]
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: undefined }))
    on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: windows } }))
    on('classic.StopFailure', () => ({}))
    on('prompt.submit', ($, e) => (sent.push(e.text), e))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    // 10:00 UTC is 18:00 in Singapore, so 8pm is two hours away.
    await $.classic.StopFailure({ error: 'rate_limit', last_assistant_message: "You've hit your Opus limit · resets 8pm (Asia/Singapore). /model to switch models." })
    expect((await $.command.run({ command: 'auto-resume' })).text).toBe('Resuming in 2h 1m.')
    await clock.advance(TWO_HOURS)
    expect(sent).toEqual([])
    await clock.advance(60_000)
    expect(sent).toEqual(['continue'])
  })

  it('should wait longer after each retry that still hits an unreadable limit', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const sent: string[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: undefined }))
    on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
    on('classic.StopFailure', () => ({}))
    on('prompt.submit', ($, e) => (sent.push(e.text), e))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.classic.StopFailure({ error: 'rate_limit', last_assistant_message: 'Limit reached.' })
    await clock.advance(5 * 60_000)
    expect(sent).toEqual(['continue'])

    // The continue hits the same limit.
    await $.classic.StopFailure({ error: 'rate_limit', last_assistant_message: 'Limit reached.' })
    expect((await $.command.run({ command: 'auto-resume' })).text).toBe('Resuming in 10m.')
    await clock.advance(5 * 60_000)
    expect(sent).toEqual(['continue'])
    await clock.advance(5 * 60_000)
    expect(sent).toEqual(['continue', 'continue'])
  })
})

describe('auto-resume backoff', () => {
  it("should start a later limit at five minutes once the person's own prompt follows a resume", async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const sent: string[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: undefined }))
    on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
    on('classic.StopFailure', () => ({}))
    on('prompt.submit', ($, e) => (sent.push(e.text), e))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.classic.StopFailure({ error: 'rate_limit', last_assistant_message: 'Limit reached.' })
    await clock.advance(5 * 60_000)
    expect(sent).toEqual(['continue'])

    // The resumed turn ran; later the person types, and another limit hits.
    await $.prompt.submit({ text: 'next task', origin: { kind: 'composer' } } as never)
    await $.classic.StopFailure({ error: 'rate_limit', last_assistant_message: 'Limit reached.' })
    expect((await $.command.run({ command: 'auto-resume' })).text).toBe('Resuming in 5m.')
  })
})

describe('resetFromMessage', () => {
  // 18:00 on 7 Oct in Singapore, 06:00 in New York (EDT).
  const now = NOW

  it('should read a time later today in the named zone', () => {
    expect(resetFromMessage("You've hit your 5-hour limit · resets 11:50pm (Asia/Singapore)", now)).toBe(Date.parse('2026-10-07T15:50:00Z'))
  })

  it('should read a time already past today as tomorrow', () => {
    expect(resetFromMessage("You've hit your weekly limit · resets 4pm (Asia/Singapore)", now)).toBe(Date.parse('2026-10-08T08:00:00Z'))
  })

  it('should read a date and time for any limit name', () => {
    expect(
      resetFromMessage("You've hit your Fable limit · resets Nov 25 at 4pm (Asia/Singapore). Switch to another model to continue.", now),
    ).toBe(Date.parse('2026-11-25T08:00:00Z'))
  })

  it('should read a date behind now as next year', () => {
    expect(resetFromMessage("You've hit your Fable limit · resets Jan 2 at 9am (Asia/Singapore)", now)).toBe(Date.parse('2027-01-02T01:00:00Z'))
  })

  it("should follow the zone's daylight saving offset", () => {
    expect(resetFromMessage("You've hit your session limit · resets 9am (America/New_York)", now)).toBe(Date.parse('2026-10-07T13:00:00Z'))
    expect(resetFromMessage("You've hit your session limit · resets Dec 1 at 9am (America/New_York)", now)).toBe(Date.parse('2026-12-01T14:00:00Z'))
  })

  it('should take the second of a time the clocks repeat when the first has passed', () => {
    // 06:10 UTC on 1 Nov is 1:10am EST, after the first 1:30am (05:30 UTC, EDT) and before the second.
    const fallBack = Date.parse('2026-11-01T06:10:00Z')
    expect(resetFromMessage("You've hit your 5-hour limit · resets 1:30am (America/New_York)", fallBack)).toBe(Date.parse('2026-11-01T06:30:00Z'))
    expect(resetFromMessage("You've hit your 5-hour limit · resets 1:30am (America/New_York)", Date.parse('2026-11-01T05:10:00Z'))).toBe(
      Date.parse('2026-11-01T05:30:00Z'),
    )
  })

  it('should read a time the clocks skip with the offset before the change', () => {
    // 2:30am on 8 Mar does not exist in New York; read as EST it is 07:30 UTC, 3:30am EDT.
    expect(resetFromMessage("You've hit your 5-hour limit · resets Mar 8 at 2:30am (America/New_York)", Date.parse('2027-03-08T05:00:00Z'))).toBe(
      Date.parse('2027-03-08T07:30:00Z'),
    )
  })

  it('should read 12am as midnight and 12pm as noon', () => {
    expect(resetFromMessage("You've hit your 5-hour limit · resets 12:20am (Asia/Singapore)", now)).toBe(Date.parse('2026-10-07T16:20:00Z'))
    expect(resetFromMessage("You've hit your 5-hour limit · resets Oct 8 at 12pm (Asia/Singapore)", now)).toBe(Date.parse('2026-10-08T04:00:00Z'))
  })

  it('should give nothing for a message without a reset or with an unknown zone', () => {
    expect(resetFromMessage('Limit reached.', now)).toBeNull()
    expect(resetFromMessage("You've hit your limit · resets 4pm (Mars/Olympus)", now)).toBeNull()
  })
})

describe('backoff', () => {
  it('should double from five minutes up to an hour', () => {
    expect([0, 1, 2, 3, 4, 5].map(backoff)).toEqual([5, 10, 20, 40, 60, 60].map(m => m * 60_000))
  })
})
