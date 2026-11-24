import type { EngineInterface, Register } from 'claude-code'

export type Detected = { ecosystem: string; manager: string; source: string; wrapper?: string }

/**
 * One ecosystem whose managers compete. Everything below is data; the walker
 * and matcher know no language.
 */
export type Ecosystem = {
  /** Lockfiles and build files that name the manager. Several disagreeing in one directory decide nothing. */
  markers: Record<string, string>
  /** Fields in a manifest that name the manager, the first capture group being its name; read before markers. */
  fields?: Array<{ file: string; pattern: RegExp }>
  /** The manager each command word belongs to. */
  words: Record<string, string>
  /** Subcommands of a word that never change the project, so any manager may run them. */
  readOnly?: Record<string, readonly string[]>
  /** For a word that is also a runtime: the only subcommands that manage packages. */
  managing?: Record<string, readonly string[]>
  /** How each manager runs a one-off tool, where the ecosystem has them. */
  exec?: Record<string, string>
  /** The wrapper script a project may ship for a manager, to run in place of the global install. */
  wrappers?: Record<string, string>
}

export const ECOSYSTEMS: Record<string, Ecosystem> = {
  node: {
    markers: {
      'pnpm-lock.yaml': 'pnpm',
      'package-lock.json': 'npm',
      'npm-shrinkwrap.json': 'npm',
      'yarn.lock': 'yarn',
      'bun.lock': 'bun',
      'bun.lockb': 'bun',
    },
    fields: [{ file: 'package.json', pattern: /"packageManager"\s*:\s*"(npm|pnpm|yarn|bun)@/ }],
    words: { npm: 'npm', npx: 'npm', pnpm: 'pnpm', pnpx: 'pnpm', yarn: 'yarn', bun: 'bun', bunx: 'bun' },
    readOnly: { npm: ['view', 'info', 'show', 'v', 'whoami', 'search', 'ping', 'docs', 'home', 'repo'] },
    managing: {
      bun: ['install', 'i', 'add', 'a', 'remove', 'rm', 'update', 'upgrade', 'x', 'pm', 'link', 'unlink', 'ci', 'outdated', 'patch', 'publish'],
    },
    exec: { npm: 'npx', pnpm: 'pnpm dlx', yarn: 'yarn dlx', bun: 'bunx' },
  },
  python: {
    markers: { 'uv.lock': 'uv', 'poetry.lock': 'poetry', 'pdm.lock': 'pdm', 'Pipfile.lock': 'pipenv', Pipfile: 'pipenv' },
    fields: [{ file: 'pyproject.toml', pattern: /^\[tool\.(poetry|pdm|uv)\]/m }],
    words: { pip: 'pip', pip3: 'pip', pipx: 'pip', uv: 'uv', uvx: 'uv', poetry: 'poetry', pdm: 'pdm', pipenv: 'pipenv' },
    readOnly: { pip: ['list', 'show', 'freeze', 'check', 'debug', 'config'], pip3: ['list', 'show', 'freeze', 'check', 'debug', 'config'] },
    exec: { pip: 'pipx run', uv: 'uvx', poetry: 'poetry run', pdm: 'pdm run', pipenv: 'pipenv run' },
  },
  jvm: {
    markers: {
      'pom.xml': 'maven',
      'build.gradle': 'gradle',
      'build.gradle.kts': 'gradle',
      'settings.gradle': 'gradle',
      'settings.gradle.kts': 'gradle',
    },
    words: { mvn: 'maven', mvnw: 'maven', gradle: 'gradle', gradlew: 'gradle' },
    wrappers: { maven: 'mvnw', gradle: 'gradlew' },
  },
}

// Flags and subcommands that only report on the tool itself.
const ABOUT = new Set(['--version', '-v', '-V', 'version', '--help', '-h', 'help'])

// Words that run the next word as the command.
const PREFIXES = new Set(['sudo', 'time', 'exec', 'command', 'nohup', 'env'])

// Interpreters that run a module as a command: `python -m pip` is `pip`.
const MODULE_RUNNER = /^python[\d.]*$/

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

const WORDS = Object.values(ECOSYSTEMS).flatMap(ecosystem => Object.keys(ecosystem.words))

const MAYBE = new RegExp(`(^|[^\\w.-])(${WORDS.map(escape).join('|')})(?![\\w.-])`)

/** The ecosystem a command word belongs to. */
export const ecosystemOf = (word: string): string | undefined =>
  Object.keys(ECOSYSTEMS).find(name => Object.hasOwn(ECOSYSTEMS[name]!.words, word))

/** The ecosystem a manager's name belongs to, for the fallback setting. */
export const ecosystemOfManager = (manager: string): string | undefined =>
  Object.keys(ECOSYSTEMS).find(name => Object.values(ECOSYSTEMS[name]!.words).includes(manager))

/** The marker in `names` and its manager, or undefined when there is none or they disagree. */
export const fromMarkers = (ecosystem: string, names: readonly string[]): Detected | undefined => {
  const { markers } = ECOSYSTEMS[ecosystem]!
  const found = names.filter(name => Object.hasOwn(markers, name))
  const managers = new Set(found.map(name => markers[name]))

  return managers.size === 1 ? { ecosystem, manager: markers[found[0]!]!, source: found[0]! } : undefined
}

const fill = (text: string) => '_'.repeat(text.length)

/**
 * The command with heredoc bodies and the insides of quotes masked, its length
 * unchanged, so their words are not read as commands and every position still
 * points at the same place in the command.
 */
export const mask = (command: string): string =>
  command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, heredoc => `<<${fill(heredoc.slice(2))}`)
    .replace(/'[^']*'/g, quoted => `'${fill(quoted.slice(2))}'`)
    .replace(/"(?:[^"\\]|\\.)*"/g, quoted => `"${fill(quoted.slice(2))}"`)

