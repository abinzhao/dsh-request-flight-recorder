import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

interface PackageManifest {
  readonly version: string
  readonly repository?: {
    readonly type: string
    readonly url: string
  }
  readonly homepage?: string
  readonly bugs?: {
    readonly url: string
  }
  readonly author: string
  readonly license: string
  readonly engines: {
    readonly node: string
  }
  readonly publishConfig: {
    readonly access: string
    readonly registry: string
  }
  readonly keywords: readonly string[]
  readonly dsh: {
    readonly bundle: {
      readonly patch: string
    }
    readonly client: {
      readonly inject: readonly string[]
      readonly platform: string
      readonly immediately: boolean
    }
  }
  readonly exports: Readonly<Record<string, unknown>>
  readonly scripts: Readonly<Record<string, string>>
  readonly files: readonly string[]
  readonly peerDependencies: Readonly<Record<string, string>>
}

async function readProjectFile(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8')
}

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(
    await readProjectFile('package.json'),
  ) as PackageManifest
}

describe('package contract', () => {
  it('publishes the exact v1 repository metadata', async () => {
    const manifest = await readManifest()

    expect(manifest.version).toBe('1.1.0')
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/abinzhao/dsh-request-flight-recorder.git',
    })
    expect(manifest.homepage).toBe(
      'https://github.com/abinzhao/dsh-request-flight-recorder#readme',
    )
    expect(manifest.bugs).toEqual({
      url: 'https://github.com/abinzhao/dsh-request-flight-recorder/issues',
    })
    expect(manifest.author).toBe('abinzhao')
    expect(manifest.license).toBe('MIT')
    expect(manifest.engines).toEqual({
      node: '^22.19.0 || ^24.0.0',
    })
    expect(manifest.publishConfig).toEqual({
      access: 'public',
      registry: 'https://registry.npmjs.org/',
    })
    expect(manifest.keywords).toEqual([
      'dsh',
      'dsh-plugin',
      'deepseek-harness',
      'diagnostics',
      'observability',
      'debugging',
      'llm',
      'developer-tools',
    ])
  })

  it('points to one official Bundle patch row', async () => {
    const manifest = await readManifest()
    const patch = load(await readProjectFile('cordis.patch.yml'))

    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(patch).toEqual([
      {
        insert: [
          {
            id: 'request-flight-recorder',
            name: 'dsh-request-flight-recorder',
            config: {
              capacity: 128,
              slowFirstChunkMs: 1000,
              slowTotalMs: 2000,
            },
          },
        ],
      },
    ])
  })

  it('builds only during packing and ships the public package files', async () => {
    const manifest = await readManifest()

    expect(manifest.scripts).not.toHaveProperty('prepare')
    expect(manifest.scripts.prepack).toBe('pnpm build')
    expect(manifest.files).toEqual([
      'lib/index.mjs',
      'lib/invariant.mjs',
      'lib/client.cjs',
      'lib/index.d.mts',
      'lib/invariant.d.mts',
      'lib/client.d.cts',
      'cordis.patch.yml',
      'README.md',
      'README.zh-CN.md',
      'CHANGELOG.md',
      'SECURITY.md',
      'docs/api.md',
      'docs/data-schema.md',
      'docs/privacy-threat-model.md',
      'docs/architecture.md',
      'docs/compatibility.md',
      'docs/migration.md',
      'docs/benchmarks.md',
      'examples/read-only-consumer.ts',
      'LICENSE',
    ])
  })

  it('ships one Web-only Client Half for initial locale synchronization', async () => {
    const manifest = await readManifest()
    const build = await readProjectFile('tsdown.config.ts')

    expect(manifest.exports['./client']).toEqual({
      types: './lib/client.d.cts',
      default: './lib/client.cjs',
    })
    expect(manifest.files).toContain('lib/client.cjs')
    expect(manifest.files).toContain('lib/client.d.cts')
    expect(manifest.dsh.client).toEqual({
      inject: [
        '@deepseek-ai/dsh-api-remotes',
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-settings',
        '@deepseek-ai/dsh-client-locale',
      ],
      platform: 'web',
      immediately: true,
    })
    for (const dependency of manifest.dsh.client.inject) {
      expect(manifest.peerDependencies[dependency]).toBe('0.1.0-rc.6')
    }
    expect(build).toContain("client: 'src/client/index.ts'")
    const client = await readProjectFile('lib/client.cjs')
    expect(client).toContain('window.__ModuleLoader__.load({')
    expect(client).toContain('id: "dsh-request-flight-recorder"')
    expect(client).toContain('return module.exports')
    expect(client).not.toMatch(/^export /mu)
  })

  it('keeps generated library output visible to Git', async () => {
    const ignored = (await readProjectFile('.gitignore'))
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(Boolean)

    expect(ignored).not.toContain('lib/')
  })
})

