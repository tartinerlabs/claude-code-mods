import { describe, expect, test as it } from 'claude-code/testing'
import {
  commandWeakenings,
  commands,
  commitsOf,
  ECOSYSTEMS,
  entriesOf,
  equivalent,
  fromMarkers,
  gatesOf,
  globalInstalls,
  globalManagerReason,
  globalReason,
  guardReason,
  isBypassingWrapper,
  isOffending,
  jsonEntriesOf,
  lockfileOf,
  parseFallbacks,
  parseGlobalManagers,
  reason,
  secondsOf,
  segments,
  weakenings,
  wrapperReason,
} from './hooks/register'

describe('commands', () => {
  it('should read each command in a chain, past env assignments and prefixes', () => {
    expect(commands('cd app && CI=1 sudo npx tsc; pnpm test | tee out')).toEqual([
      ['cd', 'app'],
      ['npx', 'tsc'],
      ['pnpm', 'test'],
      ['tee', 'out'],
    ])
  })

  it('should read a program by its name, wherever it is run from', () => {
    expect(commands('../gradlew build && /usr/local/bin/npm ci')).toEqual([
      ['gradlew', 'build'],
      ['npm', 'ci'],
    ])
  })

  it('should read python -m pip as pip', () => {
    expect(commands('python3 -m pip install requests')).toEqual([['pip', 'install']])
  })

  it('should ignore words inside quotes and heredocs', () => {
    expect(commands('git commit -m "fix; npm install"')).toEqual([['git', 'commit']])
    expect(commands("cat <<'EOF' > notes.md\nnpm install\nEOF\necho done").map(([program]) => program)).toEqual(['cat', 'echo'])
  })

  it('should keep each word as written beside its masked form', () => {
    expect(segments('cd "my app" && npx tsc --project "tsconfig app.json"')).toEqual([
      { assigns: [], words: ['cd', '"______"'], raw: ['cd', '"my app"'] },
      { assigns: [], words: ['npx', 'tsc', '--project', '"_________________"'], raw: ['npx', 'tsc', '--project', '"tsconfig app.json"'] },
    ])
  })
})

describe('fromMarkers', () => {
  it('should name the manager from its lockfile', () => {
    expect(fromMarkers('node', ['src', 'pnpm-lock.yaml'])).toEqual({ ecosystem: 'node', manager: 'pnpm', source: 'pnpm-lock.yaml' })
    expect(fromMarkers('python', ['uv.lock', 'pyproject.toml'])).toMatchObject({ manager: 'uv' })
    expect(fromMarkers('jvm', ['build.gradle.kts', 'settings.gradle.kts'])).toMatchObject({ manager: 'gradle' })
  })

  it('should decide nothing when lockfiles disagree', () => {
    expect(fromMarkers('node', ['yarn.lock', 'package-lock.json'])).toBeUndefined()
  })
})

describe('the manifest fields', () => {
  it('should read packageManager from package.json and the tool table from pyproject.toml', () => {
    expect('{ "packageManager": "pnpm@9.12.0" }'.match(ECOSYSTEMS.node!.fields![0]!.pattern)?.[1]).toBe('pnpm')
    expect('[project]\nname = "x"\n\n[tool.poetry]\n'.match(ECOSYSTEMS.python!.fields![0]!.pattern)?.[1]).toBe('poetry')
  })
})

describe('isOffending', () => {
  it('should stop another manager of the same ecosystem', () => {
    expect(isOffending('pnpm', 'npx', 'tsc')).toBe(true)
    expect(isOffending('pnpm', 'npm', 'install')).toBe(true)
    expect(isOffending('uv', 'pip', 'install')).toBe(true)
    expect(isOffending('gradle', 'mvn', 'test')).toBe(true)
  })

  it('should let the project manager through', () => {
    expect(isOffending('pnpm', 'pnpm', 'install')).toBe(false)
    expect(isOffending('uv', 'uvx', 'ruff')).toBe(false)
    expect(isOffending('gradle', 'gradlew', 'build')).toBe(false)
  })

  it('should let version checks and read-only queries through', () => {
    expect(isOffending('pnpm', 'npm', '--version')).toBe(false)
    expect(isOffending('pnpm', 'npm', 'view')).toBe(false)
    expect(isOffending('uv', 'pip', 'freeze')).toBe(false)
  })

  it('should stop bun only where it manages packages, not where it runs code', () => {
    expect(isOffending('pnpm', 'bun', 'add')).toBe(true)
    expect(isOffending('pnpm', 'bun', 'run')).toBe(false)
    expect(isOffending('pnpm', 'bun', 'script.ts')).toBe(false)
  })
})

