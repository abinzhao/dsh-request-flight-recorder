import type { LocaleSettings } from '@deepseek-ai/dsh-client-locale/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'

export const CLIENT_LOCALE_NAMESPACE = 'locale'
export const CLIENT_LOCALE_FIELD = 'preference'
export type ClientFlightLocale = 'zh' | 'en'
export type InitialLocaleSyncResult =
  | 'written'
  | 'preserved'
  | 'unavailable'

function readPreference(value: unknown): unknown {
  if (
    typeof value !== 'object'
    || value === null
    || !Object.hasOwn(value, CLIENT_LOCALE_FIELD)
  ) {
    return undefined
  }
  return (value as Record<string, unknown>)[CLIENT_LOCALE_FIELD]
}

export function normalizeClientLocale(value: unknown): ClientFlightLocale {
  return value === 'en' ? 'en' : 'zh'
}

export async function synchronizeInitialLocale(
  scope: SettingsScope<LocaleSettings>,
  active: ClientFlightLocale,
): Promise<InitialLocaleSyncResult> {
  const before = scope.getSnapshot()
  if (
    before.status !== 'ready'
    || before.mode !== 'host'
    || !before.writable
  ) {
    return 'unavailable'
  }
  if (readPreference(before.user) !== undefined) return 'preserved'

  await scope.set(CLIENT_LOCALE_FIELD, active)
  const accepted = readPreference(scope.getSnapshot().user)
  if (accepted === active) return 'written'
  if (accepted !== undefined) return 'preserved'
  return 'unavailable'
}
