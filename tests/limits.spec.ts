import { describe, expect, it } from 'vitest'
import {
  FLIGHT_LIMITS,
  emptyFlightRecordOmissions,
  hasFlightRecordOmissions,
  mergeFlightRecordOmissions,
} from '../src/limits.js'

describe('flight record limits', () => {
  it('exposes the immutable v1 structural limits', () => {
    expect(FLIGHT_LIMITS).toEqual({
      nameCharacters: 256,
      tools: 128,
      promptSections: 256,
      promptContexts: 256,
      promptVariables: 256,
      messageCounterKeys: 64,
      toolSchemaNodes: 4096,
    })
    expect(Object.isFrozen(FLIGHT_LIMITS)).toBe(true)
  })

  it('creates detached zero omission counters', () => {
    const first = emptyFlightRecordOmissions()
    const second = emptyFlightRecordOmissions()

    expect(first).toEqual({
      requestTools: 0,
      promptTools: 0,
      promptSections: 0,
      promptContexts: 0,
      promptVariables: 0,
      messageRoles: 0,
      messageSources: 0,
      messageBlockTypes: 0,
      oversizedNames: 0,
      truncatedToolSchemas: 0,
    })
    expect(first).not.toBe(second)
    expect(hasFlightRecordOmissions(first)).toBe(false)
  })

  it('merges every counter without mutating inputs', () => {
    const first = {
      ...emptyFlightRecordOmissions(),
      requestTools: 1,
      messageRoles: 2,
    }
    const second = {
      ...emptyFlightRecordOmissions(),
      promptTools: 3,
      oversizedNames: 4,
    }

    const merged = mergeFlightRecordOmissions(first, second)

    expect(merged).toEqual({
      requestTools: 1,
      promptTools: 3,
      promptSections: 0,
      promptContexts: 0,
      promptVariables: 0,
      messageRoles: 2,
      messageSources: 0,
      messageBlockTypes: 0,
      oversizedNames: 4,
      truncatedToolSchemas: 0,
    })
    expect(first.requestTools).toBe(1)
    expect(second.promptTools).toBe(3)
    expect(hasFlightRecordOmissions(merged)).toBe(true)
  })
})