describe('isBypassingWrapper', () => {
  const gradle = { ecosystem: 'jvm', manager: 'gradle', source: 'settings.gradle.kts', wrapper: '/repo/gradlew' }

  it('should stop the global install where the project ships a wrapper', () => {
    expect(isBypassingWrapper(gradle, 'gradle', 'build')).toBe(true)
    expect(wrapperReason(['gradle', 'build', '--info'], gradle)).toBe(
      'package-manager: this project ships the gradle wrapper (/repo/gradlew), which pins its gradle version. Run `/repo/gradlew build --info` in place of gradle.',
    )
  })

  it('should let the wrapper, version checks and wrapperless projects through', () => {
    expect(isBypassingWrapper(gradle, 'gradlew', 'build')).toBe(false)
    expect(isBypassingWrapper(gradle, 'gradle', '--version')).toBe(false)
    expect(isBypassingWrapper({ ...gradle, wrapper: undefined }, 'gradle', 'build')).toBe(false)
  })
})

describe('reason', () => {
  it('should name the manager, where it came from and how it runs one-off tools', () => {
    expect(reason('npx', { ecosystem: 'node', manager: 'pnpm', source: 'pnpm-lock.yaml' })).toBe(
      'package-manager: this project uses pnpm (pnpm-lock.yaml), not npx. Run the pnpm equivalent instead, with `pnpm dlx` for one-off tools.',
    )
    expect(reason('mvn', { ecosystem: 'jvm', manager: 'gradle', source: 'build.gradle' })).toBe(
      'package-manager: this project uses gradle (build.gradle), not mvn. Run the gradle equivalent instead.',
    )
  })
})

describe('equivalent', () => {
  const pnpm = (command: string, isLocal = false) => equivalent('node', 'pnpm', command.split(' '), () => isLocal)

  it('should translate installs, adds, removes and updates', () => {
    expect(pnpm('npm install')).toBe('pnpm install')
    expect(pnpm('npm ci')).toBe('pnpm install --frozen-lockfile')
    expect(pnpm('npm i zod --save-dev')).toBe('pnpm add zod -D')
    expect(pnpm('npm install react@19 -E')).toBe('pnpm add react@19 -E')
    expect(pnpm('yarn')).toBe('pnpm install')
    expect(pnpm('bun add -d vitest')).toBe('pnpm add -D vitest')
    expect(pnpm('npm uninstall lodash')).toBe('pnpm remove lodash')
    expect(pnpm('yarn up react')).toBe('pnpm update react')
    expect(equivalent('node', 'yarn', ['npm', 'ci'])).toBe('yarn install --immutable')
    expect(equivalent('node', 'bun', ['npm', 'i', '-D', 'vitest'])).toBe('bun add -d vitest')
  })

  it('should translate scripts, dropping the -- npm needs', () => {
    expect(pnpm('npm run build')).toBe('pnpm run build')
    expect(pnpm('npm run test -- --watch')).toBe('pnpm run test --watch')
    expect(pnpm('npm test')).toBe('pnpm run test')
    expect(equivalent('node', 'bun', ['npm', 'test'])).toBe('bun run test')
  })

  it('should run an installed tool with exec and any other with dlx', () => {
    expect(pnpm('npx tsc --noEmit', true)).toBe('pnpm exec tsc --noEmit')
    expect(pnpm('npx -y create-vite my-app')).toBe('pnpm dlx create-vite my-app')
    expect(pnpm('bunx prettier --check .', true)).toBe('pnpm exec prettier --check .')
    expect(equivalent('node', 'yarn', ['npx', 'tsc'], () => true)).toBe('yarn exec tsc')
    expect(equivalent('node', 'bun', ['npx', 'cowsay', 'hi'])).toBe('bunx cowsay hi')
  })

  it('should translate Python commands', () => {
    expect(equivalent('python', 'uv', ['pip', 'install', 'requests'])).toBe('uv add requests')
    expect(equivalent('python', 'uv', ['pip', 'install', '-r', 'requirements.txt'])).toBe('uv pip install -r requirements.txt')
    expect(equivalent('python', 'uv', ['pip', 'uninstall', '-y', 'requests'])).toBe('uv remove requests')
    expect(equivalent('python', 'uv', ['pipx', 'run', 'ruff', 'check'])).toBe('uvx ruff check')
    expect(equivalent('python', 'poetry', ['uv', 'add', 'httpx'])).toBe('poetry add httpx')
    expect(equivalent('python', 'poetry', ['uv', 'sync'])).toBe('poetry install')
    expect(equivalent('python', 'pdm', ['uv', 'run', 'pytest'])).toBe('pdm run pytest')
  })

  it('should give nothing where there is no sure translation', () => {
    expect(pnpm('npm publish')).toBeUndefined()
    expect(pnpm('npx -p typescript tsc')).toBeUndefined()
    expect(equivalent('python', 'poetry', ['pip', 'install', '-r', 'requirements.txt'])).toBeUndefined()
    expect(equivalent('jvm', 'gradle', ['mvn', 'test'])).toBeUndefined()
  })

  it('should name the command in the reason', () => {
    expect(reason('npx', { ecosystem: 'node', manager: 'pnpm', source: 'pnpm-lock.yaml' }, 'pnpm exec tsc')).toBe(
      'package-manager: this project uses pnpm (pnpm-lock.yaml), not npx. Run `pnpm exec tsc` instead.',
    )
  })
})