/** Whether a masked word is only a quoted string: `"___"`. */
export const isQuoted = (word: string): boolean => /^(['"])_*\1$/.test(word)

export type Segment = {
  /** The variables it sets, masked. */
  assigns: string[]
  /** Its words, masked, the program first and read by its name (`./gradlew` as `gradlew`). */
  words: string[]
  /** The same words as written, quotes and all, for a command to hand back. */
  raw: string[]
}

/** Each simple command in `command`. */
export const segments = (command: string): Segment[] => {
  const masked = mask(command)
  const found: Segment[] = []
  const separator = /&&|\|\||[;|&\n(`]|\$\(/g
  let from = 0

  for (const match of [...masked.matchAll(separator), { index: masked.length, 0: '' }]) {
    const to = match.index!
    const spans = [...masked.slice(from, to).matchAll(/\S+/g)].map(word => [from + word.index!, from + word.index! + word[0].length] as const)
    const words = spans.map(([start, end]) => masked.slice(start, end))
    const raw = spans.map(([start, end]) => command.slice(start, end))
    const start = words.findIndex(word => !/^\w+=/.test(word) && !PREFIXES.has(word))
    const assigns = words.slice(0, start === -1 ? words.length : start).filter(word => /^\w+=/.test(word))

    from = to + match[0].length

    if (start === -1) {
      if (assigns.length > 0) found.push({ assigns, words: [], raw: [] })
      continue
    }

    const at = MODULE_RUNNER.test(words[start]!) && words[start + 1] === '-m' ? start + 2 : start

    if (at >= words.length) continue

    found.push({
      assigns,
      words: [words[at]!.split('/').pop()!, ...words.slice(at + 1)],
      raw: [raw[at]!.split('/').pop()!, ...raw.slice(at + 1)],
    })
  }

  return found
}

/** Each simple command in `command` as its program's name and the word after it. */
export const commands = (command: string): Array<[string, string | undefined]> =>
  segments(command).flatMap(({ words }) => (words.length === 0 ? [] : [[words[0]!, words[1]] as [string, string | undefined]]))

/** Whether `word sub` runs a manager other than the project's `manager`. */
export const isOffending = (manager: string, word: string, sub: string | undefined): boolean => {
  const ecosystem = ECOSYSTEMS[ecosystemOf(word) ?? '']
  const owner = ecosystem?.words[word]

  if (ecosystem === undefined || owner === undefined || owner === manager) return false
  if (sub !== undefined && ABOUT.has(sub)) return false
  if (sub !== undefined && ecosystem.readOnly?.[word]?.includes(sub)) return false

  const managing = ecosystem.managing?.[word]

  return managing === undefined || (sub !== undefined && managing.includes(sub))
}

/** Whether `word sub` runs the global install of a manager whose project ships a wrapper. */
export const isBypassingWrapper = ({ ecosystem, manager, wrapper }: Detected, word: string, sub: string | undefined): boolean => {
  const file = ECOSYSTEMS[ecosystem]?.wrappers?.[manager]

  return (
    wrapper !== undefined &&
    file !== undefined &&
    ECOSYSTEMS[ecosystem]!.words[word] === manager &&
    !word.endsWith(file) &&
    !(sub !== undefined && ABOUT.has(sub))
  )
}

/** The reason a global install is stopped where the project ships a wrapper, with the command to run. */
export const wrapperReason = (raw: readonly string[], { manager, wrapper }: Detected): string =>
  `package-manager: this project ships the ${manager} wrapper (${wrapper}), which pins its ${manager} version. ` +
  `Run \`${[wrapper, ...raw.slice(1)].join(' ')}\` in place of ${raw[0]}.`

/** What each Node manager runs for each kind of command. */
const NODE: Record<string, Record<'install' | 'frozen' | 'add' | 'remove' | 'update' | 'run' | 'exec' | 'dlx' | 'dev' | 'exact', string>> = {
  npm: { install: 'npm install', frozen: 'npm ci', add: 'npm install', remove: 'npm uninstall', update: 'npm update', run: 'npm run', exec: 'npx', dlx: 'npx', dev: '-D', exact: '-E' },
  pnpm: {
    install: 'pnpm install',
    frozen: 'pnpm install --frozen-lockfile',
    add: 'pnpm add',
    remove: 'pnpm remove',
    update: 'pnpm update',
    run: 'pnpm run',
    exec: 'pnpm exec',
    dlx: 'pnpm dlx',
    dev: '-D',
    exact: '-E',
  },
  yarn: {
    install: 'yarn install',
    frozen: 'yarn install --immutable',
    add: 'yarn add',
    remove: 'yarn remove',
    update: 'yarn up',
    run: 'yarn run',
    exec: 'yarn exec',
    dlx: 'yarn dlx',
    dev: '-D',
    exact: '-E',
  },
  bun: {
    install: 'bun install',
    frozen: 'bun install --frozen-lockfile',
    add: 'bun add',
    remove: 'bun remove',
    update: 'bun update',
    run: 'bun run',
    exec: 'bunx',
    dlx: 'bunx',
    dev: '-d',
    exact: '--exact',
  },
}

/** What each Python manager runs for each kind of command; `pip` stands for `uv pip`'s pip-style installs. */
const PYTHON: Record<string, Record<'add' | 'remove' | 'install' | 'run' | 'tool', string> & { pip?: string }> = {
  uv: { add: 'uv add', remove: 'uv remove', install: 'uv sync', run: 'uv run', tool: 'uvx', pip: 'uv pip install' },
  poetry: { add: 'poetry add', remove: 'poetry remove', install: 'poetry install', run: 'poetry run', tool: 'pipx run' },
  pdm: { add: 'pdm add', remove: 'pdm remove', install: 'pdm install', run: 'pdm run', tool: 'pipx run' },
  pipenv: { add: 'pipenv install', remove: 'pipenv uninstall', install: 'pipenv install', run: 'pipenv run', tool: 'pipx run' },
}

/** One kind of package command, the words after it, and for a tool, its name. */
export type Action = { kind: 'install' | 'frozen' | 'add' | 'remove' | 'update' | 'run' | 'tool' | 'pip'; args: string[] }

const isFlag = (word: string) => word.startsWith('-')

/** What a Node package command does, read from its words as written; undefined when it can't be told. */
export const nodeAction = (raw: readonly string[]): Action | undefined => {
  const [program, sub, ...rest] = raw

  if (program === 'npx' || program === 'pnpx' || program === 'bunx') return { kind: 'tool', args: raw.slice(1) }
  if ((program === 'pnpm' || program === 'yarn') && sub === 'dlx') return { kind: 'tool', args: rest }
  if (program === 'npm' && (sub === 'exec' || sub === 'x')) return { kind: 'tool', args: rest[0] === '--' ? rest.slice(1) : rest }
  if (program === 'bun' && sub === 'x') return { kind: 'tool', args: rest }
  if (program === 'yarn' && (sub === undefined || isFlag(sub))) return { kind: 'install', args: raw.slice(1) }
  if (sub === undefined) return undefined
  if (['install', 'i', 'add', 'a'].includes(sub)) return { kind: rest.some(word => !isFlag(word)) ? 'add' : 'install', args: rest }
  if (sub === 'ci') return { kind: 'frozen', args: rest }
  if (['uninstall', 'un', 'remove', 'rm', 'r'].includes(sub)) return { kind: 'remove', args: rest }
  if (['update', 'upgrade', 'up'].includes(sub)) return { kind: 'update', args: rest }
  if (sub === 'run' || sub === 'run-script') return { kind: 'run', args: rest[0] !== undefined && rest[1] === '--' ? [rest[0], ...rest.slice(2)] : rest }
  if (['test', 't', 'start', 'stop', 'restart'].includes(sub)) return { kind: 'run', args: [sub === 't' ? 'test' : sub, ...(rest[0] === '--' ? rest.slice(1) : rest)] }

  return undefined
}

/** What a Python package command does, read from its words as written; undefined when it can't be told. */
export const pythonAction = (raw: readonly string[]): Action | undefined => {
  const [program, sub, ...rest] = raw

  if (program === 'uvx') return { kind: 'tool', args: raw.slice(1) }
  if (program === 'pipx' && sub === 'run') return { kind: 'tool', args: rest }
  if (program === 'pip' || program === 'pip3') {
    if (sub === 'install') return rest.some(word => /^(-r|-e|--requirement|--editable)$/.test(word)) ? { kind: 'pip', args: rest } : { kind: 'add', args: rest }
    if (sub === 'uninstall') return { kind: 'remove', args: rest.filter(word => word !== '-y' && word !== '--yes') }

    return undefined
  }

  if (program === 'pipenv' && sub === 'install') return { kind: rest.some(word => !isFlag(word)) ? 'add' : 'install', args: rest }
  if (sub === 'add') return { kind: 'add', args: rest }
  if (sub === 'remove' || sub === 'uninstall') return { kind: 'remove', args: rest }
  if (sub === 'sync' || sub === 'install') return { kind: 'install', args: rest }
  if (sub === 'run') return { kind: 'run', args: rest }

  return undefined
}

// Flags each Node manager spells its own way.
const DEV_FLAGS = new Set(['-D', '-d', '--dev', '--save-dev'])
const EXACT_FLAGS = new Set(['-E', '--exact', '--save-exact'])
const DROPPED_FLAGS = new Set(['-S', '--save', '--save-prod', '-P', '-y', '--yes'])

/**
 * The command `manager` runs for `raw`, as the user would type it; undefined
 * when there is no sure translation. A tool the project has installed runs
 * with the manager's exec, any other with its dlx, which fetches it.
 */
export const equivalent = (ecosystem: string, manager: string, raw: readonly string[], isLocal: (tool: string) => boolean = () => false): string | undefined => {
  if (ecosystem === 'node') {
    const verbs = NODE[manager]
    const action = nodeAction(raw)

    if (verbs === undefined || action === undefined) return undefined

    if (action.kind === 'tool') {
      const at = action.args.findIndex(word => !isFlag(word))
      const own = action.args.slice(0, at === -1 ? action.args.length : at)
      const tool = action.args[at]

      if (tool === undefined || own.some(word => !DROPPED_FLAGS.has(word))) return undefined

      return [isLocal(tool) ? verbs.exec : verbs.dlx, ...action.args.slice(at)].join(' ')
    }

    const args = action.args.flatMap(word => (DEV_FLAGS.has(word) ? [verbs.dev] : EXACT_FLAGS.has(word) ? [verbs.exact] : DROPPED_FLAGS.has(word) ? [] : [word]))

    return [verbs[action.kind as keyof typeof verbs], ...args].join(' ')
  }

  if (ecosystem === 'python') {
    const verbs = PYTHON[manager]
    const action = pythonAction(raw)

    if (verbs === undefined || action === undefined) return undefined
    if (action.kind === 'pip') return verbs.pip === undefined ? undefined : [verbs.pip, ...action.args].join(' ')

    return [verbs[action.kind as 'add' | 'remove' | 'install' | 'run' | 'tool'], ...action.args].join(' ')
  }

  return undefined
}

/** The reason a command is stopped, naming the command to run instead when there is a sure one. */
export const reason = (word: string, { ecosystem, manager, source }: Detected, instead?: string): string => {
  const exec = ECOSYSTEMS[ecosystem]?.exec?.[manager]
  const head = `package-manager: this project uses ${manager} (${source}), not ${word}.`

  if (instead !== undefined) return `${head} Run \`${instead}\` instead.`

  return `${head} Run the ${manager} equivalent instead` + (exec === undefined ? '.' : `, with \`${exec}\` for one-off tools.`)
}

/** The managers named in the fallback setting, by ecosystem: `pnpm, uv`. */
export const parseFallbacks = (setting: unknown): Map<string, string> =>
  new Map(
    String(setting ?? '')
      .split(/[\s,]+/)
      .filter(Boolean)
      .flatMap(manager => {
        const ecosystem = ecosystemOfManager(manager)

        return ecosystem === undefined ? [] : [[ecosystem, manager] as [string, string]]
      }),
  )

/**
 * What a guarded setting protects: how long new versions wait, which packages
 * may run install scripts, and whether a dependency's version may be forced.
 */
export type Topic = 'release-age' | 'scripts' | 'overrides'

/** One guarded setting in a package manager's config files. */
export type Gate = {
  topic: Topic
  /** The files that hold it, by name; `pnpm/config.yaml` is pnpm's global config. */
  files: readonly string[]
  /** The setting as written; a dotted path in `package.json`. */
  key: string
  /**
   * `age` a wait, weakened when shorter; `list` entries, weakened when one is
   * added; `safe-true` weakened when set false; `safe-false` weakened when set
   * true; `value` weakened when set to anything new.
   */
  kind: 'age' | 'list' | 'safe-true' | 'safe-false' | 'value'
  /** For `age`: seconds in one unit of a bare number. */
  unit?: number
  /** For `age`: the wait in seconds when the key is absent, for managers that gate by default. */
  fallback?: number
  /** For `list`: only added entries matching this weaken (an allow-list's `name=true`, not its `name=false`). */
  weakens?: RegExp
}

const DAY = 86_400

const PNPM = ['pnpm-workspace.yaml', 'pnpm/config.yaml']
const NPMRC = ['.npmrc']
const YARNRC = ['.yarnrc.yml']
const BUNFIG = ['bunfig.toml']
const UV = ['pyproject.toml', 'uv.toml']
const MANIFEST = ['package.json']

/** Every guarded setting, from each manager's documentation. */
export const GATES: readonly Gate[] = [
  // pnpm
  { topic: 'release-age', files: PNPM, key: 'minimumReleaseAge', kind: 'age', unit: 60, fallback: DAY },
  { topic: 'release-age', files: PNPM, key: 'minimumReleaseAgeExclude', kind: 'list' },
  { topic: 'release-age', files: PNPM, key: 'minimumReleaseAgeStrict', kind: 'safe-true' },
  { topic: 'scripts', files: PNPM, key: 'allowBuilds', kind: 'list', weakens: /=true$/ },
  { topic: 'scripts', files: PNPM, key: 'onlyBuiltDependencies', kind: 'list' },
  { topic: 'scripts', files: PNPM, key: 'dangerouslyAllowAllBuilds', kind: 'safe-false' },
  { topic: 'overrides', files: PNPM, key: 'overrides', kind: 'list' },
  // npm
  { topic: 'release-age', files: NPMRC, key: 'min-release-age', kind: 'age', unit: DAY },
  { topic: 'release-age', files: NPMRC, key: 'min-release-age-exclude', kind: 'list' },
  { topic: 'release-age', files: NPMRC, key: 'before', kind: 'value' },
  { topic: 'scripts', files: NPMRC, key: 'ignore-scripts', kind: 'safe-true' },
  { topic: 'scripts', files: NPMRC, key: 'allow-scripts', kind: 'list' },
  { topic: 'scripts', files: NPMRC, key: 'dangerously-allow-all-scripts', kind: 'safe-false' },
  // yarn
  { topic: 'release-age', files: YARNRC, key: 'npmMinimalAgeGate', kind: 'age', unit: 60, fallback: DAY },
  { topic: 'release-age', files: YARNRC, key: 'npmPreapprovedPackages', kind: 'list' },
  { topic: 'scripts', files: YARNRC, key: 'enableScripts', kind: 'safe-false' },
  // bun
  { topic: 'release-age', files: BUNFIG, key: 'minimumReleaseAge', kind: 'age', unit: 1 },
  { topic: 'release-age', files: BUNFIG, key: 'minimumReleaseAgeExcludes', kind: 'list' },
  { topic: 'scripts', files: BUNFIG, key: 'ignoreScripts', kind: 'safe-true' },
  // uv
  { topic: 'release-age', files: UV, key: 'exclude-newer', kind: 'age', unit: 1 },
  { topic: 'release-age', files: UV, key: 'exclude-newer-package', kind: 'list' },
  { topic: 'scripts', files: UV, key: 'no-build', kind: 'safe-true' },
  { topic: 'overrides', files: UV, key: 'override-dependencies', kind: 'list' },
  // package.json
  { topic: 'scripts', files: MANIFEST, key: 'trustedDependencies', kind: 'list' },
  { topic: 'scripts', files: MANIFEST, key: 'allowScripts', kind: 'list', weakens: /^(?!!)(?!.*=false$)/ },
  { topic: 'scripts', files: MANIFEST, key: 'dependenciesMeta', kind: 'list', weakens: /\.built=true$/ },
  { topic: 'scripts', files: MANIFEST, key: 'pnpm.onlyBuiltDependencies', kind: 'list' },
  { topic: 'overrides', files: MANIFEST, key: 'overrides', kind: 'list' },
  { topic: 'overrides', files: MANIFEST, key: 'resolutions', kind: 'list' },
  { topic: 'overrides', files: MANIFEST, key: 'pnpm.overrides', kind: 'list' },
]

/** The gates a file holds, by its path. */
export const gatesOf = (path: string): Gate[] => {
  const parts = path.split(/[\\/]/)
  const name = parts.at(-1)!
  const named = name === 'config.yaml' && parts.at(-2) === 'pnpm' ? 'pnpm/config.yaml' : name

  return GATES.filter(gate => gate.files.includes(named))
}

/** The manager each lockfile belongs to: Claude changes one through the manager, never by hand. */
export const LOCKFILES: Record<string, string> = {
  'pnpm-lock.yaml': 'pnpm',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'uv.lock': 'uv',
  'poetry.lock': 'poetry',
  'pdm.lock': 'pdm',
  'Pipfile.lock': 'pipenv',
}

/** The manager whose lockfile `path` is, or undefined when it is none. */
export const lockfileOf = (path: string): string | undefined => {
  const name = path.split(/[\\/]/).pop()!

  return Object.hasOwn(LOCKFILES, name) ? LOCKFILES[name] : undefined
}

// Words whose flags can move a gate.
const GATED_WORDS = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'uv', 'uvx', 'pip', 'pip3', 'pipx'])

// Flags that weaken a gate for one run, by what they weaken.
const GATE_FLAGS: Record<string, Topic> = {
  '--minimum-release-age': 'release-age',
  '--minimum-release-age-exclude': 'release-age',
  '--minimum-release-age-excludes': 'release-age',
  '--no-minimum-release-age-strict': 'release-age',
  '--min-release-age': 'release-age',
  '--min-release-age-exclude': 'release-age',
  '--before': 'release-age',
  '--no-time-gate': 'release-age',
  '--exclude-newer': 'release-age',
  '--exclude-newer-package': 'release-age',
  '--dangerously-allow-all-builds': 'scripts',
  '--allow-build': 'scripts',
  '--dangerously-allow-all-scripts': 'scripts',
  '--allow-scripts': 'scripts',
  '--no-ignore-scripts': 'scripts',
  '--override': 'overrides',
}

// Environment variables that set a gate, by what they weaken.
const GATE_ENV: Array<[RegExp, Topic]> = [
  [/^(npm|pnpm)_config_(min(imum)?_release_age\w*|before)$/i, 'release-age'],
  [/^YARN_NPM_(MINIMAL_AGE_GATE|PREAPPROVED_PACKAGES)$/, 'release-age'],
  [/^UV_EXCLUDE_NEWER(_PACKAGE)?$/, 'release-age'],
  [/^(npm|pnpm)_config_(ignore_scripts|allow_scripts|dangerously_allow_all_\w+)$/i, 'scripts'],
  [/^(YARN_ENABLE_SCRIPTS|UV_NO_BUILD)$/, 'scripts'],
]

// Subcommands that only read what is installed globally.
const GLOBAL_READS = new Set(['ls', 'list', 'outdated', 'root', 'bin', 'dir', 'view', 'info', 'why'])

const squash = (name: string) => name.toLowerCase().replace(/[-_.]/g, '')

/** The topic of a setting name, in any spelling (`minimum-release-age`, `minimumReleaseAge`), or undefined when it is not guarded. */
export const topicOfKey = (name: string): Topic | undefined =>
  GATES.find(gate => !gate.files.includes('package.json') && squash(gate.key) === squash(name))?.topic

/** One way a command or change weakens a guard. */
export type Weakening = { topic: Topic; change: string }

/** What in `command` weakens a guard: a flag, a variable, or a config or `pkg set` command. */
export const commandWeakenings = (command: string): Weakening[] => {
  const found: Weakening[] = []

  for (const { assigns, words } of segments(command)) {
    for (const name of [...assigns, ...words].map(word => word.match(/^(\w+)=/)?.[1])) {
      const topic = name === undefined ? undefined : GATE_ENV.find(([pattern]) => pattern.test(name))?.[1]

      if (topic !== undefined) found.push({ topic, change: `sets ${name}` })
    }

    const [program, ...args] = words

    if (program === undefined || !GATED_WORDS.has(program)) continue

    for (const arg of args) {
      const flag = arg.split('=')[0]!
      const topic = Object.hasOwn(GATE_FLAGS, flag) ? GATE_FLAGS[flag] : flag.startsWith('--config.') ? topicOfKey(flag.slice(9)) : undefined

      if (topic !== undefined) found.push({ topic, change: `passes ${flag}` })
      if (flag === '--minimum-release-age-strict' && /=false$/.test(arg)) found.push({ topic: 'release-age', change: `passes ${arg}` })
      if ((flag === '--ignore-scripts' || flag === '--ignoreScripts') && /=false$/.test(arg)) found.push({ topic: 'scripts', change: `passes ${arg}` })
    }

    const config = args.indexOf('config')
    const key = args[config + 2]?.split('=')[0]
    const keyTopic = key === undefined ? undefined : topicOfKey(key)

    if (config !== -1 && ['set', 'delete', 'rm', 'unset'].includes(args[config + 1] ?? '') && keyTopic !== undefined) {
      found.push({ topic: keyTopic, change: `runs ${program} config ${args[config + 1]} ${key}` })
    }

    if (args[0] === 'pkg' && args[1] === 'set') {
      for (const path of args.slice(2).map(arg => arg.split('=')[0]!)) {
        const gate = GATES.find(gate => gate.files.includes('package.json') && (path === gate.key || path.startsWith(`${gate.key}.`) || path.startsWith(`${gate.key}[`)))

        if (gate !== undefined) found.push({ topic: gate.topic, change: `runs ${program} pkg set ${path}` })
      }
    }

    if (program === 'pnpm' && args[0] === 'approve-builds') found.push({ topic: 'scripts', change: 'runs pnpm approve-builds' })
    if (program === 'bun' && args[0] === 'pm' && args[1] === 'trust') found.push({ topic: 'scripts', change: 'runs bun pm trust' })
  }

  return found
}

/**
 * Each global install in `command`, as written: it changes the machine, not
 * the project, so it goes to the user to allow rather than being stopped.
 */
export const globalInstalls = (command: string): string[] =>
  segments(command).flatMap(({ words, raw }) => {
    const [program, ...args] = words

    if (program === undefined) return []

    const isGlobal =
      (['npm', 'pnpm', 'bun'].includes(program) && args.some(arg => arg === '-g' || arg === '--global') && !GLOBAL_READS.has(args.find(arg => !arg.startsWith('-')) ?? '')) ||
      (program === 'yarn' && args[0] === 'global' && !GLOBAL_READS.has(args[1] ?? '')) ||
      (program === 'uv' && args[0] === 'tool' && ['install', 'upgrade'].includes(args[1] ?? '')) ||
      (program === 'pipx' && ['install', 'upgrade', 'inject'].includes(args[0] ?? '')) ||
      (['pip', 'pip3'].includes(program) && args[0] === 'install' && args.some(arg => arg === '--user' || arg === '--break-system-packages'))

    return isGlobal ? [raw.join(' ')] : []
  })

/** Each global install in `command`, as its words as written. */
const globalSegments = (command: string): string[][] =>
  segments(command).flatMap(({ raw }) => (globalInstalls(raw.join(' ')).length > 0 ? [raw] : []))

/** The command each manager installs a tool globally with. */
const GLOBAL_INSTALL: Record<string, string> = {
  npm: 'npm install -g',
  pnpm: 'pnpm add -g',
  yarn: 'yarn global add',
  bun: 'bun add -g',
  uv: 'uv tool install',
  pip: 'pipx install',
}

/** The managers named in the global-manager setting, by ecosystem: `pnpm, uv`; `pipx` stands for pip's tools. */
export const parseGlobalManagers = (setting: unknown): Map<string, string> =>
  parseFallbacks(String(setting ?? '').replace(/\bpipx\b/g, 'pip'))

/** The packages a global install names: the words after its install verb that are not flags. */
const globalPackages = (raw: readonly string[]): string[] => {
  const [program, ...args] = raw
  const skip = program === 'yarn' ? 2 : program === 'uv' ? 2 : 1

  return args.slice(skip).filter(arg => !arg.startsWith('-'))
}

/**
 * The reason a global install is stopped because it uses another manager than
 * the preferred one, with the command to run instead where it installs packages.
 */
export const globalManagerReason = (raw: readonly string[], preferred: string): string | undefined => {
  const ecosystem = ecosystemOf(raw[0] ?? '')
  const used = ecosystem === undefined ? undefined : ECOSYSTEMS[ecosystem]!.words[raw[0]!]

  if (used === undefined || used === preferred) return undefined

  const packages = globalPackages(raw)
  const verb = raw[0] === 'yarn' ? raw[2] : raw[0] === 'uv' ? raw[2] : raw[1]
  const installs = ['install', 'i', 'add', 'a'].includes(verb ?? '') || (raw[0] === 'pip' || raw[0] === 'pip3' ? verb === 'install' : false)
  const name = preferred === 'pip' ? 'pipx' : preferred
  const instead = installs && packages.length > 0 && GLOBAL_INSTALL[preferred] !== undefined ? `Run \`${GLOBAL_INSTALL[preferred]} ${packages.join(' ')}\` instead.` : `Use ${name} for it instead.`

  return `package-manager: global installs here use ${name}, not ${raw[0]}. ${instead}`
}

/** What the permission prompt says about a global install. */
export const globalReason = (installs: readonly string[]): string =>
  `package-manager: \`${installs.join('` and `')}\` installs globally, changing this machine rather than the project. Allow it only if you want it installed for every project.`

const unquote = (text: string) => text.trim().replace(/^(['"])(.*)\1$/, '$2').trim()

// A comment at the end of a line, outside quotes.
const uncomment = (text: string) => text.replace(/\s+[#;].*$/, '').trim()

const keyPattern = (key: string) => `["']?${key.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')}["']?`

/** The value `text` gives `key`, from YAML, TOML or an `.npmrc`. */
export const valueOf = (text: string, key: string): string | undefined => {
  const value = text.match(new RegExp(`^[ \\t]*${keyPattern(key)}[ \\t]*[:=][ \\t]*(.*)$`, 'm'))?.[1]

  return value === undefined ? undefined : unquote(uncomment(value))
}

/** Items of a list or table body, split at its top-level commas. */
const splitTop = (inner: string): string[] => {
  const items: string[] = []
  let depth = 0
  let start = 0

  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]!

    if (char === '[' || char === '{') depth++
    if (char === ']' || char === '}') depth--
    if (char === ',' && depth === 0) {
      items.push(inner.slice(start, i))
      start = i + 1
    }
  }

  items.push(inner.slice(start))

  return items.map(item => unquote(item.replace(/\s*=\s*/g, '=').replace(/\s+/g, ' '))).filter(Boolean)
}

/**
 * The entries `text` lists under `key`: a YAML list or map, a TOML array,
 * inline table or full table, or `.npmrc` lines; a map's entries read `name=value`.
 */
export const entriesOf = (text: string, key: string): string[] => {
  const lines = text.split('\n')
  const found: string[] = []
  const line = new RegExp(`^([ \\t]*)(${keyPattern(key)})(\\[\\])?[ \\t]*[:=][ \\t]*(.*)$`)
  const table = new RegExp(`^\\s*\\[\\[?(?:[\\w.-]+\\.)?${keyPattern(key)}\\]\\]?\\s*$`)

  for (let i = 0; i < lines.length; i++) {
    if (table.test(lines[i]!)) {
      for (i++; i < lines.length && !/^\s*\[/.test(lines[i]!); i++) {
        const [name, ...value] = uncomment(lines[i]!).split('=')

        if (name !== undefined && value.length > 0) found.push(`${unquote(name)}=${unquote(value.join('='))}`)
      }

      i--
      continue
    }

    const match = lines[i]!.match(line)

    if (match === null) continue

    const [, indent, , array] = match
    let rest = uncomment(match[4]!)

    if (array !== undefined) {
      found.push(unquote(rest))
    } else if (rest.startsWith('[') || rest.startsWith('{')) {
      const depth = (text: string) => [...text].reduce((sum, char) => sum + (char === '[' || char === '{' ? 1 : char === ']' || char === '}' ? -1 : 0), 0)

      while (depth(rest) > 0 && i + 1 < lines.length) rest += ` ${uncomment(lines[++i]!)}`

      found.push(...splitTop(rest.slice(1, rest.lastIndexOf(rest.startsWith('[') ? ']' : '}'))))
    } else if (rest !== '') {
      found.push(...splitTop(rest))
    } else {
      let child: number | undefined

      for (; i + 1 < lines.length; i++) {
        const next = lines[i + 1]!

        if (next.trim() === '' || next.trim().startsWith('#')) continue

        const width = next.match(/^\s*/)![0].length

        if (width <= indent!.length && !next.trim().startsWith('-')) break

        child ??= width
        if (width !== child) continue

        const item = next.trim().match(/^-\s*(.+)$/)?.[1]
        const pair = next.trim().match(/^(.+?):(?:\s+(.*))?$/)

        if (item !== undefined) found.push(unquote(uncomment(item)))
        else if (pair !== null) found.push(`${unquote(pair[1]!)}=${unquote(uncomment(pair[2] ?? ''))}`)
      }
    }
  }

  return found
}

/** The leaves under `path` in a JSON manifest: array items as they are, object leaves as `a.b=value`. */
export const jsonEntriesOf = (text: string, path: string): string[] => {
  let value: unknown

  try {
    value = path.split('.').reduce<unknown>((node, part) => (node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), JSON.parse(text || '{}'))
  } catch {
    return []
  }

  const leaves = (node: unknown, prefix: string): string[] =>
    Array.isArray(node)
      ? node.map(item => (typeof item === 'string' ? item : JSON.stringify(item)))
      : node !== null && typeof node === 'object'
        ? Object.entries(node).flatMap(([name, child]) => leaves(child, prefix === '' ? name : `${prefix}.${name}`))
        : node === undefined
          ? []
          : [`${prefix}=${String(node)}`]

  return leaves(value, '')
}

/** A wait in seconds: a bare number in `unit`s, `3d`, `12 hours`, `P7D`; `false` is none; NaN when it is not a wait, like a date. */
export const secondsOf = (value: string, unit: number): number => {
  if (value === 'false') return 0
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * unit

  const friendly = value.match(/^(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)$/i)
  const units: Record<string, number> = { s: 1, m: 60, h: 3_600, d: DAY, w: 7 * DAY }

  if (friendly !== null) return Number(friendly[1]) * units[friendly[2]![0]!.toLowerCase()]!

  const iso = value.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i)

  if (iso !== null && value.length > 1) {
    const [, w = 0, d = 0, h = 0, m = 0, s = 0] = iso

    return Number(w) * 7 * DAY + Number(d) * DAY + Number(h) * 3_600 + Number(m) * 60 + Number(s)
  }

  return Number.NaN
}

/** How going from `before` to `after` weakens the guarded settings in the file at `path`; empty when it does not. */
export const weakenings = (path: string, before: string, after: string): Weakening[] =>
  gatesOf(path).flatMap(({ topic, key, kind, unit = 1, fallback, weakens }): Weakening[] => {
    const isJson = path.endsWith('.json')

    if (kind === 'list') {
      const read = (text: string) => (isJson ? jsonEntriesOf(text, key) : entriesOf(text, key))
      const had = new Set(read(before))

      return read(after)
        .filter(entry => !had.has(entry) && (weakens === undefined || weakens.test(entry)))
        .map(entry => ({ topic, change: `adds ${entry} to ${key}` }))
    }

    const was = isJson ? jsonEntriesOf(before, key)[0]?.replace(/^=/, '') : valueOf(before, key)
    const is = isJson ? jsonEntriesOf(after, key)[0]?.replace(/^=/, '') : valueOf(after, key)

    if (was === is) return []
    if (kind === 'safe-true') return is === 'false' ? [{ topic, change: `sets ${key} to false` }] : []
    if (kind === 'safe-false') return is === 'true' ? [{ topic, change: `sets ${key} to true` }] : []
    if (kind === 'value') return is === undefined ? [] : [{ topic, change: `sets ${key} to ${is}` }]

    const from = was === undefined ? (fallback ?? 0) : secondsOf(was, unit)
    const to = is === undefined ? (fallback ?? 0) : secondsOf(is, unit)

    if (Number.isNaN(from) || Number.isNaN(to)) return [{ topic, change: `changes ${key} to ${is ?? 'nothing'}` }]
    if (to >= from) return []

    return [{ topic, change: is === undefined ? `removes ${key}` : `lowers ${key} to ${is}` }]
  })

/** What each guard protects, and what Claude does instead of weakening it. */
const WHY: Record<Topic, string> = {
  'release-age':
    'The release-age gate holds new versions back until a bad release can be caught. Tell the user which package needs a newer version and offer to pin the newest version old enough, or to wait.',
  scripts:
    "Install scripts are how a malicious package runs code on install, so they run only for packages the user approved. Tell the user which package wants its build script run and let them approve it.",
  overrides:
    'An override forces a version on every package that depends on it. Bump the direct dependency instead, or leave a transitive one until its parent updates, and tell the user.',
}

/** The reason a change is stopped: what it does, why each guard matters, and that the change is the user's to make. */
export const guardReason = (what: string, found: readonly Weakening[]): string =>
  `package-manager: this ${what} ${found.map(({ change }) => change).join('; ')}. ` +
  [...new Set(found.map(({ topic }) => topic))].map(topic => WHY[topic]).join(' ') +
  " Don't work around it: making this change is the user's call."

/** The reason a hand edit to a lockfile is stopped. */
export const lockfileReason = (path: string, manager: string): string =>
  `package-manager: ${path.split(/[\\/]/).pop()} is ${manager}'s lockfile. Change the manifest and run ${manager} to rewrite it, rather than editing it by hand.`

/** The text an Edit leaves in a file. */
export const applyEdit = (text: string, { old_string, new_string, replace_all }: { old_string: string; new_string: string; replace_all?: boolean }): string =>
  replace_all === true ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string)

export type Commit = { all: boolean; cwd?: string }

const within = (dir: string | undefined, path: string) => (dir === undefined || path.startsWith('/') ? path : `${dir}/${path}`)

/**
 * Each commit in `command`: whether it takes every tracked change (`-a`), and
 * the directory it runs in, following `cd` and `git -C`, relative to the
 * session's unless absolute; absent, the session's own.
 */
export const commitsOf = (command: string): Commit[] => {
  const found: Commit[] = []
  let dir: string | undefined

  for (const { words, raw } of segments(command)) {
    if (words[0] === 'cd' && raw[1] !== undefined && unquote(raw[1]) !== '') dir = within(dir, unquote(raw[1]))
    if (words[0] !== 'git' || !words.includes('commit')) continue

    const at = words.indexOf('-C')
    const cwd = at === -1 ? dir : within(dir, words[at + 1] ?? '.')

    found.push({ all: words.some(word => word === '--all' || /^-[A-Za-z]*a[A-Za-z]*$/.test(word)), ...(cwd === undefined ? {} : { cwd }) })
  }

  return found
}

/** How the changes a commit would take weaken a guard, read from git where the commit runs. */
const committedWeakenings = async ($: EngineInterface, { all, cwd }: Commit): Promise<Weakening[]> => {
  const git = (args: string[]) =>
    $.process.run(['git', ...args], cwd === undefined ? undefined : { cwd }).then(
      ({ exitCode, stdout }) => (exitCode === 0 ? stdout : undefined),
      () => undefined,
    )
  const root = (await git(['rev-parse', '--show-toplevel']))?.trim()
  const names = (await git(all ? ['diff', 'HEAD', '--name-only'] : ['diff', '--cached', '--name-only'])) ?? ''

  if (root === undefined) return []

  const found: Weakening[] = []

  for (const name of names.split('\n').filter(Boolean)) {
    if (gatesOf(name).length === 0) continue

    const before = (await git(['show', `HEAD:${name}`])) ?? ''
    const after = all ? await readText($, `${root}/${name}`) : ((await git(['show', `:${name}`])) ?? '')

    found.push(...weakenings(name, before, after).map(({ topic, change }) => ({ topic, change: `${name} ${change}` })))
  }

  return found
}

const parent = (dir: string): string | undefined => {
  const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
  const up = cut <= 0 ? dir.slice(0, cut + 1) : dir.slice(0, cut)

  return up === '' || up === dir ? undefined : up
}

const readText = ($: EngineInterface, path: string): Promise<string> =>
  $.fs.read(path).then(text => (typeof text === 'string' ? text : ''), () => '')

/** The nearest `file` from `from` (the session's directory unless given) up to the repository root, by its absolute path. */
const findUp = async ($: EngineInterface, file: string, from?: string): Promise<string | undefined> => {
  for (let dir: string | undefined = from ?? (await $.session.cwd()); dir !== undefined; dir = parent(dir)) {
    const names = (await $.fs.list(dir).catch(() => [])).map(entry => entry.name)

    if (names.includes(file)) return `${dir}/${file}`
    if (names.includes('.git')) return undefined
  }

  return undefined
}

/** The manager `ecosystem` uses and any wrapper the project ships for it. */
const detectWithWrapper = async ($: EngineInterface, ecosystem: string, from: string): Promise<Detected | undefined> => {
  const detected = await detect($, ecosystem, from)
  const file = detected === undefined ? undefined : ECOSYSTEMS[ecosystem]!.wrappers?.[detected.manager]
  const wrapper = file === undefined ? undefined : await findUp($, file, from)

  return detected === undefined || wrapper === undefined ? detected : { ...detected, wrapper }
}

/** The manager `ecosystem` uses, the nearest directory from `from` deciding, up to the repository root. */
const detect = async ($: EngineInterface, ecosystem: string, from: string): Promise<Detected | undefined> => {
  const { fields = [] } = ECOSYSTEMS[ecosystem]!

  for (let dir: string | undefined = from; dir !== undefined; dir = parent(dir)) {
    const names = (await $.fs.list(dir).catch(() => [])).map(entry => entry.name)

    for (const { file, pattern } of fields) {
      if (!names.includes(file)) continue

      const manager = (await readText($, `${dir}/${file}`)).match(pattern)?.[1]

      if (manager !== undefined) return { ecosystem, manager, source: file }
    }

    const marked = fromMarkers(ecosystem, names)

    if (marked !== undefined) return marked
    if (names.includes('.git')) return undefined
  }

  return undefined
}

/** Whether the project has `tool` installed: a `node_modules/.bin` entry from `from` up to the repository root. */
const hasLocalBin = async ($: EngineInterface, tool: string, from: string): Promise<boolean> => {
  if (!/^[\w.-]+$/.test(tool)) return false

  for (let dir: string | undefined = from; dir !== undefined; dir = parent(dir)) {
    if (await $.fs.exists(`${dir}/node_modules/.bin/${tool}`).catch(() => false)) return true
    if (await $.fs.exists(`${dir}/.git`).catch(() => false)) return false
  }

  return false
}

/** The reason a change to a file is stopped, or undefined when it may go on. */
const fileGuard = async ($: EngineInterface, verb: string, path: string, after: (before: string) => string): Promise<string | undefined> => {
  const lockfile = lockfileOf(path)

  if (lockfile !== undefined) return lockfileReason(path, lockfile)
  if (gatesOf(path).length === 0) return undefined

  const before = await readText($, path)
  const found = weakenings(path, before, after(before))

  return found.length === 0 ? undefined : guardReason(verb, found)
}

export const register: Register = (on, options) => {
  const fallbacks = parseFallbacks(options.fallback)
  const globalManagers = parseGlobalManagers(options.globalManager)

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const weakened = commandWeakenings(e.command)

    if (weakened.length > 0) return { deny: guardReason('command', weakened) }

    for (const commit of commitsOf(e.command)) {
      const found = await committedWeakenings($, commit)

      if (found.length > 0) return { deny: guardReason('commit', found) }
    }

    for (const raw of globalSegments(e.command)) {
      const preferred = globalManagers.get(ecosystemOf(raw[0] ?? '') ?? '')
      const deny = preferred === undefined ? undefined : globalManagerReason(raw, preferred)

      if (deny !== undefined) return { deny }
    }

    if (!MAYBE.test(e.command)) return next(e)

    const known = new Map<string, Detected | undefined>()
    let dir = await $.session.cwd()

    for (const { words, raw } of segments(e.command)) {
      const [word, sub] = words

      if (word === 'cd' && raw[1] !== undefined && unquote(raw[1]) !== '') dir = within(dir, unquote(raw[1]))
      if (word === undefined) continue

      const ecosystem = ecosystemOf(word)

      if (ecosystem === undefined) continue
      if (globalManagers.has(ecosystem) && globalInstalls(raw.join(' ')).length > 0) continue
      const key = `${ecosystem} ${dir}`

      if (!known.has(key)) {
        const fallback = fallbacks.get(ecosystem)
        const detected = await detectWithWrapper($, ecosystem, dir)

        known.set(key, detected ?? (fallback === undefined ? undefined : { ecosystem, manager: fallback, source: 'your fallback setting' }))
      }

      const detected = known.get(key)

      if (detected === undefined) continue
      if (isOffending(detected.manager, word, sub)) {
        const tool = ecosystem === 'node' && nodeAction(raw)?.kind === 'tool' ? nodeAction(raw)!.args.find(arg => !arg.startsWith('-')) : undefined
        const isLocal = tool !== undefined && (await hasLocalBin($, tool, dir))

        return { deny: reason(word, detected, equivalent(ecosystem, detected.manager, raw, () => isLocal)) }
      }

      if (isBypassingWrapper(detected, word, sub)) return { deny: wrapperReason(raw, detected) }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // A global install isn't refused: it goes to the user, even where a rule would allow it.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const command = (e.input as { command?: unknown } | undefined)?.command
    const installs = typeof command === 'string' ? globalInstalls(command) : []

    if (installs.length === 0) return next(e)

    const below = await next(e)

    return below.decision === 'deny' ? below : { decision: 'ask', reason: globalReason(installs) }
  }).catch(($, e, next) => next(e))

  // In auto mode the classifier decides instead of the dialog: a global install goes to the user there too.
  on('tool.judge', { tool: 'Bash' }, ($, e, next) => {
    const command = (e.input as { command?: unknown } | undefined)?.command
    const installs = typeof command === 'string' ? globalInstalls(command) : []

    return installs.length === 0 ? next(e) : { decision: 'ask', reason: globalReason(installs) }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const deny = await fileGuard($, 'edit', e.file_path, before => applyEdit(before, e))

    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const deny = await fileGuard($, 'write', e.file_path, () => e.content)

    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) => next(e))
}
