import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { LocaleSettings } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  CLIENT_LOCALE_NAMESPACE,
  normalizeClientLocale,
  synchronizeInitialLocale,
} from './locale-sync.js'

export const inject = [
  'locale',
  'settingsScope',
  'connection',
  'remote',
] as const

export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<LocaleSettings>({
    namespace: CLIENT_LOCALE_NAMESPACE,
  })
  let attempted = false
  const logger = ctx.logger('request-flight-recorder')

  const sync = async (): Promise<void> => {
    if (attempted) return
    if (scope.getSnapshot().status === 'loading') return
    attempted = true
    try {
      await synchronizeInitialLocale(
        scope,
        normalizeClientLocale(ctx.locale.getSnapshot().active),
      )
    } catch {
      logger.warn('initial locale synchronization failed')
    }
  }

  ctx.effect(() => {
    const unsubscribe = scope.subscribe(() => {
      void sync()
    })
    void sync()
    return unsubscribe
  })
}