describe('parseFallbacks', () => {
  it('should file each manager under its ecosystem and drop unknown names', () => {
    expect([...parseFallbacks('pnpm, uv nope')]).toEqual([
      ['node', 'pnpm'],
      ['python', 'uv'],
    ])
  })
})

const changes = (command: string) => commandWeakenings(command).map(({ topic, change }) => `${topic}: ${change}`)

describe('commandWeakenings', () => {
  it('should stop flags that lower or skip a release-age gate, for every manager', () => {
    expect(changes('pnpm add react --minimum-release-age 0')).toEqual(['release-age: passes --minimum-release-age'])
    expect(changes('pnpm install --config.minimum-release-age=0')).toEqual(['release-age: passes --config.minimum-release-age'])
    expect(changes('npm install --min-release-age=0')).toEqual(['release-age: passes --min-release-age'])
    expect(changes('npm install --before 2026-11-24')).toEqual(['release-age: passes --before'])
    expect(changes('yarn up react --no-time-gate')).toEqual(['release-age: passes --no-time-gate'])
    expect(changes('bun add react --minimum-release-age-excludes react')).toEqual(['release-age: passes --minimum-release-age-excludes'])
    expect(changes('uv lock --exclude-newer-package "httpx=false"')).toEqual(['release-age: passes --exclude-newer-package'])
  })

  it('should stop flags and commands that let install scripts run', () => {
    expect(changes('pnpm install --dangerously-allow-all-builds')).toEqual(['scripts: passes --dangerously-allow-all-builds'])
    expect(changes('pnpm install --allow-build=esbuild')).toEqual(['scripts: passes --allow-build'])
    expect(changes('npm ci --dangerously-allow-all-scripts')).toEqual(['scripts: passes --dangerously-allow-all-scripts'])
    expect(changes('npm install --ignore-scripts=false')).toEqual(['scripts: passes --ignore-scripts=false'])
    expect(changes('pnpm approve-builds esbuild')).toEqual(['scripts: runs pnpm approve-builds'])
    expect(changes('bun pm trust --all')).toEqual(['scripts: runs bun pm trust'])
  })

  it('should stop overrides', () => {
    expect(changes('npm pkg set overrides.lodash=4.17.21')).toEqual(['overrides: runs npm pkg set overrides.lodash'])
    expect(changes('npm pkg set trustedDependencies[0]=esbuild')).toEqual(['scripts: runs npm pkg set trustedDependencies[0]'])
  })

  it('should leave global installs to the permission prompt rather than stopping them', () => {
    expect(changes('npm i -g typescript')).toEqual([])
  })

  it('should stop variables and config commands that set a guard', () => {
    expect(changes('PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 pnpm install')).toEqual(['release-age: sets PNPM_CONFIG_MINIMUM_RELEASE_AGE'])
    expect(changes('export npm_config_min_release_age=0 && npm ci')).toEqual(['release-age: sets npm_config_min_release_age'])
    expect(changes('YARN_ENABLE_SCRIPTS=true yarn install')).toEqual(['scripts: sets YARN_ENABLE_SCRIPTS'])
    expect(changes('pnpm config set minimum-release-age 0')).toEqual(['release-age: runs pnpm config set minimum-release-age'])
    expect(changes('yarn config set enableScripts true')).toEqual(['scripts: runs yarn config set enableScripts'])
  })

  it('should let ordinary installs, tightening and reads through', () => {
    expect(changes('pnpm install --frozen-lockfile')).toEqual([])
    expect(changes('pnpm install --minimum-release-age-strict')).toEqual([])
    expect(changes('npm install --ignore-scripts')).toEqual([])
    expect(changes('git log --before 2026-11-01')).toEqual([])
    expect(changes('git commit -m "pnpm add --minimum-release-age 0"')).toEqual([])
    expect(changes('pnpm config get minimum-release-age')).toEqual([])
    expect(changes('npm ls -g')).toEqual([])
    expect(changes('npx tsc --noEmit')).toEqual([])
    expect(changes('uv tool run ruff check')).toEqual([])
  })
})

