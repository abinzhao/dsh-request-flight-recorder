import { describe, expect, it, vi } from 'vitest'
import { navigateWhenReady } from '../scripts/web-gate.mjs'

describe('browser Web readiness gate', () => {
  it('retries a transient connection refusal after the HTTP probe', async () => {
    const page = {
      goto: vi.fn()
        .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'))
        .mockResolvedValueOnce(undefined),
    }
    const child = { exitCode: null }

    await expect(navigateWhenReady(
      page,
      'http://127.0.0.1:1234/',
      child,
      () => '',
      { timeoutMs: 100, retryMs: 0 },
    )).resolves.toBeUndefined()
    expect(page.goto).toHaveBeenCalledTimes(2)
  })

  it('fails immediately when DSH exits between readiness and navigation', async () => {
    const page = {
      goto: vi.fn().mockRejectedValue(
        new Error('net::ERR_CONNECTION_REFUSED'),
      ),
    }
    const child = { exitCode: 1 }

    await expect(navigateWhenReady(
      page,
      'http://127.0.0.1:1234/',
      child,
      () => 'finite output',
      { timeoutMs: 100, retryMs: 0 },
    )).rejects.toThrow('DSH Web 在浏览器导航前退出（1）：finite output')
    expect(page.goto).toHaveBeenCalledTimes(1)
  })

  it('does not retry non-transient browser failures', async () => {
    const failure = new Error('certificate rejected')
    const page = {
      goto: vi.fn().mockRejectedValue(failure),
    }

    await expect(navigateWhenReady(
      page,
      'http://127.0.0.1:1234/',
      { exitCode: null },
      () => '',
      { timeoutMs: 100, retryMs: 0 },
    )).rejects.toBe(failure)
    expect(page.goto).toHaveBeenCalledTimes(1)
  })
})
