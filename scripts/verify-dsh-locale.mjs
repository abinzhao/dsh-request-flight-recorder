import { execFile, spawn } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { load, dump } from 'js-yaml'
import { chromium } from 'playwright'
import { readSupportedDshVersion } from './dsh-version.mjs'
import {
  commandErrorDetail,
  navigateWhenReady,
} from './web-gate.mjs'

const execFileAsync = promisify(execFile)
const STARTUP_TIMEOUT_MS = 30_000
const PREFERENCE_TIMEOUT_MS = 15_000

const cases = [
  {
    name: 'English browser initializes English',
    browserLocale: 'en-US',
    expected: 'en',
  },
  {
    name: 'Chinese browser initializes Chinese',
    browserLocale: 'zh-CN',
    expected: 'zh',
  },
  {
    name: 'Explicit Chinese preference is preserved',
    browserLocale: 'en-US',
    seed: 'zh',
    expected: 'zh',
  },
]

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
  try {
    return await execFileAsync(command, args, {
      cwd,
      env,
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    throw new Error(commandErrorDetail(error), { cause: error })
  }
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
  return Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('DSH Web 未在 SIGTERM 后退出')), 10_000)
    }),
  ])
}

async function readPreference(path) {
  try {
    const document = load(await readFile(path, 'utf8'))
    return document?.locale?.preference
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function waitForPreference(path, expected) {
  const deadline = Date.now() + PREFERENCE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await readPreference(path) === expected) return
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`Host 未在超时前保存预期语言 ${expected}`)
}

async function hasClientMarker(page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource')
      .map(entry => entry.name)
      .filter(url => url.startsWith(location.origin) && /\.js(?:\?|$)/u.test(url))
    for (const url of urls) {
      try {
        if ((await (await fetch(url)).text()).includes(
          'request-flight-recorder',
        )) {
          return true
        }
      } catch {
        // A diagnostic fetch failure does not alter the browser case.
      }
    }
    return false
  })
}

async function verifyCase(testCase, dshBin, tarballPath, rootEnv, root) {
  const home = join(root, `home-${testCase.expected}-${Date.now()}`)
  const settingsPath = join(home, 'settings.yaml')
  const env = {
    ...rootEnv,
    DSH_HOME: home,
  }
  await mkdir(home)
  if (testCase.seed !== undefined) {
    await writeFile(settingsPath, dump({
      locale: { preference: testCase.seed },
    }))
  }

  let child
  let browser
  try {
    await run(
      dshBin,
      ['plugin', '--profile', 'web', 'add', tarballPath],
      env,
    )
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
    const url = `http://127.0.0.1:${port}/`
    await waitForHttp(url, child, output)

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      locale: testCase.browserLocale,
    })
    const page = await context.newPage()
    const pageErrors = []
    const consoleErrors = []
    let requestFailures = 0
    page.on('pageerror', error => {
      pageErrors.push(`${error.name}: ${error.message}`.slice(0, 500))
    })
    page.on('console', message => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text().slice(0, 500))
      }
    })
    page.on('requestfailed', () => {
      requestFailures += 1
    })
    await navigateWhenReady(page, url, child, output)
    try {
      await waitForPreference(settingsPath, testCase.expected)
    } catch (error) {
      const marker = await hasClientMarker(page)
      throw new Error(
        `${error.message}; client=${String(marker)}`
        + ` pageErrors=${JSON.stringify(pageErrors.slice(0, 2))}`
        + ` consoleErrors=${JSON.stringify(consoleErrors.slice(0, 1))}`
        + ` requestFailures=${requestFailures}`,
      )
    }
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForPreference(settingsPath, testCase.expected)
    if (pageErrors.length > 0) {
      throw new Error(`浏览器页面错误数量：${pageErrors.length}`)
    }
    await context.close()
    await browser.close()
    browser = undefined

    const code = await stop(child)
    if (code !== 0) {
      throw new Error(`DSH Web 退出码 ${String(code)}：${output()}`)
    }
    child = undefined
    console.log(`通过：${testCase.name}`)
  } finally {
    if (browser !== undefined) await browser.close()
    if (child !== undefined) {
      try {
        await stop(child)
      } catch {
        child.kill('SIGKILL')
      }
    }
    await rm(home, { recursive: true, force: true })
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 1) {
    console.error('用法：node scripts/verify-dsh-locale.mjs <tarball-path>')
    process.exitCode = 1
    return
  }

  const tarballPath = resolve(args[0])
  const tarball = await stat(tarballPath)
  if (!tarball.isFile()) throw new Error(`打包产物不是文件：${tarballPath}`)

  const version = await readSupportedDshVersion()
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-flight-locale-'))
  const cliRoot = join(temporaryRoot, 'cli')
  const env = {
    ...process.env,
    DSH_TELEMETRY_DISABLED: '1',
    COREPACK_ENABLE_PROJECT_SPEC: '0',
  }
  try {
    await mkdir(cliRoot)
    await writeFile(join(cliRoot, 'package.json'), JSON.stringify({
      name: 'dsh-flight-locale-cli',
      private: true,
      packageManager: 'pnpm@11.7.0',
    }))
    await writeFile(
      join(cliRoot, 'pnpm-workspace.yaml'),
      'onlyBuiltDependencies:\n  - node-pty\n',
    )
    await run(
      'pnpm',
      [
        'add',
        '--lockfile=false',
        `@deepseek-ai/dsh@${version}`,
      ],
      env,
      cliRoot,
    )
    const dshBin = join(cliRoot, 'node_modules', '.bin', 'dsh')
    for (const testCase of cases) {
      await verifyCase(
        testCase,
        dshBin,
        tarballPath,
        env,
        temporaryRoot,
      )
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`DSH 语言验证失败：${message}`)
  process.exitCode = 1
})