describe('globalInstalls', () => {
  it('should find each global install, as written', () => {
    expect(globalInstalls('npm i -g typescript')).toEqual(['npm i -g typescript'])
    expect(globalInstalls('pnpm add --global tsx')).toEqual(['pnpm add --global tsx'])
    expect(globalInstalls('yarn global add serve')).toEqual(['yarn global add serve'])
    expect(globalInstalls('cd /tmp && uv tool install ruff')).toEqual(['uv tool install ruff'])
    expect(globalInstalls('pipx install black')).toEqual(['pipx install black'])
    expect(globalInstalls('pip install --user requests')).toEqual(['pip install --user requests'])
  })

  it('should let reads of the global store and one-off runs through', () => {
    expect(globalInstalls('npm ls -g')).toEqual([])
    expect(globalInstalls('pnpm list --global')).toEqual([])
    expect(globalInstalls('yarn global list')).toEqual([])
    expect(globalInstalls('uv tool run ruff check')).toEqual([])
    expect(globalInstalls('pnpm dlx tsx script.ts')).toEqual([])
  })

  it('should say what the install does in the prompt', () => {
    expect(globalReason(['npm i -g typescript'])).toBe(
      'package-manager: `npm i -g typescript` installs globally, changing this machine rather than the project. Allow it only if you want it installed for every project.',
    )
  })
})

describe('globalManagerReason', () => {
  it('should give the global install of the preferred manager in place of another', () => {
    expect(globalManagerReason(['npm', 'i', '-g', 'typescript'], 'pnpm')).toBe(
      'package-manager: global installs here use pnpm, not npm. Run `pnpm add -g typescript` instead.',
    )
    expect(globalManagerReason(['yarn', 'global', 'add', 'serve'], 'bun')).toBe(
      'package-manager: global installs here use bun, not yarn. Run `bun add -g serve` instead.',
    )
    expect(globalManagerReason(['pipx', 'install', 'black'], 'uv')).toBe('package-manager: global installs here use uv, not pipx. Run `uv tool install black` instead.')
    expect(globalManagerReason(['uv', 'tool', 'install', 'ruff'], 'pip')).toBe('package-manager: global installs here use pipx, not uv. Run `pipx install ruff` instead.')
  })

  it('should name the manager alone where the command does not install, and pass the preferred one', () => {
    expect(globalManagerReason(['npm', 'update', '-g'], 'pnpm')).toBe('package-manager: global installs here use pnpm, not npm. Use pnpm for it instead.')
    expect(globalManagerReason(['pnpm', 'add', '-g', 'tsx'], 'pnpm')).toBeUndefined()
  })

  it('should read the setting per ecosystem, pipx as pip', () => {
    expect([...parseGlobalManagers('pnpm, pipx')]).toEqual([
      ['node', 'pnpm'],
      ['python', 'pip'],
    ])
  })
})

