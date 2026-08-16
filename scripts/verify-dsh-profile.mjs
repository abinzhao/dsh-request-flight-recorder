import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { readSupportedDshVersion } from './dsh-version.mjs'

const execFileAsync = promisify(execFile)
const STARTUP_TIMEOUT_MS = 30_000

async function reservePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null
    ? address.port
    : undefined
  await new Promise((resolveClose, reject) => {
    server.close(error => {
      if (error === undefined) resolveClose()
      else reject(error)
    })
  })
  if (port === undefined) throw new Error('无法分配临时端口')
  return port
}

async function run(command, args, env, cwd = process.cwd()) {
  return execFileAsync(command, args, {
    cwd,
    env,
    maxBuffer: 16 * 1024 * 1024,
  })
}

async function waitForHttp(url, child, output) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `DSH Web 在启动前退出（${child.exitCode}）：${output()}`,
      )
    }
    try {
      const response = await fetch(url)
      if (response.status === 200) return
    } catch {
      // The server has not bound yet.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`DSH Web 启动超时：${output()}`)
}

async function stop(child) {
  if (child.exitCode !== null) return child.exitCode
  child.kill('SIGTERM')
  const code = await Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('DSH Web 未在 SIGTERM 后退出')), 10_000)
    }),
  ])
  return code
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 1) {
    console.error('用法：node scripts/verify-dsh-profile.mjs <tarball-path>')
    process.exitCode = 1
    return
  }

  const tarballPath = resolve(args[0])
  const tarball = await stat(tarballPath)
  if (!tarball.isFile()) throw new Error(`打包产物不是文件：${tarballPath}`)

  const version = await readSupportedDshVersion()
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-flight-profile-'))
  const home = join(temporaryRoot, 'home')
  const cliRoot = join(temporaryRoot, 'cli')
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    COREPACK_ENABLE_PROJECT_SPEC: '0',
  }
  const dshSpec = `@deepseek-ai/dsh@${version}`
  await mkdir(cliRoot)
  await writeFile(join(cliRoot, 'package.json'), JSON.stringify({
    name: 'dsh-flight-profile-cli',
    private: true,
    packageManager: 'pnpm@11.7.0',
  }))
  await writeFile(
    join(cliRoot, 'pnpm-workspace.yaml'),
    'onlyBuiltDependencies:\n  - node-pty\n',
  )
  await run(
    'pnpm',
    ['add', '--lockfile=false', dshSpec],
    env,
    cliRoot,
  )
  const dshBin = join(cliRoot, 'node_modules', '.bin', 'dsh')
  let child

  try {
    await run(
      dshBin,
      ['plugin', '--profile', 'web', 'add', tarballPath],
      env,
    )
    const dump = await run(
      dshBin,
      ['--profile', 'web', '--dump-config'],
      env,
    )
    const rows = dump.stdout.match(/id: request-flight-recorder/gu) ?? []
    if (rows.length !== 1) {
      throw new Error(
        `Profile 必须合成且仅合成一个 request-flight-recorder 行，实际 ${rows.length}`,
      )
    }

    const port = await reservePort()
    let stdout = ''
    let stderr = ''
    child = spawn(
      dshBin,
      [
        '--profile',
        'web',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const output = () => `${stdout}\n${stderr}`.trim()

    await waitForHttp(`http://127.0.0.1:${port}/`, child, output)
    const code = await stop(child)
    if (code !== 0) {
      throw new Error(`DSH Web 退出码 ${String(code)}：${output()}`)
    }
    child = undefined
    console.log(`兼容 Profile：DeepSeek Harness ${version}`)
  } finally {
    if (child !== undefined) {
      try {
        await stop(child)
      } catch {
        child.kill('SIGKILL')
      }
    }
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`DSH Profile 验证失败：${message}`)
  process.exitCode = 1
})
