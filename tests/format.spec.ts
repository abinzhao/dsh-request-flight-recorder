import { describe, expect, it } from 'vitest'
import {
  MAX_COMMAND_OUTPUT,
  boundCommandText,
  formatDiff,
  formatHealth,
  formatRecord,
  formatRecordList,
} from '../src/format.js'
import { diffFlightRecords } from '../src/diff.js'
import { flightRecord } from './fixtures.js'

describe('formatRecord', () => {
  it('renders one running request as concise plain text', () => {
    expect(formatRecord(flightRecord('12345678-abcd'))).toBe([
      'flight 12345678',
      'turn 1 · step 1 · attempt 1',
      'model deepseek/deepseek-chat',
      'request 1 message · 10 system chars · 1 tool',
      'tools read_file(2)',
      'prompt sections identity · contexts workspace · variables cwd',
      'outcome running',
    ].join('\n'))
  })

  it('renders finish timing and usage when present', () => {
    const record = flightRecord('abcdef12-rest', {
      outcome: {
        kind: 'finished',
        finish: { kind: 'stop' },
        firstChunkMs: 5,
        totalMs: 20,
        usage: { inputTokens: 12, outputTokens: 4 },
      },
    })

    expect(formatRecord(record).split('\n').at(-1)).toBe(
      'outcome finished:stop · ttft 5ms · total 20ms · tokens 12 in / 4 out',
    )
  })

  it('renders empty structural collections without a prompt assembly', () => {
    const base = flightRecord('empty')
    const {
      promptAssembly: _discardedPrompt,
      ...withoutPrompt
    } = base
    const record = {
      ...withoutPrompt,
      request: {
        ...base.request,
        messages: {
          total: 0,
          byRole: {},
          bySource: {},
          byBlockType: {},
        },
        tools: [],
      },
    }

    expect(formatRecord(record).split('\n')).toEqual(expect.arrayContaining([
      'request 0 messages · 10 system chars · 0 tools',
      'tools -',
      'prompt sections - · contexts - · variables -',
    ]))
  })

  it('renders thrown and incomplete terminal outcomes', () => {
    const threw = flightRecord('threw', {
      outcome: {
        kind: 'threw',
        error: { kind: 'error' },
        totalMs: 12,
      },
    })
    const incomplete = flightRecord('incomplete', {
      outcome: {
        kind: 'incomplete',
        reason: 'consumer-returned',
        firstChunkMs: 2,
        totalMs: 4,
        usage: { inputTokens: 3, outputTokens: 1 },
      },
    })

    expect(formatRecord(threw).split('\n').at(-1)).toBe(
      'outcome threw:error · total 12ms',
    )
    expect(formatRecord(incomplete).split('\n').at(-1)).toBe(
      'outcome incomplete:consumer-returned · ttft 2ms · total 4ms · tokens 3 in / 1 out',
    )
  })
})

describe('formatRecordList', () => {
  it('renders only compact non-sensitive request coordinates and outcomes', () => {
    const running = flightRecord('abcdef12-current')
    const threw = flightRecord('12345678-previous', {
      sessionId: 'TOP_SECRET_SESSION' as typeof running.sessionId,
      turn: 2,
      step: 3,
      attempt: 4,
      request: {
        ...running.request,
        tools: [{
          name: 'TOP_SECRET_TOOL',
          parameterNodes: 2,
        }],
      },
      promptAssembly: {
        sections: [{ name: 'TOP_SECRET_PROMPT', characters: 10 }],
        contexts: [],
        tools: [],
        variables: ['TOP_SECRET_VARIABLE'],
      },
      outcome: {
        kind: 'threw',
        error: { kind: 'type-error' },
        totalMs: 12,
      },
    })

    const output = formatRecordList([running, threw])

    expect(output).toBe([
      'flight list',
      'abcdef12 · turn 1 · step 1 · attempt 1 · deepseek/deepseek-chat · running',
      '12345678 · turn 2 · step 3 · attempt 4 · deepseek/deepseek-chat · threw',
    ].join('\n'))
    expect(output).not.toContain('TOP_SECRET')
    expect(output).not.toContain('type-error')
  })
})