describe('entriesOf', () => {
  it('should read a YAML list, as pnpm writes it', () => {
    const yaml = 'catalog:\n  zod: 4.6.6\n\nminimumReleaseAgeExclude:\n  - "@heroui-pro/react@1.0.0 || 1.0.1"\n  - webpack\n\nsavePrefix: ""\n'

    expect(entriesOf(yaml, 'minimumReleaseAgeExclude')).toEqual(['@heroui-pro/react@1.0.0 || 1.0.1', 'webpack'])
  })

  it('should read a YAML map as name=value, its direct children only', () => {
    const yaml = 'allowBuilds:\n  "@heroui-pro/react": true\n  esbuild: false\n\noverrides:\n  foo:\n    bar: 1.0.0\n'

    expect(entriesOf(yaml, 'allowBuilds')).toEqual(['@heroui-pro/react=true', 'esbuild=false'])
    expect(entriesOf(yaml, 'overrides')).toEqual(['foo='])
  })

  it('should read TOML arrays, nested inline tables and full tables', () => {
    expect(entriesOf('[install]\nminimumReleaseAgeExcludes = [\n  "@types/bun",\n  "typescript@5.4.5",\n]\n', 'minimumReleaseAgeExcludes')).toEqual([
      '@types/bun',
      'typescript@5.4.5',
    ])
    expect(entriesOf('[tool.uv]\nexclude-newer-package = { httpx = false }\n', 'exclude-newer-package')).toEqual(['httpx=false'])
    expect(entriesOf('[tool.uv.exclude-newer-package]\nhttpx = false\nrich = "1 day"\n\n[project]\nname = "x"\n', 'exclude-newer-package')).toEqual([
      'httpx=false',
      'rich=1 day',
    ])
    expect(
      entriesOf('[tool.uv]\noverride-dependencies = [\n  "foo>1",\n  { package = { name = "bar" }, dependencies = ["foo>2"] },\n]\n', 'override-dependencies'),
    ).toEqual(['foo>1', '{ package={ name="bar" }, dependencies=["foo>2"] }'])
  })

  it('should read .npmrc lines', () => {
    expect(entriesOf('min-release-age=3\nmin-release-age-exclude[]=react\nmin-release-age-exclude[]=vue\n', 'min-release-age-exclude')).toEqual(['react', 'vue'])
  })
})

describe('jsonEntriesOf', () => {
  it('should read a manifest field as its leaves', () => {
    const manifest = JSON.stringify({ overrides: { lodash: '4.17.21', foo: { bar: '1.0.0' } }, trustedDependencies: ['esbuild'], pnpm: { overrides: { a: '1' } } })

    expect(jsonEntriesOf(manifest, 'overrides')).toEqual(['lodash=4.17.21', 'foo.bar=1.0.0'])
    expect(jsonEntriesOf(manifest, 'trustedDependencies')).toEqual(['esbuild'])
    expect(jsonEntriesOf(manifest, 'pnpm.overrides')).toEqual(['a=1'])
    expect(jsonEntriesOf('not json', 'overrides')).toEqual([])
  })
})

describe('secondsOf', () => {
  it('should read bare numbers in the setting unit, friendly and ISO waits', () => {
    expect(secondsOf('1440', 60)).toBe(86_400)
    expect(secondsOf('3', 86_400)).toBe(259_200)
    expect(secondsOf('3d', 1)).toBe(259_200)
    expect(secondsOf('12 hours', 1)).toBe(43_200)
    expect(secondsOf('90m', 1)).toBe(5_400)
    expect(secondsOf('P7D', 1)).toBe(604_800)
    expect(secondsOf('PT24H', 1)).toBe(86_400)
    expect(secondsOf('false', 1)).toBe(0)
    expect(secondsOf('2026-11-01', 1)).toBeNaN()
  })
})

const weak = (path: string, before: string, after: string) => weakenings(path, before, after).map(({ topic, change }) => `${topic}: ${change}`)

