/** How the pull request's checks stand: `failed` names the failing ones. */
export type Checks = { total: number; passed: number; pending: number; failed: string[] }

/** The open pull request for the current branch, as `gh pr view` last reported it. */
export type Pr = {
  number: number
  url: string
  isDraft: boolean
  mergeable: string
  mergeStateStatus: string
  checks: Checks
}

declare module 'claude-code' {
  interface PluginState {
    'pr-pilot': { pr: Pr | null }
  }
}
