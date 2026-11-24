import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Checkpoint, SmartCompactTurn, TurnDigest } from '../types'

const TICK_MS = 15_000
// Leave the person a moment to type a follow-up before compacting under them.
const SETTLE_MS = 10_000
// Points of context fill the conversation must gain after any compaction, Claude Code's own
// included, before the decider is asked again: measured in growth, not time.
const MIN_GROWTH = 20
const DECIDER_TIMEOUT_MS = 20_000
const CONTINUE_PROMPT = 'Continue with the remaining tasks.'
// Tools that change files: after one, the work a checkpoint marked is no longer the last word.
const EDITING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const MAX_TOOLS = 15

// Claude Code compacts on its own when the context fills and after an hour idle,
// so this mod compacts only where those cannot tell: a piece of work just finished.
const DECIDER_SYSTEM = `You decide whether a Claude Code session should compact its conversation now, between turns.
Compacting replaces the conversation with a summary: the next turn starts lighter, but detail of the work so far is lost.
Compact only at a clean break: the last turn finished a piece of work (a commit, a pull request, an approved plan, a finished todo list, a fix confirmed) and what comes next is unlikely to need its detail.
An approved plan is a clean break even before building starts, since Claude Code keeps the plan after compacting.
Wait when the work is midway, an error or failing test is still open, or open todos carry on the same work.
Wait when the reply asks the person to choose or decide something it needs answered; a reply that only offers to go on ("when you say go", "anything else?") is not waiting on an answer.
Wait after an explanation, review or investigation that nothing has acted on yet: follow-up questions lean on what was read.
When unsure, wait.
Answer with one line only: "compact: <reason in under 8 words>" or "wait: <reason in under 8 words>".`

const CHECKPOINTS: Record<Checkpoint, { reason: string; instructions: string }> = {
  commit: {
    reason: 'committed',
    instructions:
      'The work so far was just committed. Say in a line or two what the commit holds, and keep open follow-ups, decisions and anything not yet committed.',
  },
  pr: {
    reason: 'PR opened',
    instructions:
      'A pull request was just opened. Keep its number, branch and what reviewers should know; summarise the rest briefly.',
  },
  merge: {
    reason: 'PR merged',
    instructions: 'A pull request was just merged. Keep its number and any follow-ups; summarise the rest briefly.',
  },
  plan: {
    reason: 'plan approved',
    instructions:
      'A plan was just approved. Claude Code puts the plan back after compacting, so do not repeat it; summarise in a few lines how it was reached and keep any decision or constraint it leaves out.',
  },
  todos: {
    reason: 'todos done',
    instructions: 'Every task on the todo list is done. Summarise what was done briefly and keep anything left open.',
  },
  switch: {
    reason: 'switched task',
    instructions:
      'The session moved to another branch or worktree. Summarise the earlier work briefly and keep what the new task needs.',
  },
}

// Held by the host, so a hot reload mid-turn still knows a turn is running.
const turn = atom({ plugin: 'smart-compact', key: 'turn' } as const, { isBusy: false, endedAt: null } as SmartCompactTurn)
// The last checkpoint the current or just-ended turn reached, while no file was edited after it.
const checkpoint = atom({ plugin: 'smart-compact', key: 'checkpoint' } as const, null as Checkpoint | null)
// Task ids made with TaskCreate and not yet completed or deleted.
const openTasks = atom({ plugin: 'smart-compact', key: 'openTasks' } as const, [] as readonly string[])
// Items not yet completed on the latest TodoWrite list.
const openTodos = atom({ plugin: 'smart-compact', key: 'openTodos' } as const, 0)
const digest = atom({ plugin: 'smart-compact', key: 'digest' } as const, { prompt: '', answer: '', tools: [] } as TurnDigest)
// The context fill first read after the last compaction, by anyone; null until that reading.
const baseline = atom({ plugin: 'smart-compact', key: 'baseline' } as const, 0 as number | null)

export type Gate = { percent: number; floor: number; fiveHourPercent?: number; baseline: number | null }

export type Verdict = { compact: boolean; reason: string }