describe('weakenings', () => {
  it('should catch the exclude pnpm writes on its own', () => {
    const before = 'catalog:\n  zod: 4.6.6\n\nsavePrefix: ""\n'
    const after = 'catalog:\n  zod: 4.6.6\n\nminimumReleaseAgeExclude:\n  - "@heroui-pro/react@1.0.0 || 1.0.1"\n\nsavePrefix: ""\n'

    expect(weak('/repo/pnpm-workspace.yaml', before, after)).toEqual(['release-age: adds @heroui-pro/react@1.0.0 || 1.0.1 to minimumReleaseAgeExclude'])
  })

  it('should catch a lower wait, a removed wait and strict mode turned off', () => {
    expect(weak('.npmrc', 'min-release-age=7\n', 'min-release-age=1\n')).toEqual(['release-age: lowers min-release-age to 1'])
    expect(weak('bunfig.toml', '[install]\nminimumReleaseAge = 259200\n', '[install]\n')).toEqual(['release-age: removes minimumReleaseAge'])
    expect(weak('.yarnrc.yml', '', 'npmMinimalAgeGate: 0\n')).toEqual(['release-age: lowers npmMinimalAgeGate to 0'])
    expect(weak('pnpm-workspace.yaml', 'minimumReleaseAgeStrict: true\n', 'minimumReleaseAgeStrict: false\n')).toEqual([
      'release-age: sets minimumReleaseAgeStrict to false',
    ])
    expect(weak('pyproject.toml', '[tool.uv]\nexclude-newer = "1 week"\n', '[tool.uv]\nexclude-newer = "2026-11-24"\n')).toEqual([
      'release-age: changes exclude-newer to 2026-11-24',
    ])
  })

  it('should catch install scripts let through', () => {
    expect(weak('pnpm-workspace.yaml', 'allowBuilds:\n  esbuild: true\n', 'allowBuilds:\n  esbuild: true\n  sharp: true\n  core-js: false\n')).toEqual([
      'scripts: adds sharp=true to allowBuilds',
    ])
    expect(weak('pnpm-workspace.yaml', '', 'dangerouslyAllowAllBuilds: true\n')).toEqual(['scripts: sets dangerouslyAllowAllBuilds to true'])
    expect(weak('.yarnrc.yml', '', 'enableScripts: true\n')).toEqual(['scripts: sets enableScripts to true'])
    expect(weak('.npmrc', 'ignore-scripts=true\n', 'ignore-scripts=false\n')).toEqual(['scripts: sets ignore-scripts to false'])
    expect(weak('package.json', '{}', JSON.stringify({ trustedDependencies: ['esbuild'] }))).toEqual(['scripts: adds esbuild to trustedDependencies'])
    expect(weak('package.json', '{}', JSON.stringify({ dependenciesMeta: { 'core-js': { built: false }, sharp: { built: true } } }))).toEqual([
      'scripts: adds sharp.built=true to dependenciesMeta',
    ])
  })

  it('should catch overrides', () => {
    expect(weak('/repo/package.json', '{"name":"x"}', JSON.stringify({ name: 'x', pnpm: { overrides: { lodash: '4.17.21' } } }))).toEqual([
      'overrides: adds lodash=4.17.21 to pnpm.overrides',
    ])
    expect(weak('package.json', '{}', JSON.stringify({ resolutions: { lodash: '4.17.21' } }))).toEqual(['overrides: adds lodash=4.17.21 to resolutions'])
    expect(weak('pnpm-workspace.yaml', '', 'overrides:\n  lodash: 4.17.21\n')).toEqual(['overrides: adds lodash=4.17.21 to overrides'])
    expect(weak('pyproject.toml', '[tool.uv]\n', '[tool.uv]\noverride-dependencies = ["werkzeug==2.3.0"]\n')).toEqual([
      'overrides: adds werkzeug==2.3.0 to override-dependencies',
    ])
  })

  it('should let a longer wait, the default spelled out, denials and removals through', () => {
    expect(weak('pnpm-workspace.yaml', '', 'minimumReleaseAge: 1440\nminimumReleaseAgeStrict: true\n')).toEqual([])
    expect(weak('pnpm-workspace.yaml', 'minimumReleaseAge: 1440\n', '')).toEqual([])
    expect(weak('uv.toml', 'exclude-newer = "1 day"\n', 'exclude-newer = "P7D"\n')).toEqual([])
    expect(weak('pnpm-workspace.yaml', 'minimumReleaseAgeExclude:\n  - react\n', '')).toEqual([])
    expect(weak('pnpm-workspace.yaml', '', 'allowBuilds:\n  core-js: false\n')).toEqual([])
    expect(weak('package.json', '{}', JSON.stringify({ dependencies: { react: '19.0.0' } }))).toEqual([])
  })
})

