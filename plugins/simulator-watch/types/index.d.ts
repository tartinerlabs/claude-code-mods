/** A booted simulator, as `xcrun simctl list devices booted -j` reports it. */
export type Sim = { udid: string; name: string; runtime: string }

/** One session's hold on simulators and Claude Design projects, each stamped with when it was last used. */
export type Claim = {
  session: string
  /** The basename of the session's root, the label other sessions show. */
  project: string
  /** When the session last wrote its claim; a claim not rewritten for a while belongs to a session that is gone. */
  at: number
  simulators: Record<string, { name: string; at: number }>
  designs: Record<string, { name?: string; at: number }>
}

/** What the band draws from: the booted simulators and every other live session's claim. */
export type View = { isXcode: boolean; booted: Sim[]; others: Claim[] }

declare module 'claude-code' {
  interface PluginState {
    'simulator-watch': { view: View | null; mine: Claim | null }
  }
}
