import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { observeStream } from '../src/observe-stream.js'
import type { FlightStreamObservation } from '../src/types.js'

function source(
  chunks: readonly StreamChunk[],
  onReturn?: () => void,
): AsyncIterable<StreamChunk> {
  let index = 0
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const chunk = chunks[index]
          index += 1
          return chunk === undefined
            ? { done: true as const, value: undefined }
            : { done: false as const, value: chunk }
        },
        async return() {
          onReturn?.()
          return { done: true as const, value: undefined }
        },
      }
    },
  }
}

describe('observeStream', () => {
  it('yields identical chunks and records usage, finish, and timing', async () => {
    const text: StreamChunk = { type: 'text-delta', index: 0, text: 'hello' }
    const usage: StreamChunk = {
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 2 },
    }
    const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
    const observations: FlightStreamObservation[] = []
    let time = 100
    const iterator = observeStream(
      source([text, usage, finish]),
      observation => observations.push(observation),
      () => time,
    )[Symbol.asyncIterator]()

    time = 110
    expect((await iterator.next()).value).toBe(text)
    time = 120
    expect((await iterator.next()).value).toBe(usage)
    time = 140
    expect((await iterator.next()).value).toBe(finish)
    time = 150
    expect((await iterator.next()).done).toBe(true)

    expect(observations).toEqual([
      { kind: 'first-chunk', elapsedMs: 10 },
      { kind: 'usage', usage: usage.usage },
      {
        kind: 'finished',
        finish: finish.reason,
        firstChunkMs: 10,
        totalMs: 40,
        usage: usage.usage,
      },
    ])
  })

  it('rethrows the identical downstream error and records it', async () => {
    const error = new Error('downstream failed')
    const observations: FlightStreamObservation[] = []
    let time = 10
    const stream: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<StreamChunk>> {
            throw error
          },
        }
      },
    }
    const iterator = observeStream(
      stream,
      observation => observations.push(observation),
      () => time,
    )[Symbol.asyncIterator]()

    time = 25
    await expect(iterator.next()).rejects.toBe(error)
    expect(observations).toEqual([{
      kind: 'threw',
      error,
      totalMs: 15,
    }])
  })

  it('forwards consumer return and records an incomplete observation', async () => {
    const text: StreamChunk = { type: 'text-delta', index: 0, text: 'hello' }
    const observations: FlightStreamObservation[] = []
    let returned = false
    let time = 0
    const iterator = observeStream(
      source([text], () => {
        returned = true
      }),
      observation => observations.push(observation),
      () => time,
    )[Symbol.asyncIterator]()

    time = 5
    await iterator.next()
    time = 8
    await iterator.return?.()

    expect(returned).toBe(true)
    expect(observations.at(-1)).toEqual({
      kind: 'incomplete',
      reason: 'consumer-returned',
      firstChunkMs: 5,
      totalMs: 8,
    })
  })

  it('records normal completion without finish as incomplete', async () => {
    const observations: FlightStreamObservation[] = []
    let time = 2
    const iterator = observeStream(
      source([]),
      observation => observations.push(observation),
      () => time,
    )[Symbol.asyncIterator]()

    time = 7
    expect((await iterator.next()).done).toBe(true)
    expect(observations).toEqual([{
      kind: 'incomplete',
      reason: 'stream-ended-without-finish',
      totalMs: 5,
    }])
  })

  it('contains observer failures without changing downstream chunks', async () => {
    const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
    const iterator = observeStream(
      source([finish]),
      () => {
        throw new Error('observer failed')
      },
      () => 0,
    )[Symbol.asyncIterator]()

    expect((await iterator.next()).value).toBe(finish)
    expect((await iterator.next()).done).toBe(true)
  })

  it('forwards consumer throw to the downstream iterator', async () => {
    const consumerError = new Error('consumer failed')
    const observations: FlightStreamObservation[] = []
    let received: unknown
    const stream: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false as const, value: { type: 'text-delta', index: 0, text: 'hello' } as const }
          },
          async throw(error?: unknown) {
            received = error
            return { done: true as const, value: undefined }
          },
        }
      },
    }
    const iterator = observeStream(
      stream,
      observation => observations.push(observation),
      () => 0,
    )[Symbol.asyncIterator]()

    await iterator.next()
    await iterator.throw?.(consumerError)

    expect(received).toBe(consumerError)
    expect(observations.at(-1)).toEqual({
      kind: 'incomplete',
      reason: 'consumer-threw',
      firstChunkMs: 0,
      totalMs: 0,
    })
  })

  it('does not replace a finished outcome when downstream later throws', async () => {
    const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
    const downstreamError = new Error('invalid chunk after finish')
    let call = 0
    const observations: FlightStreamObservation[] = []
    const stream: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<StreamChunk>> {
            call += 1
            if (call === 1) return { done: false, value: finish }
            throw downstreamError
          },
        }
      },
    }
    const iterator = observeStream(
      stream,
      observation => observations.push(observation),
      () => 0,
    )[Symbol.asyncIterator]()

    expect((await iterator.next()).value).toBe(finish)
    await expect(iterator.next()).rejects.toBe(downstreamError)
    expect(observations.filter(item => item.kind === 'finished')).toHaveLength(1)
    expect(observations.some(item => item.kind === 'threw')).toBe(false)
  })

  it('forwards duplicate finish chunks without replacing the first finish', async () => {
    const first: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
    const second: StreamChunk = { type: 'finish', reason: { kind: 'max-tokens' } }
    const observations: FlightStreamObservation[] = []
    const iterator = observeStream(
      source([first, second]),
      observation => observations.push(observation),
      () => 0,
    )[Symbol.asyncIterator]()

    expect((await iterator.next()).value).toBe(first)
    expect((await iterator.next()).value).toBe(second)
    expect(observations.filter(item => item.kind === 'finished')).toEqual([
      expect.objectContaining({ finish: first.reason }),
    ])
  })

  it('supports settled return when downstream has no return method', async () => {
    const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
    const stream: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false as const, value: finish }
          },
        }
      },
    }
    const observations: FlightStreamObservation[] = []
    const iterator = observeStream(
      stream,
      observation => observations.push(observation),
      () => 0,
    )[Symbol.asyncIterator]()

    await iterator.next()
    expect(await iterator.return?.()).toEqual({ done: true, value: undefined })
    await expect(iterator.throw?.(new Error('after finish'))).rejects.toThrow('after finish')
    expect(observations.some(item => item.kind === 'incomplete')).toBe(false)
  })

  it('rethrows consumer errors when downstream has no throw method', async () => {
    const consumerError = new Error('consumer failed')
    const observations: FlightStreamObservation[] = []
    const iterator = observeStream(
      source([]),
      observation => observations.push(observation),
      () => 0,
    )[Symbol.asyncIterator]()

    await expect(iterator.throw?.(consumerError)).rejects.toBe(consumerError)
    expect(observations.at(-1)).toEqual({
      kind: 'incomplete',
      reason: 'consumer-threw',
      totalMs: 0,
    })
  })
})