describe('gatesOf, lockfileOf and commitsOf', () => {
  it('should know the guarded files by name', () => {
    expect(gatesOf('/repo/pnpm-workspace.yaml').length).toBeGreaterThan(0)
    expect(gatesOf('/Users/me/.config/pnpm/config.yaml').length).toBeGreaterThan(0)
    expect(gatesOf('/repo/config.yaml')).toEqual([])
    expect(gatesOf('apps/api/pyproject.toml').length).toBeGreaterThan(0)
    expect(gatesOf('apps/web/package.json').length).toBeGreaterThan(0)
    expect(lockfileOf('/repo/pnpm-lock.yaml')).toBe('pnpm')
    expect(lockfileOf('/repo/uv.lock')).toBe('uv')
    expect(lockfileOf('/repo/Pipfile')).toBeUndefined()
  })

  it('should read each commit, whether it takes every tracked change and where it runs', () => {
    expect(commitsOf('git commit -m "x"')).toEqual([{ all: false }])
    expect(commitsOf('git commit -am "x"')).toEqual([{ all: true }])
    expect(commitsOf('git commit --amend')).toEqual([{ all: false }])
    expect(commitsOf('git push')).toEqual([])
    expect(commitsOf('cd /tmp/repo && git add . && git commit -m "x"')).toEqual([{ all: false, cwd: '/tmp/repo' }])
    expect(commitsOf('cd apps && cd web && git commit -m "x"')).toEqual([{ all: false, cwd: 'apps/web' }])
    expect(commitsOf('git -C /tmp/repo commit -m "x"')).toEqual([{ all: false, cwd: '/tmp/repo' }])
  })
})

describe('guardReason', () => {
  it('should name every guard a change weakens', () => {
    const text = guardReason('edit', [
      { topic: 'scripts', change: 'adds sharp=true to allowBuilds' },
      { topic: 'overrides', change: 'adds lodash=1 to overrides' },
    ])

    expect(text).toContain('this edit adds sharp=true to allowBuilds; adds lodash=1 to overrides.')
    expect(text).toContain('Install scripts are how')
    expect(text).toContain('An override forces')
  })
})

