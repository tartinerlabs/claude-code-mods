/** A booted simulator, as `xcrun simctl list devices booted -j` reports it. */
export type Sim = { udid: string; name: string; runtime: string }

/**
 * The shared things a session can hold. Simulators and Claude Design projects are the baseline; files
 * (by absolute path), ports (served by the session's own processes) and the Xcode app sit on top.
 */
export type Kind = 'simulators' | 'designs' | 'files' | 'ports' | 'xcode'

/** One held item, stamped with when it was last used. */
export type Item = { name: string; at: number }

/** One session's hold on shared things. */
export type Claim = {
  session: string
  /** The basename of the session's root, the label other sessions show. */
  project: string
  /** When the session last wrote its claim; a claim not rewritten for a while belongs to a session that is gone. */
  at: number
  items: Partial<Record<Kind, Record<string, Item>>>
}

/** What the band draws from: the booted simulators and every other live session's claim. */
export type View = { isXcode: boolean; booted: Sim[]; others: Claim[] }

declare module 'claude-code' {
  interface PluginState {
    'resource-watch': { view: View | null; mine: Claim | null }
  }
}
