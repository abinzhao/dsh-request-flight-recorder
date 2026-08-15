import { execFile } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const EXACT_RC = /^0\.1\.0-rc\.\d+$/u
const EXCLUDED = new Set([
  '.artifacts',
  '.git',
  'coverage',
  'node_modules',
])

async function run(command, args, cwd) {
  return execFileAsync(command, args, {
    cwd,
    env: {
      ...process.env,
      COREPACK_ENABLE_PROJECT_SPEC: '0',
    },
    maxBuffer: 32 * 1024 * 1024,
  })
}

async function copyRepository(source, target) {
  await cp(source, target, {
    recursive: true,
    filter(path) {
      const pathFromRoot = relative(source, path)
      if (pathFromRoot === '') return true
      const [top] = pathFromRoot.split(/[\\/]/u)
      return !EXCLUDED.has(top)
    },
  })
}

function replaceDshVersions(manifest, candidate) {
  for (const section of ['peerDependencies', 'devDependencies']) {
    const dependencies = manifest[section]
    if (dependencies === undefined) continue
    for (const name of Object.keys(dependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) {
        dependencies[name] = candidate
      }
    }
  }
}

function errorDetail(error) {
  if (!(error instanceof Error)) return String(error)
  const processError = error
  return [
    processError.message,
    typeof processError.stdout === 'string' ? processError.stdout : '',
    typeof processError.stderr === 'string' ? processError.stderr : '',
  ].filter(Boolean).join('\n')
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 1 || !EXACT_RC.test(args[0])) {
    console.error(
      '用法：node scripts/verify-dsh-candidate.mjs <0.1.0-rc.N>',
    )
    process.exitCode = 1
    return
  }

  const candidate = args[0]
  const source = resolve(process.cwd())
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-flight-candidate-'))
  const copy = join(temporaryRoot, basename(source))
  let stage = 'copy'

  try {
    await copyRepository(source, copy)
    const manifestPath = join(copy, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    replaceDshVersions(manifest, candidate)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const commands = [
      ['install', 'pnpm', [
        'install',
        '--lockfile=false',
        '--strict-peer-dependencies',
      ]],
      ['test', 'pnpm', ['test:coverage']],
      ['typecheck', 'pnpm', ['typecheck']],
      ['build', 'pnpm', ['build']],
      ['publint', 'pnpm', ['exec', 'publint']],
    ]
    for (const [nextStage, command, commandArgs] of commands) {
      stage = nextStage
      await run(command, commandArgs, copy)
    }

    stage = 'pack'
    const artifacts = join(copy, '.artifacts')
    await mkdir(artifacts)
    await run('pnpm', ['pack', '--pack-destination', artifacts], copy)

    stage = 'smoke'
    const tarball = join(
      artifacts,
      `${manifest.name}-${manifest.version}.tgz`,
    )
    await run(
      process.execPath,
      ['scripts/smoke-packed.mjs', tarball],
      copy,
    )
    console.log(`兼容：${candidate}`)
  } catch (error) {
    const detail = errorDetail(error)
    console.error(`不兼容：${candidate}（阶段：${stage}）\n${detail}`)
    process.exitCode = 1
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

await main()