describe('the hooks', () => {
  const workspace = 'catalog:\n  zod: 4.6.6\n\nsavePrefix: ""\n'

  it('should stop an Edit that adds an exclude', async ($, on) => {
    on('fs.read', () => ({ value: workspace }))
    on('tool.call', () => ({ result: {} }))

    const ran = await $.tool.call({
      tool: 'Edit',
      file_path: '/repo/pnpm-workspace.yaml',
      old_string: 'savePrefix: ""',
      new_string: 'minimumReleaseAgeExclude:\n  - react@19.1.0\n\nsavePrefix: ""',
    })

    expect(ran.deny).toContain('adds react@19.1.0 to minimumReleaseAgeExclude')
  })

  it('should let an Edit that tightens the gate through', async ($, on) => {
    on('fs.read', () => ({ value: workspace }))
    on('tool.call', () => ({ result: {} }))

    const ran = await $.tool.call({
      tool: 'Edit',
      file_path: '/repo/pnpm-workspace.yaml',
      old_string: 'savePrefix: ""',
      new_string: 'minimumReleaseAgeStrict: true\n\nsavePrefix: ""',
    })

    expect(ran.deny).toBeUndefined()
  })

  it('should stop a hand edit to a lockfile', async ($, on) => {
    on('tool.call', () => ({ result: {} }))

    const ran = await $.tool.call({ tool: 'Write', file_path: '/repo/pnpm-lock.yaml', content: 'lockfileVersion: 9.0\n' })

    expect(ran.deny).toBe("package-manager: pnpm-lock.yaml is pnpm's lockfile. Change the manifest and run pnpm to rewrite it, rather than editing it by hand.")
  })

  it('should stop a commit that carries an override, wherever it runs', async ($, on) => {
    const before = JSON.stringify({ name: 'web' })
    const git: Record<string, string> = {
      'rev-parse --show-toplevel': '/repo\n',
      'diff --cached --name-only': 'apps/web/package.json\n',
      'show HEAD:apps/web/package.json': before,
      'show :apps/web/package.json': JSON.stringify({ name: 'web', overrides: { lodash: '4.17.21' } }),
    }

    on('process.run', (_, e) => ({
      value: { exitCode: 0, stdout: e.init?.cwd === '/repo' ? (git[e.argv.slice(1).join(' ')] ?? '') : '', stderr: '' },
    }))
    on('tool.call', () => ({ result: {} }))

    const ran = await $.tool.call({ tool: 'Bash', command: 'cd /repo && git add -A && git commit -m "chore: pin lodash"' })

    expect(ran.deny).toContain('apps/web/package.json adds lodash=4.17.21 to overrides')
  })

  it('should hand back the command the project manager runs, exec for an installed tool', async ($, on) => {
    on('session.cwd', () => ({ value: '/repo/apps/web' }))
    on('fs.list', (_, e) => ({ value: e.path === '/repo' ? [{ name: 'pnpm-lock.yaml' }, { name: '.git' }] : [] }))
    on('fs.exists', (_, e) => ({ value: e.path === '/repo/node_modules/.bin/tsc' || e.path === '/repo/.git' }))
    on('fs.read', () => ({ value: '' }))
    on('tool.call', () => ({ result: {} }))

    expect((await $.tool.call({ tool: 'Bash', command: 'npx tsc --noEmit -p "tsconfig app.json"' })).deny).toBe(
      'package-manager: this project uses pnpm (pnpm-lock.yaml), not npx. Run `pnpm exec tsc --noEmit -p "tsconfig app.json"` instead.',
    )
    expect((await $.tool.call({ tool: 'Bash', command: 'npx create-vite app' })).deny).toBe(
      'package-manager: this project uses pnpm (pnpm-lock.yaml), not npx. Run `pnpm dlx create-vite app` instead.',
    )
  })

  it('should read the project from the directory a command moves to', async ($, on) => {
    on('session.cwd', () => ({ value: '/home' }))
    on('fs.list', (_, e) => ({ value: e.path === '/work/app' ? [{ name: 'pnpm-lock.yaml' }, { name: '.git' }] : [] }))
    on('fs.exists', (_, e) => ({ value: e.path === '/work/app/node_modules/.bin/tsc' || e.path === '/work/app/.git' }))
    on('fs.read', () => ({ value: '' }))
    on('tool.call', () => ({ result: {} }))

    expect((await $.tool.call({ tool: 'Bash', command: 'npx tsc' })).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Bash', command: 'cd /work/app && npx tsc' })).deny).toBe(
      'package-manager: this project uses pnpm (pnpm-lock.yaml), not npx. Run `pnpm exec tsc` instead.',
    )
  })


  it('should ask the user before a global install, even where a rule allows it', async ($, on) => {
    on('tool.check', () => ({ decision: 'allow' }))

    const asked = await $.tool.check({ tool: 'Bash', input: { command: 'npm i -g typescript' } })

    expect(asked.decision).toBe('ask')
    expect(asked.reason).toContain('`npm i -g typescript` installs globally')
  })

  it('should keep a deny beneath and leave other commands to the rules', async ($, on) => {
    on('tool.check', (_, e) => ({ decision: (e.input as { command: string }).command.includes('-g') ? 'deny' : 'allow' }))

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'npm i -g typescript' } })).decision).toBe('deny')
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'pnpm install' } })).decision).toBe('allow')
  })

  it('should stop a global install with another manager than the preferred one, in any project', { options: { globalManager: 'pnpm' } }, async ($, on) => {
    on('session.cwd', () => ({ value: '/work/app' }))
    on('fs.list', (_, e) => ({ value: e.path === '/work/app' ? [{ name: 'package-lock.json' }, { name: '.git' }] : [] }))
    on('fs.read', () => ({ value: '' }))
    on('tool.call', () => ({ result: {} }))

    expect((await $.tool.call({ tool: 'Bash', command: 'npm i -g typescript' })).deny).toBe(
      'package-manager: global installs here use pnpm, not npm. Run `pnpm add -g typescript` instead.',
    )
    expect((await $.tool.call({ tool: 'Bash', command: 'pnpm add -g typescript' })).deny).toBeUndefined()
  })

  it('should put a global install to the user rather than the auto-mode classifier', async ($, on) => {
    on('tool.judge', () => ({ decision: 'allow' }))

    const judged = await $.tool.judge({ tool: 'Bash', input: { command: 'npm i -g typescript' }, tool_use_id: 'call-1' })

    expect(judged.decision).toBe('ask')
    expect(judged.reason).toContain('`npm i -g typescript` installs globally')
    expect((await $.tool.judge({ tool: 'Bash', input: { command: 'pnpm install' }, tool_use_id: 'call-2' })).decision).toBe('allow')
  })
})
