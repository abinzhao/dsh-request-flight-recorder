import { describe, expect, it, vi } from 'vitest'
import type {
  ClientContext,
  SettingsScope,
  SettingsScopeSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { LocaleSettings } from '@deepseek-ai/dsh-client-locale/client'
import {
  CLIENT_LOCALE_FIELD,
  CLIENT_LOCALE_NAMESPACE,
  normalizeClientLocale,
  synchronizeInitialLocale,
} from '../src/client/locale-sync.js'
import {
  apply as applyClientLocaleSync,
  inject,
} from '../src/client/index.js'

function snapshot(
  overrides: Partial<SettingsScopeSnapshot<LocaleSettings>> = {},
): SettingsScopeSnapshot<LocaleSettings> {
  return {
    status: 'ready',
    value: { preference: 'zh' },
    base: {},
    user: {},
    revision: 1,
    writable: true,
    mode: 'host',
    ...overrides,
  }
}

function scope(
  initial: SettingsScopeSnapshot<LocaleSettings>,
  after?: SettingsScopeSnapshot<LocaleSettings>,
): SettingsScope<LocaleSettings> & { set: ReturnType<typeof vi.fn> } {
  let current = initial
  const set = vi.fn(async () => {
    if (after !== undefined) current = after
    else current = snapshot({
      ...current,
      user: { preference: 'en' },
      value: { preference: 'en' },
    })
  })
  return {
    getSnapshot: () => current,
    subscribe: () => () => {},
    set,
    async unset() {},
  }
}

describe('initial Client locale synchronization', () => {
  it('normalizes only English and keeps stable DSH setting identifiers', () => {
    expect(normalizeClientLocale('en')).toBe('en')
    expect(normalizeClientLocale('zh')).toBe('zh')
    expect(normalizeClientLocale('en-US')).toBe('zh')
    expect(CLIENT_LOCALE_NAMESPACE).toBe('locale')
    expect(CLIENT_LOCALE_FIELD).toBe('preference')
  })

  it('writes the detected locale once when no explicit preference exists', async () => {
    const host = scope(snapshot({ user: {} }))

    await expect(synchronizeInitialLocale(host, 'en')).resolves.toBe('written')
    expect(host.set).toHaveBeenCalledTimes(1)
    expect(host.set).toHaveBeenCalledWith('preference', 'en')
  })

  it('preserves an explicit preference including the composition default', async () => {
    const host = scope(snapshot({
      user: { preference: 'zh' },
      value: { preference: 'zh' },
    }))

    await expect(synchronizeInitialLocale(host, 'en')).resolves.toBe(
      'preserved',
    )
    expect(host.set).not.toHaveBeenCalled()
  })

  it.each([
    snapshot({ status: 'loading' }),
    snapshot({ status: 'unavailable' }),
    snapshot({ mode: 'memory' }),
    snapshot({ writable: false }),
  ])('does not write while Host persistence is unavailable', async (state) => {
    const host = scope(state)

    await expect(synchronizeInitialLocale(host, 'en')).resolves.toBe(
      'unavailable',
    )
    expect(host.set).not.toHaveBeenCalled()
  })

  it('adopts a conflicting Host preference without retrying', async () => {
    const host = scope(
      snapshot({ user: {} }),
      snapshot({
        user: { preference: 'zh' },
        value: { preference: 'zh' },
        revision: 2,
      }),
    )

    await expect(synchronizeInitialLocale(host, 'en')).resolves.toBe(
      'preserved',
    )
    expect(host.set).toHaveBeenCalledTimes(1)
  })

  it('reports unavailable when a write settles without a preference', async () => {
    const host = scope(
      snapshot({ user: {} }),
      snapshot({ user: {}, value: { preference: 'zh' }, revision: 2 }),
    )

    await expect(synchronizeInitialLocale(host, 'en')).resolves.toBe(
      'unavailable',
    )
  })
})

describe('Client locale plugin entry', () => {
  it('binds the locale namespace and synchronizes exactly once', async () => {
    const host = scope(snapshot({ user: {} }))
    let subscribed: (() => void) | undefined
    const unsubscribe = vi.fn()
    host.subscribe = vi.fn((listener) => {
      subscribed = listener
      return unsubscribe
    })
    let cleanup: (() => void) | undefined
    const warn = vi.fn()
    const bind = vi.fn(() => host)
    const ctx = {
      settingsScope: { bind },
      locale: {
        getSnapshot: () => ({ active: 'en' }),
      },
      logger: vi.fn(() => ({ warn })),
      effect: vi.fn((effect: () => () => void) => {
        cleanup = effect()
      }),
    } as unknown as ClientContext

    expect(inject).toEqual([
      'locale',
      'settingsScope',
      'connection',
      'remote',
    ])
    applyClientLocaleSync(ctx)
    await vi.waitFor(() => {
      expect(host.set).toHaveBeenCalledTimes(1)
    })
    subscribed?.()
    await Promise.resolve()

    expect(bind).toHaveBeenCalledWith({ namespace: 'locale' })
    expect(host.set).toHaveBeenCalledWith('preference', 'en')
    expect(host.set).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
    cleanup?.()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('waits for the first non-loading snapshot before synchronizing', async () => {
    let current = snapshot({ status: 'loading', user: {} })
    let subscribed: (() => void) | undefined
    const set = vi.fn(async () => {
      current = snapshot({
        user: { preference: 'zh' },
        value: { preference: 'zh' },
      })
    })
    const host = {
      getSnapshot: () => current,
      subscribe: (listener: () => void) => {
        subscribed = listener
        return () => {}
      },
      set,
      async unset() {},
    } satisfies SettingsScope<LocaleSettings>
    const ctx = {
      settingsScope: { bind: () => host },
      locale: {
        getSnapshot: () => ({ active: 'fr' }),
      },
      logger: () => ({ warn: vi.fn() }),
      effect: (effect: () => () => void) => {
        effect()
      },
    } as unknown as ClientContext

    applyClientLocaleSync(ctx)
    expect(set).not.toHaveBeenCalled()
    current = snapshot({ user: {} })
    subscribed?.()
    await vi.waitFor(() => {
      expect(set).toHaveBeenCalledWith('preference', 'zh')
    })
  })

  it('contains synchronization failures and emits one finite warning', async () => {
    const host = scope(snapshot({ user: {} }))
    host.set.mockRejectedValueOnce(new Error('TOP_SECRET_ERROR'))
    const warn = vi.fn()
    const ctx = {
      settingsScope: { bind: () => host },
      locale: {
        getSnapshot: () => ({ active: 'en' }),
      },
      logger: () => ({ warn }),
      effect: (effect: () => () => void) => {
        effect()
      },
    } as unknown as ClientContext

    applyClientLocaleSync(ctx)
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        'initial locale synchronization failed',
      )
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('TOP_SECRET_ERROR')
  })
})