describe('formatHealth', () => {
  it('renders reasoned aggregate counters without Session identifiers', () => {
    const output = formatHealth({
      captured: 5,
      completed: 3,
      active: 2,
      retained: 4,
      evicted: 1,
      truncatedRecords: 6,
      correlationMisses: 10,
      correlationMissesByReason: {
        'missing-signal': 1,
        'missing-pending': 2,
        'agent-mismatch': 3,
        'session-mismatch': 4,
      },
      projectionFailures: 1,
      subscriberFailures: 7,
    })

    expect(output).toBe([
      'flight health',
      'captured 5 · completed 3 · active 2',
      'retained 4 · evicted 1',
      'truncated records 6 · projection failures 1 · subscriber failures 7',
      'correlation misses 10',
      'missing-signal 1 · missing-pending 2',
      'agent-mismatch 3 · session-mismatch 4',
    ].join('\n'))
    expect(output).not.toContain('session-a')
    expect(output).not.toContain('session-b')
  })
})

describe('formatDiff', () => {
  it('renders an unchanged result', () => {
    const record = flightRecord('12345678-rest')

    expect(formatDiff(diffFlightRecords(record, record))).toBe([
      'flight diff 12345678 → 12345678',
      'no structural changes',
    ].join('\n'))
  })

  it('renders value, counter, and named changes', () => {
    const from = flightRecord('aaaaaaaa-rest')
    const toBase = flightRecord('bbbbbbbb-rest', {
      promptAssembly: {
        sections: [],
        contexts: [],
        tools: ['read_file'],
        variables: ['cwd'],
      },
    })
    const to = {
      ...toBase,
      request: {
        ...toBase.request,
        provider: 'openai',
        systemCharacters: 12,
        tools: [
          ...toBase.request.tools,
          { name: 'write_file', parameterNodes: 1 },
        ],
      },
    }

    expect(formatDiff(diffFlightRecords(from, to))).toBe([
      'flight diff aaaaaaaa → bbbbbbbb',
      'request.provider: deepseek → openai',
      'request.systemCharacters: 10 → 12 (+2)',
      'tools write_file: added (∅ → 1)',
      'prompt.sections identity: removed (10 → ∅)',
      'prompt.contexts workspace: removed (20 → ∅)',
    ].join('\n'))
  })

  it('renders keyed negative deltas and one-sided timing without a delta', () => {
    const from = flightRecord('aaaaaaaa-rest')
    const toBase = flightRecord('bbbbbbbb-rest', {
      outcome: {
        kind: 'finished',
        finish: { kind: 'stop' },
        firstChunkMs: 5,
        totalMs: 10,
      },
    })
    const to = {
      ...toBase,
      request: {
        ...toBase.request,
        messages: {
          ...toBase.request.messages,
          byRole: {},
        },
      },
    }

    const output = formatDiff(diffFlightRecords(from, to))

    expect(output).toContain('messages.byRole[user]: 1 → 0 (-1)')
    expect(output).toContain('timing.firstChunkMs: ∅ → 5')
    expect(output).not.toContain('timing.firstChunkMs: ∅ → 5 (')
  })
})

describe('boundCommandText', () => {
  it('keeps short text unchanged and bounds long text with a stable marker', () => {
    expect(boundCommandText('short')).toBe('short')

    const output = boundCommandText('x'.repeat(5000), MAX_COMMAND_OUTPUT)
    expect(output.length).toBe(MAX_COMMAND_OUTPUT)
    expect(output.endsWith('\n… output truncated')).toBe(true)
  })

  it('never leaves an unmatched UTF-16 surrogate at the truncation boundary', () => {
    const output = boundCommandText(`abc😀${'x'.repeat(30)}`, 23)
    const beforeMarker = output.slice(0, -'\n… output truncated'.length)
    const finalCodeUnit = beforeMarker.charCodeAt(beforeMarker.length - 1)

    expect(finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF).toBe(false)
    expect(output.length).toBeLessThanOrEqual(23)
  })

  it('rejects a bound too small for the truncation marker', () => {
    expect(() => boundCommandText('long text', 1)).toThrow(
      'max must fit the truncation marker',
    )
  })
})
