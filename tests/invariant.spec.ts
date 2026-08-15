import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { apply, inject, name } from '../src/invariant.js'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('request flight recorder invariant companion', () => {
  it('reserves package ownership until its registration is disposed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(InvariantRegistry)

    const dispose = await apply(ctx)

    expect(name).toBe('request-flight-recorder-invariant')
    expect(inject).toEqual(['invariants'])
    expect(() => apply(ctx)).toThrow('already registered')

    await dispose()
    const disposeAgain = await apply(ctx)
    expect(disposeAgain).toBeTypeOf('function')
  })
})
