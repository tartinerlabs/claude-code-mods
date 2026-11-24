export type SmartCompactTurn = { isBusy: boolean; endedAt: number | null; canContinue?: boolean }

export type Checkpoint = 'commit' | 'pr' | 'merge' | 'plan' | 'todos' | 'switch'

// What the decider reads about the last turn: the prompt, the reply's end and the tools it ran.
export type TurnDigest = { prompt: string; answer: string; tools: readonly string[] }

declare module 'claude-code' {
  interface PluginState {
    'smart-compact': {
      turn: SmartCompactTurn
      checkpoint: Checkpoint | null
      openTasks: readonly string[]
      openTodos: number
      digest: TurnDigest
      baseline: number | null
    }
  }
}
