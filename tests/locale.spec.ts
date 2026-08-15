import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  LOCALE_PREFERENCE_FIELD,
  LOCALE_SETTINGS_NAMESPACE,
} from '@deepseek-ai/dsh-client-locale'
import {
  FLIGHT_MESSAGES,
  normalizeFlightLocale,
  readFlightLocale,
} from '../src/locale.js'

function keyPaths(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`
    return typeof entry === 'object' && entry !== null
      ? keyPaths(entry, path)
      : [path]
  }).sort()
}

describe('flight locale contract', () => {
  it('supports only Chinese and English with Chinese fallback', () => {
    expect(normalizeFlightLocale('zh')).toBe('zh')
    expect(normalizeFlightLocale('en')).toBe('en')
    for (const invalid of [
      undefined,
      null,
      '',
      'en-US',
      'ja',
      1,
      {},
    ]) {
      expect(normalizeFlightLocale(invalid)).toBe('zh')
    }
  })

  it('reads the current DSH Host preference and tolerates missing Settings', () => {
    const missing = new Context()
    expect(readFlightLocale(missing)).toBe('zh')

    const english = new Context()
    english.provide('settings', {
      get() {
        return { [LOCALE_PREFERENCE_FIELD]: 'en' }
      },
    })
    expect(readFlightLocale(english)).toBe('en')

    const invalid = new Context()
    invalid.provide('settings', {
      get() {
        return { [LOCALE_PREFERENCE_FIELD]: 'fr' }
      },
    })
    expect(readFlightLocale(invalid)).toBe('zh')
  })

  it('keeps complete dictionaries and stable technical tokens', () => {
    expect(keyPaths(FLIGHT_MESSAGES.zh)).toEqual(
      keyPaths(FLIGHT_MESSAGES.en),
    )
    expect(LOCALE_SETTINGS_NAMESPACE).toBe('locale')
    expect(LOCALE_PREFERENCE_FIELD).toBe('preference')
    expect(FLIGHT_MESSAGES.zh.commandName).toBe('/flight')
    expect(FLIGHT_MESSAGES.en.commandName).toBe('/flight')
    expect(FLIGHT_MESSAGES.zh.description).toBe(
      '检查不含正文的模型请求诊断',
    )
    expect(FLIGHT_MESSAGES.en.description).toBe(
      'Inspect content-free model request diagnostics',
    )
  })
})