export const register: Register = (on, options) => {
  const floor = Number(options.floor ?? 40)
  const model = options.decider === 'sonnet' ? 'sonnet' : 'haiku'
  const isContinuing = options.continue === 'tasks'
  let isCompacting = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)

    $.clock.every(TICK_MS, async () => {
      const state = await read($, turn)

      if (isCompacting || state.isBusy || state.endedAt === null) {
        return
      }

      const now = await $.clock.now()

      if (now - state.endedAt < SETTLE_MS || (await draft($)).trim() !== '') {
        return
      }

      const { context, rateLimits } = await $.session.usage()

      // No reading until the first response after a start or a compaction.
      if (context.percent === undefined) {
        return
      }

      const fiveHour = rateLimits.find(limit => limit.kind === 'five_hour')
      const isWorthAsking = shouldAsk({
        percent: context.percent,
        floor,
        fiveHourPercent: fiveHour?.percentUsed,
        baseline: await read($, baseline),
      })

      if (!isWorthAsking) {
        return
      }

      isCompacting = true

      try {
        const reached = await read($, checkpoint)
        const openCount = (await read($, openTasks)).length + (await read($, openTodos))
        const reply = await $.model.complete({
          model,
          system: DECIDER_SYSTEM,
          prompt: digestText({ ...(await read($, digest)), percent: context.percent, checkpoint: reached, openCount }),
          effort: 'low',
          maxTokens: 200,
          timeoutMs: DECIDER_TIMEOUT_MS,
        })
        const verdict = reply.isAnswered ? parseVerdict(reply.text) : null

        // No answer, a wait, or a follow-up typed while it thought: leave the session be.
        if (!verdict?.compact || (await draft($)).trim() !== '') {
          return
        }

        const instructions = reached
          ? CHECKPOINTS[reached].instructions
          : `The work just reached a break (${verdict.reason}). Summarise the finished work briefly and keep what is still open.`
        const compacted = await $.session.compact({ instructions })

        if (!('skip' in compacted && compacted.skip !== undefined)) {
          // Its own call does not pass through its own session.compact hook.
          await update($, baseline, () => null)

          if (isContinuing && state.canContinue && openCount > 0) {
            $.ui.toast(`Compacted at ${context.percent}%: ${verdict.reason}; continuing`)
            await $.prompt.submit({ text: CONTINUE_PROMPT })
          } else {
            $.ui.toast(`Compacted at ${context.percent}%: ${verdict.reason}`)
          }
        }
      } catch {
        // A turn started between the check and the call; try again once it ends.
      } finally {
        isCompacting = false
        // One decision per idle stretch: the next one waits for the next turn to end.
        await update($, turn, state => ({ ...state, endedAt: null }))
        await update($, checkpoint, () => null)
      }
    })

    return result
  })

  // Every compaction restarts the growth count, Claude Code's own included.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)

    if (!e.agentId && e.trigger !== 'precompute' && !('skip' in result && result.skip !== undefined)) {
      await update($, baseline, () => null)
    }

    return result
  })

  on('turn.start', async ($, e, next) => {
    await update($, turn, state => ({ ...state, isBusy: true }))
    // A checkpoint counts for the idle stretch after its own turn alone.
    await update($, checkpoint, () => null)

    if (!e.agentId) {
      await update($, digest, () => ({ prompt: e.text, answer: '', tools: [] }))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // Main loop only: a subagent's turn ending leaves the session busy.
    if (!e.agentId) {
      const endedAt = await $.clock.now()
      // Stopped by the person, or waiting on their answer: not ours to carry on.
      const canContinue = !e.isAborted && !e.answer.trimEnd().endsWith('?')
      await update($, turn, () => ({ isBusy: false, endedAt, canContinue }))
      await update($, digest, state => ({ ...state, answer: e.answer }))

      // The first reading after a compaction, which arrives with the first response after it.
      if ((await read($, baseline)) === null) {
        const { context } = await $.session.usage()

        if (context.percent !== undefined) {
          await update($, baseline, () => context.percent ?? null)
        }
      }
    }

    return result
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    // A subagent's commits and plans are its own; a failed call reaches nothing.
    if (e.agentId || ran.deny !== undefined || ran.isError === true) {
      return ran
    }

    const detail = e.tool === 'Bash' ? e.command : 'file_path' in e ? String(e.file_path) : ''
    const line = detail ? `${e.tool}: ${detail.slice(0, 120)}` : e.tool
    await update($, digest, state => ({ ...state, tools: [...state.tools, line].slice(-MAX_TOOLS) }))

    if (EDITING_TOOLS.has(e.tool)) {
      await update($, checkpoint, () => null)

      return ran
    }

    let reached: Checkpoint | null = null

    if (e.tool === 'Bash') {
      reached = bashCheckpoint(e.command)
    } else if (e.tool === 'ExitPlanMode') {
      reached = 'plan'
    } else if (e.tool === 'EnterWorktree' || e.tool === 'ExitWorktree') {
      reached = 'switch'
    } else if (e.tool === 'TodoWrite') {
      await update($, openTodos, () => e.todos.filter(todo => todo.status !== 'completed').length)
      reached = areAllDone(e.todos) ? 'todos' : null
    } else if (e.tool === 'TaskCreate') {
      const created = ran.result as { task?: { id?: string } }
      const id = created.task?.id

      if (id) {
        await update($, openTasks, ids => [...ids, id])
      }
    } else if (e.tool === 'TaskUpdate' && (e.status === 'completed' || e.status === 'deleted')) {
      const before = await read($, openTasks)
      const after = before.filter(id => id !== e.taskId)
      await update($, openTasks, () => after)
      reached = e.status === 'completed' && before.length > 0 && after.length === 0 ? 'todos' : null
    }

    if (reached) {
      await update($, checkpoint, () => reached)
    }

    return ran
  }).catch(($, e, next) => next(e)) // Only watches: a fault here must never cost the call.
}

