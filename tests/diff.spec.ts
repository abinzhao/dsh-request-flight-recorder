import { describe, expect, it } from 'vitest'
import type { GenerateOptions, MessageId } from '@deepseek-ai/dsh-llm'
import { diffFlightRecords } from '../src/diff.js'
import { projectRequest } from '../src/project.js'
import type { FlightOutcome } from '../src/types.js'
import { flightRecord } from './fixtures.js'

describe('diffFlightRecords', () => {
  it('returns a deeply frozen empty diff for equal records', () => {
    const record = flightRecord('a')

    const diff = diffFlightRecords(record, record)

    expect(diff).toEqual({
      fromId: 'a',
      toId: 'a',
      changed: false,
      changes: [],
    })
    expect(Object.isFrozen(diff)).toBe(true)
    expect(Object.isFrozen(diff.changes)).toBe(true)
  })

  it('reports scalar and unkeyed numeric changes in stable field order', () => {
    const from = flightRecord('from')
    const toBase = flightRecord('to', {
      outcome: {
        kind: 'finished',
        finish: { kind: 'stop' },
        firstChunkMs: 5,
        totalMs: 20,
        usage: { inputTokens: 12, outputTokens: 4 },
      },
    })
    const to = {
      ...toBase,
      request: {
        ...toBase.request,
        provider: 'openai',
        model: 'gpt-5',
        reasoningEffort: 'high',
        temperature: 0.25,
        maxTokens: 4096,
        systemCharacters: 12,
        messages: {
          ...toBase.request.messages,
          total: 2,
        },
      },
    }

    expect(diffFlightRecords(from, to).changes).toEqual([
      { kind: 'value', field: 'request.provider', before: 'deepseek', after: 'openai' },
      { kind: 'value', field: 'request.model', before: 'deepseek-chat', after: 'gpt-5' },
      { kind: 'value', field: 'request.reasoningEffort', before: null, after: 'high' },
      { kind: 'value', field: 'request.temperature', before: null, after: 0.25 },
      { kind: 'value', field: 'request.maxTokens', before: null, after: 4096 },
      { kind: 'value', field: 'outcome.kind', before: 'running', after: 'finished' },
      { kind: 'value', field: 'outcome.finish', before: null, after: 'stop' },
      {
        kind: 'counter',
        field: 'request.systemCharacters',
        key: null,
        before: 10,
        after: 12,
        delta: 2,
      },
      {
        kind: 'counter',
        field: 'messages.total',
        key: null,
        before: 1,
        after: 2,
        delta: 1,
      },
      {
        kind: 'counter',
        field: 'timing.firstChunkMs',
        key: null,
        before: null,
        after: 5,
        delta: null,
      },
      {
        kind: 'counter',
        field: 'timing.totalMs',
        key: null,
        before: null,
        after: 20,
        delta: null,
      },
      {
        kind: 'counter',
        field: 'usage.inputTokens',
        key: null,
        before: null,
        after: 12,
        delta: null,
      },
      {
        kind: 'counter',
        field: 'usage.outputTokens',
        key: null,
        before: null,
        after: 4,
        delta: null,
      },
    ])
  })

  it('reports keyed message counters with absent entries treated as zero', () => {
    const from = flightRecord('from')
    const toBase = flightRecord('to')
    const to = {
      ...toBase,
      request: {
        ...toBase.request,
        messages: {
          total: 2,
          byRole: { assistant: 1, user: 1 },
          bySource: { model: 1, user: 1 },
          byBlockType: { reasoning: 1, text: 1 },
        },
      },
    }

    expect(diffFlightRecords(from, to).changes).toEqual([
      {
        kind: 'counter',
        field: 'messages.total',
        key: null,
        before: 1,
        after: 2,
        delta: 1,
      },
      {
        kind: 'counter',
        field: 'messages.byRole',
        key: 'assistant',
        before: 0,
        after: 1,
        delta: 1,
      },
      {
        kind: 'counter',
        field: 'messages.bySource',
        key: 'model',
        before: 0,
        after: 1,
        delta: 1,
      },
      {
        kind: 'counter',
        field: 'messages.byBlockType',
        key: 'reasoning',
        before: 0,
        after: 1,
        delta: 1,
      },
    ])
  })

  it('reports named additions, removals, and size changes deterministically', () => {
    const from = flightRecord('from')
    const toBase = flightRecord('to')
    const to = {
      ...toBase,
      request: {
        ...toBase.request,
        tools: [
          { name: 'write_file', parameterNodes: 1 },
          { name: 'read_file', parameterNodes: 3 },
        ],
      },
      promptAssembly: {
        sections: [
          { name: 'persona', characters: 5 },
          { name: 'identity', characters: 12 },
        ],
        contexts: [],
        tools: ['read_file', 'write_file'],
        variables: ['root'],
      },
    }

    expect(diffFlightRecords(from, to).changes).toEqual([
      {
        kind: 'named',
        field: 'tools',
        name: 'read_file',
        change: 'changed',
        beforeSize: 2,
        afterSize: 3,
      },
      {
        kind: 'named',
        field: 'tools',
        name: 'write_file',
        change: 'added',
        beforeSize: null,
        afterSize: 1,
      },
      {
        kind: 'named',
        field: 'prompt.sections',
        name: 'identity',
        change: 'changed',
        beforeSize: 10,
        afterSize: 12,
      },
      {
        kind: 'named',
        field: 'prompt.sections',
        name: 'persona',
        change: 'added',
        beforeSize: null,
        afterSize: 5,
      },
      {
        kind: 'named',
        field: 'prompt.contexts',
        name: 'workspace',
        change: 'removed',
        beforeSize: 20,
        afterSize: null,
      },
      {
        kind: 'named',
        field: 'prompt.variables',
        name: 'cwd',
        change: 'removed',
        beforeSize: null,
        afterSize: null,
      },
      {
        kind: 'named',
        field: 'prompt.variables',
        name: 'root',
        change: 'added',
        beforeSize: null,
        afterSize: null,
      },
    ])
  })

  it('handles removed counters, absent prompt assembly, and undefined usage', () => {
    const from = flightRecord('from')
    const toBase = flightRecord('to')
    const {
      promptAssembly: _discardedPrompt,
      ...toWithoutPrompt
    } = toBase
    const to = {
      ...toWithoutPrompt,
      request: {
        ...toBase.request,
        messages: {
          total: 1,
          byRole: {},
          bySource: {},
          byBlockType: {},
        },
      },
      outcome: {
        kind: 'finished',
        finish: { kind: 'stop' },
        totalMs: 10,
        usage: undefined,
      } as unknown as FlightOutcome,
    }

    expect(diffFlightRecords(from, to).changes).toEqual(expect.arrayContaining([
      {
        kind: 'counter',
        field: 'messages.byRole',
        key: 'user',
        before: 1,
        after: 0,
        delta: -1,
      },
      {
        kind: 'counter',
        field: 'messages.bySource',
        key: 'user',
        before: 1,
        after: 0,
        delta: -1,
      },
      {
        kind: 'counter',
        field: 'messages.byBlockType',
        key: 'text',
        before: 1,
        after: 0,
        delta: -1,
      },
      {
        kind: 'named',
        field: 'prompt.sections',
        name: 'identity',
        change: 'removed',
        beforeSize: 10,
        afterSize: null,
      },
      {
        kind: 'named',
        field: 'prompt.contexts',
        name: 'workspace',
        change: 'removed',
        beforeSize: 20,
        afterSize: null,
      },
      {
        kind: 'named',
        field: 'prompt.variables',
        name: 'cwd',
        change: 'removed',
        beforeSize: null,
        afterSize: null,
      },
    ]))
  })

  it('never introduces model-visible content into a diff', () => {
    const secret = 'TOP_SECRET_VALUE'
    const request: GenerateOptions = {
      provider: 'deepseek',
      model: 'deepseek-chat',
      system: `system-${secret}`,
      messages: [{
        id: 'message' as MessageId,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: `message-${secret}` }],
      }],
      tools: [{
        name: 'read_file',
        description: `description-${secret}`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: `parameter-${secret}` },
          },
        },
      }],
    }
    const from = flightRecord('from', {
      request: projectRequest(request).summary,
    })
    const to = flightRecord('to', {
      request: projectRequest({ ...request, system: 'changed' }).summary,
    })

    expect(JSON.stringify(diffFlightRecords(from, to))).not.toContain(secret)
  })
})