describe('distribution automation contract', () => {
  it('derives one exact supported DSH RC without a duplicated version table', async () => {
    const helper = await readProjectFile('scripts/dsh-version.mjs')
    const smoke = await readProjectFile('scripts/smoke-packed.mjs')

    expect(helper).toContain('readSupportedDshVersion')
    expect(helper).toContain('/^0\\.1\\.0-rc\\.\\d+$/u')
    expect(smoke).toContain('readPeerDependencies')
    expect(smoke).not.toContain('const peerDependencies = {')
  })

  it('defines a packed-consumer smoke script with exact peer coverage', async () => {
    const manifest = await readManifest()
    const smoke = await readProjectFile('scripts/smoke-packed.mjs')

    expect(manifest.scripts['smoke:packed']).toBe(
      'node scripts/smoke-packed.mjs',
    )
    expect(smoke).toContain('mkdtemp')
    expect(smoke).toContain('execFile')
    expect(smoke).toContain('dsh-request-flight-recorder/invariant')
    expect(smoke).toContain('requestFlightRecorder')
    expect(smoke).toContain('fiber.dispose')
    expect(smoke).toContain('FLIGHT_LIMITS')
    expect(smoke).toContain('FLIGHT_RECORDER_PROTOCOL_VERSION')
    expect(smoke).toContain('FLIGHT_RECORD_SCHEMA_VERSION')
    expect(smoke).toContain('RequestAttemptId')
      expect(smoke).toContain('snapshot()')
      expect(smoke).toContain('subscribe(')

    expect(Object.keys(manifest.peerDependencies).length).toBeGreaterThan(0)
    expect(smoke).toContain('const peerDependencies = await readPeerDependencies()')
    expect(smoke).toContain('...peerDependencies')
  })

  it('requires exactly one tarball path', async () => {
    const script = fileURLToPath(
      new URL('../scripts/smoke-packed.mjs', import.meta.url),
    )

    for (const args of [[], ['first.tgz', 'second.tgz']]) {
      await expect(
        execFileAsync(process.execPath, [script, ...args]),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('用法'),
      })
    }
  })

  it('defines an isolated public DSH profile gate', async () => {
    const manifest = await readManifest()
    const script = await readProjectFile('scripts/verify-dsh-profile.mjs')

    expect(manifest.scripts['verify:dsh-profile']).toBe(
      'node scripts/verify-dsh-profile.mjs',
    )
    for (const token of [
      'mkdtemp',
      'DSH_HOME',
      '@deepseek-ai/dsh@',
      'plugin',
      'add',
      '--dump-config',
      '--port',
      'request-flight-recorder',
      'SIGTERM',
    ]) {
      expect(script).toContain(token)
    }
    expect(script).toContain("onlyBuiltDependencies: ['node-pty']")
    expect(script).not.toContain("'--ignore-scripts'")
  })

  it('defines an isolated browser locale synchronization gate', async () => {
    const manifest = await readManifest()

    expect(manifest.scripts['verify:dsh-locale']).toBe(
      'node scripts/verify-dsh-locale.mjs',
    )
    const script = await readProjectFile('scripts/verify-dsh-locale.mjs')
    for (const token of [
      'chromium',
      'newContext',
      'locale',
      'DSH_HOME',
      'settings.yaml',
      'preference',
      'SIGTERM',
      'rm(',
    ]) {
      expect(script).toContain(token)
    }
    expect(script).toContain("onlyBuiltDependencies: ['node-pty']")
    expect(script).not.toContain("'--ignore-scripts'")
  })

  it('defines a non-mutating candidate RC verifier with strict arguments', async () => {
    const manifest = await readManifest()
    const script = fileURLToPath(
      new URL('../scripts/verify-dsh-candidate.mjs', import.meta.url),
    )

    expect(manifest.scripts['verify:dsh-candidate']).toBe(
      'node scripts/verify-dsh-candidate.mjs',
    )
    for (const args of [
      [],
      ['0.1.0-rc.6', '0.1.0-rc.7'],
      ['latest'],
    ]) {
      await expect(
        execFileAsync(process.execPath, [script, ...args]),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('用法'),
      })
    }
  })

  it('runs every release gate in CI', async () => {
    const workflow = await readProjectFile('.github/workflows/ci.yml')

      expect(workflow).toContain('node: [22.19.0, 24]')
      expect(workflow).toContain('node-version: ${{ matrix.node }}')
      expect(workflow).toContain("matrix.node == '22.19.0'")
    for (const command of [
      'pnpm install --frozen-lockfile',
      'pnpm test:coverage',
      'pnpm typecheck',
      'pnpm build',
      'git diff --exit-code -- lib',
      'pnpm exec publint',
      'mkdir -p .artifacts && pnpm pack --pack-destination .artifacts',
        'node scripts/smoke-packed.mjs .artifacts/dsh-request-flight-recorder-1.1.0.tgz',
        'node scripts/verify-dsh-profile.mjs .artifacts/dsh-request-flight-recorder-1.1.0.tgz',
        'pnpm exec playwright install --with-deps chromium',
        'node scripts/verify-dsh-locale.mjs .artifacts/dsh-request-flight-recorder-1.1.0.tgz',
    ]) {
      expect(workflow).toContain(command)
    }
  })

  it('observes new DSH release candidates without repository writes', async () => {
    const workflow = await readProjectFile(
      '.github/workflows/dsh-compatibility.yml',
    )

    expect(workflow).toContain("cron: '17 3 * * *'")
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('contents: read')
    expect(workflow).toContain(
      'npm view @deepseek-ai/dsh dist-tags --json',
    )
    expect(workflow).toContain('pnpm verify:dsh-candidate')
    expect(workflow).toContain('$GITHUB_STEP_SUMMARY')
    for (const forbidden of [
      'git push',
      'gh pr create',
      'npm publish',
      'contents: write',
    ]) {
      expect(workflow).not.toContain(forbidden)
    }
  })
})

