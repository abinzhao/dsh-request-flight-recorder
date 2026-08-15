import { describe, expect, it } from 'vitest'
import { FlightSubscriptions } from '../src/subscriptions.js'

function deferred(): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flushDeliveries(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('FlightSubscriptions', () => {
  it('never overlaps one async listener and coalesces pending changes', async () => {
    const subscriptions = new FlightSubscriptions()
    const gate = deferred()
    const revisions: number[] = []
    subscriptions.subscribe(async (change) => {
      revisions.push(change.revision)
      if (change.revision === 1) await gate.promise
    })

    subscriptions.publish(1)
    await flushDeliveries()
    expect(revisions).toEqual([1])

    subscriptions.publish(2)
    subscriptions.publish(3)
    await flushDeliveries()
    expect(revisions).toEqual([1])

    gate.resolve()
    await flushDeliveries()
    expect(revisions).toEqual([1, 3])
  })

  it('contains listener throws and rejections without blocking peers', async () => {
    const failures: unknown[] = []
    const Coordinator = FlightSubscriptions as unknown as new (
      onFailure: (error: unknown) => void,
    ) => FlightSubscriptions
    const subscriptions = new Coordinator(error => failures.push(error))
    const thrown = new Error('sync failure')
    const rejected = new Error('async failure')
    const healthy: number[] = []

    subscriptions.subscribe(() => {
      throw thrown
    })
    subscriptions.subscribe(() => Promise.reject(rejected))
    subscriptions.subscribe(change => {
      healthy.push(change.revision)
    })
    subscriptions.publish(1)
    await flushDeliveries()

    expect(failures).toEqual([thrown, rejected])
    expect(healthy).toEqual([1])
  })

  it('cancels queued and dirty delivery after unsubscribe or clear', async () => {
    const subscriptions = new FlightSubscriptions()
    const queued: number[] = []
    const unsubscribe = subscriptions.subscribe(change => {
      queued.push(change.revision)
    })
    subscriptions.publish(1)
    unsubscribe()
    unsubscribe()
    await flushDeliveries()
    expect(queued).toEqual([])

    const gate = deferred()
    const running: number[] = []
    subscriptions.subscribe(async (change) => {
      running.push(change.revision)
      await gate.promise
    })
    subscriptions.publish(2)
    await flushDeliveries()
    subscriptions.publish(3)
    subscriptions.clear()
    gate.resolve()
    await flushDeliveries()
    expect(running).toEqual([2])
  })

  it('contains failures thrown by the failure observer', async () => {
    const subscriptions = new FlightSubscriptions(() => {
      throw new Error('failure observer failed')
    })
    const healthy: number[] = []
    subscriptions.subscribe(() => {
      throw new Error('listener failed')
    })
    subscriptions.subscribe(change => {
      healthy.push(change.revision)
    })

    subscriptions.publish(1)
    await flushDeliveries()

    expect(healthy).toEqual([1])

    const defaults = new FlightSubscriptions()
    defaults.subscribe(() => {
      throw new Error('default observer path')
    })
    defaults.publish(2)
    await flushDeliveries()
  })
})
