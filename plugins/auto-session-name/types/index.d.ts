/** How far the mod has got naming this session. */
export type Naming = {
  /** Prompts from the person counted so far. */
  turns: number
  /** Their most recent prompts, oldest first, each trimmed. */
  prompts: string[]
  /** The last title this mod gave; null before it names the session. */
  title: string | null
  /** True once the title is final, or the session was named some other way. */
  isDone: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'auto-session-name': { naming: Naming }
  }
}
