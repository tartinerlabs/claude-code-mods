<div align="center">

# 🧩 Claude Code Mods

**Live panes, prompt bands, status line entries, toasts, and hooks for [Claude Code](https://claude.com/claude-code)**, each shipped as a plugin.

[![Release](https://img.shields.io/github/v/release/tartinerlabs/claude-code-mods?style=flat-square&color=d97757)](https://github.com/tartinerlabs/claude-code-mods/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/tartinerlabs/claude-code-mods/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/tartinerlabs/claude-code-mods/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

</div>

## 🚀 Install

```
/plugin marketplace add tartinerlabs/claude-code-mods
/plugin install <mod> --marketplace tartinerlabs/claude-code-mods
```

## 🧰 Mods

| | Mod | Where it shows | In one line |
| :-: | --- | --- | --- |
| ⏸ | [auto-resume](#-auto-resume) | Status line, toast | Picks a turn back up once a usage limit resets |
| 🏷 | [auto-session-name](#-auto-session-name) | Session title | Names each session from its first prompt |
| ⏱ | [cache-clock](#-cache-clock) | Band above the prompt | Counts down to the prompt cache going cold |
| 📊 | [limit-watch](#-limit-watch) | Band above the prompt, toasts | Shows the 5-hour and weekly usage limits |
| ⛅ | [token-weather](#-token-weather) | Band above the prompt | Forecasts how full the context window is |

---

### ⏸ auto-resume

When a turn stops on a usage limit, waits until the limit resets and sends `continue`. Typing a prompt yourself or running `/auto-resume cancel` stops the wait.

```text
⏸ auto-resume in 1h 12m                                    ← status line
Usage limit reset, resuming                                 ← toast
```

<sub>📁 [`plugins/auto-resume`](plugins/auto-resume)</sub>

### 🏷 auto-session-name

Names each session from its first prompt using Haiku and can give it a prompt bar colour, so it is easy to find with `claude -r` after a crash. Sessions already named with `-n` or `/rename` are left alone. Set the `color` option to `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink` or `cyan` to colour named sessions; `default` leaves the colour alone.

```text
> fix the flaky retry test in the upload worker
                                    → session titled "Fix flaky upload retry test"
```

<sub>📁 [`plugins/auto-session-name`](plugins/auto-session-name)</sub>

### ⏱ cache-clock

Draws a countdown above the prompt to when the prompt cache goes cold, with the last request's hit rate. Once cold, it shows how much the next turn re-writes. Set the `ttl` option to `1h` when extended caching is on.

```text
cache ● 3:42 left · 96% hit                                 ← green, yellow under a minute
cache ○ cold · next turn re-writes 84.3k                    ← red
```

<sub>📁 [`plugins/cache-clock`](plugins/cache-clock)</sub>

### 📊 limit-watch

Draws the 5-hour and weekly usage limits above the prompt with live reset countdowns, green under 60%, yellow to 80% and red past it. Toasts once a window passes 80% and again at 95%. Any other window the API reports, such as a gateway spend limit, shows under its own name.

```text
5h 42% · 2h17m  7d 81% · 3d4h                               ← band
7d limit at 81%, resets in 3d4h                             ← toast
```

<sub>📁 [`plugins/limit-watch`](plugins/limit-watch)</sub>

### ⛅ token-weather

Draws a forecast of the context window above the prompt, with tokens used, a sparkline of the last 12 turns and the change since the last turn.

```text
☁  Cloudy  38% of context  76.4k / 200k   last turns ▁▂▂▃▄▄▅▆  ▲ +4.1k last turn
```

| ☀ Clear | ☁ Cloudy | ☂ Showers | ☇ Storm | ↯ Compact soon |
| :-: | :-: | :-: | :-: | :-: |
| under 25% | under 50% | under 75% | under 90% | 90% and up |

<sub>📁 [`plugins/token-weather`](plugins/token-weather)</sub>

---

<div align="center">

[MIT](LICENSE) © [Tartiner Labs](https://tartinerlabs.com)

</div>