describe('public documentation contract', () => {
  const installationCommands = [
    'dsh plugin --profile web add dsh-request-flight-recorder',
    'dsh plugin --profile web add "github:abinzhao/dsh-request-flight-recorder#<commit-sha>"',
    'dsh plugin --profile web add .',
    'dsh --profile web --dump-config',
    'dsh plugin --profile web remove dsh-request-flight-recorder',
  ] as const

  it.each([
    ['README.md', './README.zh-CN.md'],
    ['README.zh-CN.md', './README.md'],
  ])(
    '%s documents official installation, compatibility, and privacy',
    async (path, alternateLanguage) => {
      const readme = await readProjectFile(path)

      for (const command of installationCommands) {
        expect(readme).toContain(command)
      }

      expect(readme).not.toContain('dsh plugins install')
      expect(readme).toContain('0.1.0-rc.6')
      expect(readme).toContain('1.1.0')
      expect(readme).toContain('^22.19.0 || ^24.0.0')
      expect(readme).toContain(alternateLanguage)
      expect(readme).toContain('/flight list')
      expect(readme).toContain('/flight list 20')
      for (const command of [
        '/flight list failed',
        '/flight list slow',
        '/flight list truncated',
        '/flight explain <',
        '/flight stats',
      ]) {
        expect(readme).toContain(command)
      }
      for (const token of [
        'slowFirstChunkMs',
        'slowTotalMs',
        'zh',
        'en',
        '1000',
        '2000',
      ]) {
        expect(readme).toContain(token)
      }
      expect(readme).toMatch(/next command|下一条命令/iu)
      expect(readme).toMatch(/restart|重启/iu)
      expect(readme).toMatch(/browser|浏览器/iu)
      expect(readme).toMatch(/fallback|回退/iu)
      expect(readme).toContain('FLIGHT_RECORDER_PROTOCOL_VERSION')
      expect(readme).toContain('FLIGHT_RECORD_SCHEMA_VERSION')
      expect(readme).toContain('snapshot()')
      expect(readme).toContain('subscribe(')
      for (const limit of [
        'nameCharacters',
        'tools',
        'promptSections',
        'promptContexts',
        'promptVariables',
        'messageCounterKeys',
        'toolSchemaNodes',
      ]) {
        expect(readme).toContain(limit)
      }
      for (const document of [
        './docs/api.md',
        './docs/data-schema.md',
        './docs/privacy-threat-model.md',
        './docs/architecture.md',
        './docs/compatibility.md',
        './docs/migration.md',
        './docs/benchmarks.md',
      ]) {
        expect(readme).toContain(document)
      }
      expect(readme).toMatch(/command result text|命令结果文本/iu)
      expect(readme).toMatch(/persist|持久化/iu)
      expect(readme).toMatch(/prompt (?:text|正文)|Prompt 正文/u)
      expect(readme).toMatch(/message (?:content|正文)|消息正文/u)
      expect(readme).toMatch(/tool arguments|工具参数/iu)
      expect(readme).toMatch(/variable values|变量值/iu)
    },
  )

  it('ships factual v1 contracts and a typed read-only consumer', async () => {
    const api = await readProjectFile('docs/api.md')
    const schema = await readProjectFile('docs/data-schema.md')
    const privacy = await readProjectFile('docs/privacy-threat-model.md')
    const architecture = await readProjectFile('docs/architecture.md')
    const compatibility = await readProjectFile('docs/compatibility.md')
    const migration = await readProjectFile('docs/migration.md')
    const benchmarks = await readProjectFile('docs/benchmarks.md')
    const example = await readProjectFile('examples/read-only-consumer.ts')

    expect(api).toContain('FlightRecorderReader')
    expect(api).toContain('FlightRecorderSnapshot')
    expect(schema).toContain('schemaVersion')
    expect(schema).toContain('omissions')
    expect(privacy).toContain('error message')
    expect(privacy).toContain('non-error-thrown')
    expect(privacy).toContain('locale.preference')
    expect(privacy).toMatch(/Client Half/iu)
    expect(privacy).toMatch(
      /cannot access Sessions\s+or flight records|无法访问 Session 或飞行记录/iu,
    )
    expect(architecture).toContain('registerHarnessAdapter')
    expect(architecture).toContain('setImmediate')
    expect(compatibility).toContain('0.1.0-rc.6')
    expect(compatibility).toMatch(/unsupported/iu)
    expect(migration).toContain('correlationMissesByReason')
    expect(migration).toContain('^22.19.0 || ^24.0.0')
    expect(benchmarks).toContain('Median')
    expect(benchmarks).toContain('P95')
    expect(benchmarks).toContain('pnpm bench')
    expect(example).toContain('FlightRecorderReader')
    expect(example).toContain('.snapshot()')
    expect(example).toContain('.subscribe(')
  })

  it('documents blocking and observational DSH compatibility automation', async () => {
    const english = await readProjectFile('README.md')
    const chinese = await readProjectFile('README.zh-CN.md')
    const compatibility = await readProjectFile('docs/compatibility.md')

    for (const document of [english, chinese, compatibility]) {
      expect(document).toContain('verify:dsh-profile')
      expect(document).toContain('verify:dsh-candidate')
      expect(document).toMatch(/blocking|阻断/iu)
      expect(document).toMatch(/observational|观察/iu)
    }
    for (const layer of [
      'install',
      'typecheck',
      'compose',
      'boot',
      'Agent Loop',
      'command',
      'privacy',
      'cleanup',
    ]) {
      expect(compatibility).toContain(layer)
    }
  })

  it('documents deep recorder ownership and atomic command reads', async () => {
    const architecture = await readProjectFile('docs/architecture.md')

    for (const term of [
      'FlightRecorderState',
      'registerHarnessAdapter',
      'transaction',
      'one atomic Snapshot',
      'does not know DSH event payloads',
    ]) {
      expect(architecture).toContain(term)
    }
  })

  it('keeps release history for v1.1, v1, v0.2, and v0.1', async () => {
    const changelog = await readProjectFile('CHANGELOG.md')

    expect(changelog).toContain('## [1.1.0]')
    expect(changelog).toContain('## [1.0.0]')
    expect(changelog).toContain('## [0.2.0]')
    expect(changelog).toContain('## [0.1.0]')
  })

  it('documents private security reporting without sensitive disclosure', async () => {
    const security = await readProjectFile('SECURITY.md')

    expect(security).toContain(
      'https://github.com/abinzhao/dsh-request-flight-recorder/security/advisories/new',
    )
    expect(security).toMatch(/do not open a public issue/iu)
    expect(security).toMatch(/credentials|凭证/iu)
    expect(security).toMatch(/logs|日志/iu)
  })

  it('documents the required contribution verification workflow', async () => {
    const contributing = await readProjectFile('CONTRIBUTING.md')

    expect(contributing).toMatch(/RED/iu)
    expect(contributing).toMatch(/GREEN/iu)
    expect(contributing).toContain('pnpm check')
    expect(contributing).toContain('pnpm build')
    expect(contributing).toContain('lib/')
  })
})
