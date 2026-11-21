/** One Vercel project's deployment of the watched commit, as its latest GitHub commit status says. */
export type Deploy = {
  /** The Vercel project, read from the status's inspector URL. */
  project: string
  state: 'pending' | 'success' | 'failure' | 'error'
  description: string
  /** The deployment's page in the Vercel dashboard. */
  url: string
}

/** The commit being followed and its deployments so far; null while nothing is followed. */
export type Watch = {
  sha: string
  branch: string
  startedAt: number
  deploys: Deploy[]
} | null

declare module 'claude-code' {
  interface PluginState {
    'vercel-watch': { watch: Watch }
  }
}
