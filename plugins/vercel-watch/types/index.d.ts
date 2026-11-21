/** One Vercel project's deployment of the watched commit, as its latest GitHub commit status says. */
export type Deploy = {
  /** The Vercel project, read from the status's inspector URL. */
  project: string
  state: 'pending' | 'success' | 'failure' | 'error'
  description: string
  /** The deployment's page in the Vercel dashboard; empty when the status named no such page. */
  url: string
}

/** The commit being followed and its deployments so far; null while nothing is followed. */
export type Watch = {
  /** Unique to this watch, so a poll that outlives it cannot change a newer one. */
  id: string
  sha: string
  branch: string
  startedAt: number
  deploys: Deploy[]
  /** Projects already toasted, so each finished deployment is reported once, as soon as it finishes. */
  reported: string[]
  /** Whether a deployment was seen still to finish; one already done before the push stays quiet. */
  isFresh: boolean
} | null

declare module 'claude-code' {
  interface PluginState {
    'vercel-watch': { watch: Watch }
  }
}
