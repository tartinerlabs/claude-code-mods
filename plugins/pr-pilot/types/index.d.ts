/** How the pull request's checks stand: `failed` names the failing ones. */
export type Checks = { total: number; passed: number; pending: number; failed: string[] }

/** The unmerged layers of a gh-stack stack, bottom first, and where the current branch sits among them. */
export type Stack = { position: number; total: number; layers: { branch: string; pr?: number }[] }

/** The open pull request for the current branch, as `gh pr view` last reported it. */
export type Pr = {
  number: number
  url: string
  /** The head commit the checks ran on. */
  head: string
  isDraft: boolean
  mergeable: string
  mergeStateStatus: string
  checks: Checks
  /** Set when the branch is a layer of a gh-stack stack. */
  stack?: Stack
}

declare module 'claude-code' {
  interface PluginState {
    'pr-pilot': { pr: Pr | null }
  }
}
