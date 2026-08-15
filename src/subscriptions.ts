/**
 * Coalesced out-of-stack invalidation for optional live-view consumers.
 * @module dsh-request-flight-recorder/subscriptions
 */

import { deepFreeze } from '@deepseek-ai/dsh-llm'
import type { FlightRecorderListener } from './types.js'

interface ListenerState {
  readonly listener: FlightRecorderListener
  active: boolean
  scheduled: boolean
  running: boolean
  dirty: boolean
  latestRevision: number
}

/** Process-local coalescing coordinator owned by one recorder lifetime. */
export class FlightSubscriptions {
  private readonly listeners = new Set<ListenerState>()

  constructor(
    private readonly onFailure: (error: unknown) => void = () => {},
  ) {}

  subscribe(listener: FlightRecorderListener): () => void {
    const state: ListenerState = {
      listener,
      active: true,
      scheduled: false,
      running: false,
      dirty: false,
      latestRevision: 0,
    }
    this.listeners.add(state)

    return () => {
      if (!state.active) return
      state.active = false
      this.listeners.delete(state)
    }
  }

  publish(revision: number): void {
    for (const state of this.listeners) {
      state.latestRevision = revision
      if (state.running) {
        state.dirty = true
        continue
      }
      if (state.scheduled) continue
      this.schedule(state)
    }
  }

  clear(): void {
    for (const state of this.listeners) state.active = false
    this.listeners.clear()
  }

  private schedule(state: ListenerState): void {
    state.scheduled = true
    setImmediate(() => {
      void this.deliver(state)
    })
  }

  private async deliver(state: ListenerState): Promise<void> {
    state.scheduled = false
    if (!state.active) return
    state.running = true
    state.dirty = false
    try {
      await state.listener(deepFreeze({ revision: state.latestRevision }))
    } catch (error) {
      try {
        this.onFailure(error)
      } catch {
        // Consumer diagnostics cannot affect recorder delivery.
      }
    } finally {
      state.running = false
      if (state.active && state.dirty) this.schedule(state)
    }
  }
}