// The prompt box's draft; empty where the session draws none or the read fails.
async function draft($: { prompt: { read: () => Promise<{ text: string }> } }) {
  try {
    return (await $.prompt.read()).text
  } catch {
    return ''
  }
}

// The cheap checks before spending a model call: enough context to be worth it,
// 10 points less while the 5-hour limit runs low, and enough grown since the last compaction.
export function shouldAsk({ percent, floor, fiveHourPercent, baseline }: Gate) {
  const minimum = fiveHourPercent !== undefined && fiveHourPercent >= 80 ? floor - 10 : floor

  return percent >= minimum && baseline !== null && percent - baseline >= MIN_GROWTH
}

export function digestText(input: TurnDigest & { percent: number; checkpoint: Checkpoint | null; openCount: number }) {
  return [
    `Context: ${input.percent}% full`,
    `Checkpoint seen: ${input.checkpoint ? CHECKPOINTS[input.checkpoint].reason : 'none'}`,
    `Open todos or tasks: ${input.openCount}`,
    '',
    'The person asked:',
    input.prompt.slice(0, 1500),
    '',
    'Tools the turn ran:',
    ...(input.tools.length > 0 ? input.tools.map(tool => `- ${tool}`) : ['- none']),
    '',
    'The reply ended:',
    input.answer.slice(-2000),
  ].join('\n')
}

// Reads "compact: reason" or "wait: reason"; anything else is no answer.
export function parseVerdict(text: string): Verdict | null {
  const match = /^\W*(compact|wait)\b\W*(.*)$/im.exec(text.trim())

  const word = match?.[1]?.toLowerCase()
  const reason = match?.[2]?.trim() ?? ''

  // "compact: wait: ..." names both: no answer, so the session is left be.
  if (!word || /^(?:compact|wait)\b/i.test(reason)) {
    return null
  }

  return { compact: word === 'compact', reason: reason || word }
}

export function bashCheckpoint(command: string): Checkpoint | null {
  if (/\bgh\s+(?:pr|stack)\s+merge\b/.test(command)) {
    return 'merge'
  }

  if (/\bgh\s+(?:pr\s+create|stack\s+submit)\b/.test(command)) {
    return 'pr'
  }

  if (/\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(command)) {
    return 'commit'
  }

  // `git checkout -- file` and `git checkout .` restore files; they do not move branch.
  if (/\bgit\s+(?:-C\s+\S+\s+)?(?:switch|checkout)\s+(?!--(?:\s|$)|\.(?:\s|$))\S/.test(command)) {
    return 'switch'
  }

  return null
}

export function areAllDone(todos: readonly { status: string }[]) {
  return todos.length > 0 && todos.every(todo => todo.status === 'completed')
}
