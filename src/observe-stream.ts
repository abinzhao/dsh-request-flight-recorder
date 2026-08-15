/**
 * Transparent observation of one model-response async iterable.
 * @module dsh-request-flight-recorder/observe-stream
 */

import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { performance } from 'node:perf_hooks'
import type { FlightStreamObservation } from './types.js'

function optionalState(
  firstChunkMs: number | undefined,
  usage: TokenUsage | undefined,
): {
  firstChunkMs?: number
  usage?: TokenUsage
} {
  return {
    ...(firstChunkMs === undefined ? {} : { firstChunkMs }),
    ...(usage === undefined ? {} : { usage }),
  }
}

/**
 * Observe a model stream without buffering or replacing its chunks.
 * @param stream - downstream model stream.
 * @param observe - no-control callback receiving structural observations.
 * @param now - monotonic millisecond clock.
 * @returns an async iterable that preserves downstream values and failures.
 */
export function observeStream(
  stream: AsyncIterable<StreamChunk>,
  observe: (event: FlightStreamObservation) => void,
  now: () => number = performance.now.bind(performance),
): AsyncIterable<StreamChunk> {
  const startedAt = now()

  function notify(event: FlightStreamObservation): void {
    try {
      observe(event)
    } catch {
      // Recorder callbacks are observational; their failures cannot alter the model stream.
    }
  }

  return {
    [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
      const downstream = stream[Symbol.asyncIterator]()
      let firstChunkMs: number | undefined
      let usage: TokenUsage | undefined
      let settled = false

      return {
        async next(): Promise<IteratorResult<StreamChunk>> {
          let result: IteratorResult<StreamChunk>
          try {
            result = await downstream.next()
          } catch (error) {
            if (!settled) {
              settled = true
              notify({
                kind: 'threw',
                error,
                totalMs: now() - startedAt,
                ...optionalState(firstChunkMs, usage),
              })
            }
            throw error
          }

          if (result.done) {
            if (!settled) {
              settled = true
              notify({
                kind: 'incomplete',
                reason: 'stream-ended-without-finish',
                totalMs: now() - startedAt,
                ...optionalState(firstChunkMs, usage),
              })
            }
            return result
          }

          if (firstChunkMs === undefined) {
            firstChunkMs = now() - startedAt
            notify({ kind: 'first-chunk', elapsedMs: firstChunkMs })
          }

          if (result.value.type === 'usage') {
            usage = result.value.usage
            notify({ kind: 'usage', usage })
          } else if (result.value.type === 'finish' && !settled) {
            settled = true
            notify({
              kind: 'finished',
              finish: result.value.reason,
              totalMs: now() - startedAt,
              ...optionalState(firstChunkMs, usage),
            })
          }
          return result
        },

        async return(): Promise<IteratorResult<StreamChunk>> {
          if (!settled) {
            settled = true
            notify({
              kind: 'incomplete',
              reason: 'consumer-returned',
              totalMs: now() - startedAt,
              ...optionalState(firstChunkMs, usage),
            })
          }
          return downstream.return === undefined
            ? { done: true, value: undefined }
            : downstream.return()
        },

        async throw(error?: unknown): Promise<IteratorResult<StreamChunk>> {
          if (!settled) {
            settled = true
            notify({
              kind: 'incomplete',
              reason: 'consumer-threw',
              totalMs: now() - startedAt,
              ...optionalState(firstChunkMs, usage),
            })
          }
          if (downstream.throw === undefined) throw error
          return downstream.throw(error)
        },
      }
    },
  }
}
