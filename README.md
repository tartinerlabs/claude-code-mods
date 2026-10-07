# Claude Code Mods

Mods for [Claude Code](https://claude.com/claude-code) by Tartiner Labs: live panes, prompt bands, status line entries, toasts, and tool-call hooks, each shipped as a plugin.

## Mods

| Mod | What it does |
| --- | --- |
| [auto-resume](plugins/auto-resume) | When a turn stops on a usage limit, waits until the limit resets and sends `continue`. The wait shows in the status line, and `/auto-resume cancel` stops it. Typing a prompt yourself also cancels it. |
| [auto-session-name](plugins/auto-session-name) | Names each session from its first prompt using Haiku, so it is easy to find with `claude -r` after a crash. Sessions already named with `-n` or `/rename` are left alone. |
| [cache-clock](plugins/cache-clock) | Draws a countdown above the prompt to when the prompt cache goes cold, with the last request's hit rate and, once cold, how much the next turn re-writes. |
| [limit-watch](plugins/limit-watch) | Draws the 5-hour and weekly usage limits above the prompt with live reset countdowns, each green under 60%, yellow to 80% and red past it, and toasts once a window passes 80% and again at 95%. Any other window the API reports, such as a gateway spend limit, shows under its own name. |

## Install

```
/plugin marketplace add tartinerlabs/claude-code-mods
/plugin install <mod> --marketplace tartinerlabs/claude-code-mods
```

## License

[MIT](LICENSE)
