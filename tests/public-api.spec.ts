import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  FlightRecord,
  FlightRecorderInfo,
  FlightRecorderListener,
  FlightRecorderReader,
  FlightRecorderSnapshot,
  RequestAttemptId,
} from '../src/index.js'
import RequestFlightRecorder from '../src/index.js'

describe('public runtime API', () => {
  it('exports only the intentional v1 runtime surface from the root', async () => {
    const api = await import('../src/index.js')

    expect(Object.keys(api).sort()).toEqual([
      'FLIGHT_LIMITS',
      'FLIGHT_RECORDER_PROTOCOL_VERSION',
      'FLIGHT_RECORD_SCHEMA_VERSION',
      'RequestAttemptId',
      'default',
    ])
    expect(api).toMatchObject({
      FLIGHT_LIMITS: expect.objectContaining({
        tools: 128,
        toolSchemaNodes: 4096,
      }),
      FLIGHT_RECORDER_PROTOCOL_VERSION: 1,
      FLIGHT_RECORD_SCHEMA_VERSION: 1,
      RequestAttemptId: expect.any(Function),
      default: expect.any(Function),
    })
  })

  it('exports the stable reader and consumer types from the root', () => {
    expectTypeOf<RequestFlightRecorder>()
      .toMatchTypeOf<FlightRecorderReader>()
    expectTypeOf<FlightRecorderReader['info']>()
      .returns.toEqualTypeOf<FlightRecorderInfo>()
    expectTypeOf<FlightRecorderReader['snapshot']>()
      .returns.toEqualTypeOf<FlightRecorderSnapshot>()
    expectTypeOf<FlightRecorderReader['subscribe']>()
      .parameter(0).toEqualTypeOf<FlightRecorderListener>()
    expectTypeOf<FlightRecorderReader['get']>()
      .parameter(0).toEqualTypeOf<RequestAttemptId>()
    expectTypeOf<FlightRecorderReader['get']>()
      .returns.toEqualTypeOf<FlightRecord | undefined>()
  })
})
