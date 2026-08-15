import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { readPeerDependencies } from './dsh-version.mjs'

const execFileAsync = promisify(execFile)
const packageName = 'dsh-request-flight-recorder'

function smokeSource() {
  return `
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import RequestFlightRecorder, {
  FLIGHT_LIMITS,
  FLIGHT_RECORDER_PROTOCOL_VERSION,
  FLIGHT_RECORD_SCHEMA_VERSION,
  RequestAttemptId,
} from 'dsh-request-flight-recorder'
import { apply as applyInvariant } from 'dsh-request-flight-recorder/invariant'

const ctx = new Context()

try {
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt, {
    includeHarnessIdentity: false,
    persona: '',
  })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(RequestFlightRecorder, { capacity: 2 })

  const health = ctx.requestFlightRecorder.health()
  const snapshot = ctx.requestFlightRecorder.snapshot()
  const unsubscribe = ctx.requestFlightRecorder.subscribe(() => {
    throw new Error('空状态不应发送订阅通知')
  })
  unsubscribe()
  if (
    ctx.requestFlightRecorder.list().length !== 0
    || ctx.requestFlightRecorder.latest() !== undefined
    || health.captured !== 0
    || health.retained !== 0
    || snapshot.revision !== 0
    || snapshot.records.length !== 0
    || FLIGHT_LIMITS.tools !== 128
    || FLIGHT_RECORDER_PROTOCOL_VERSION !== 1
    || FLIGHT_RECORD_SCHEMA_VERSION !== 1
    || RequestAttemptId('probe') !== 'probe'
    || ctx.requestFlightRecorder.info().protocolVersion !== 1
  ) {
    throw new Error('新挂载的记录器不是空状态')
  }

  const disposeInvariant = await applyInvariant(ctx)
  await disposeInvariant()
} finally {
  await ctx.fiber.dispose()
}
`
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 1) {
    console.error('用法：node scripts/smoke-packed.mjs <tarball-path>')
    process.exitCode = 1
    return
  }

  const tarballPath = resolve(args[0])
  const tarball = await stat(tarballPath)
  if (!tarball.isFile()) {
    throw new Error(`打包产物不是文件：${tarballPath}`)
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-flight-recorder-'))

  try {
    const peerDependencies = await readPeerDependencies()
    const manifest = {
      name: 'dsh-request-flight-recorder-smoke',
      private: true,
      type: 'module',
      packageManager: 'pnpm@11.7.0',
      dependencies: {
        ...peerDependencies,
        [packageName]: `file:${tarballPath}`,
      },
    }

    await writeFile(
      join(temporaryRoot, 'package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
    await writeFile(join(temporaryRoot, 'smoke.mjs'), smokeSource())

    await execFileAsync(
      'pnpm',
      [
        'install',
        '--ignore-scripts',
        '--lockfile=false',
        '--strict-peer-dependencies',
      ],
      {
        cwd: temporaryRoot,
        env: {
          ...process.env,
          COREPACK_ENABLE_PROJECT_SPEC: '0',
        },
      },
    )
    await execFileAsync(process.execPath, ['smoke.mjs'], {
      cwd: temporaryRoot,
    })
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`打包烟测失败：${message}`)
  process.exitCode = 1
})
