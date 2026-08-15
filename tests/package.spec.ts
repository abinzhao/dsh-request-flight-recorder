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
  }
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

    expect(manifest.version).toBe('1.0.0')
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
      'lib/index.d.mts',
      'lib/invariant.d.mts',
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

  it('keeps generated library output visible to Git', async () => {
    const ignored = (await readProjectFile('.gitignore'))
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(Boolean)

    expect(ignored).not.toContain('lib/')
  })
})

describe('distribution automation contract', () => {
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

    for (const [name, version] of Object.entries(manifest.peerDependencies)) {
      expect(smoke).toContain(name)
      expect(smoke).toContain(version)
    }
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
        'node scripts/smoke-packed.mjs .artifacts/dsh-request-flight-recorder-1.0.0.tgz',
    ]) {
      expect(workflow).toContain(command)
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
      expect(readme).toContain('1.0.0')
      expect(readme).toContain('^22.19.0 || ^24.0.0')
      expect(readme).toContain(alternateLanguage)
      expect(readme).toContain('/flight list')
      expect(readme).toContain('/flight list 20')
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

  it('keeps release history for v1, v0.2, and v0.1', async () => {
    const changelog = await readProjectFile('CHANGELOG.md')

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
