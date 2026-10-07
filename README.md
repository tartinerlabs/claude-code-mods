# Claude Code Mods

Mods for [Claude Code](https://claude.com/claude-code) by Tartiner Labs: live panes, prompt bands, status line entries, toasts, and tool-call hooks, each shipped as a plugin.

## Mods

| Mod | What it does |
| --- | --- |
| [auto-session-name](plugins/auto-session-name) | Names each session from its first prompt using Haiku, so it is easy to find with `claude -r` after a crash. Sessions already named with `-n` or `/rename` are left alone. |
| [cache-clock](plugins/cache-clock) | Draws a countdown above the prompt to when the prompt cache goes cold, with the last request's hit rate and, once cold, how much the next turn re-writes. |

## Install

```
/plugin marketplace add tartinerlabs/claude-code-mods
/plugin install <mod> --marketplace tartinerlabs/claude-code-mods
```

## License

[MIT](LICENSE)
