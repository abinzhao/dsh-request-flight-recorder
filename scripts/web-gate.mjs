const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_MS = 100

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

export async function navigateWhenReady(
  page,
  url,
  child,
  output,
  options = {},
) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS
  const deadline = Date.now() + timeoutMs

  while (true) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      return
    } catch (error) {
      if (!String(error).includes('ERR_CONNECTION_REFUSED')) throw error
      if (child.exitCode !== null) {
        throw new Error(
          `DSH Web 在浏览器导航前退出（${child.exitCode}）：${output()}`,
        )
      }
      if (Date.now() >= deadline) {
        throw new Error(`DSH Web 浏览器导航超时：${output()}`)
      }
      await delay(retryMs)
    }
  }
}
