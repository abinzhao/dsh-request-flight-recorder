import { performance } from 'node:perf_hooks'
import { bench, describe } from 'vitest'
import type { GenerateOptions, ToolSchema } from '@deepseek-ai/dsh-llm'
import { FLIGHT_LIMITS } from '../src/limits.js'
import { projectRequest } from '../src/project.js'

function tools(count: number): ToolSchema[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `tool_${index}`,
    description: 'benchmark fixture',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
    },
  }))
}

function request(toolCount: number): GenerateOptions {
  return {
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [],
    system: 'benchmark fixture',
    tools: tools(toolCount),
  }
}

const small = request(0)
const standard = request(16)
const limitSized = request(FLIGHT_LIMITS.tools)

function reportPercentiles(
  name: string,
  options: GenerateOptions,
  iterations: number,
): void {
  for (let index = 0; index < 100; index += 1) projectRequest(options)
  const samples = Array.from({ length: iterations }, () => {
    const startedAt = performance.now()
    projectRequest(options)
    return performance.now() - startedAt
  }).sort((left, right) => left - right)
  const median = samples[Math.floor((samples.length - 1) * 0.5)]!
  const p95 = samples[Math.floor((samples.length - 1) * 0.95)]!
  console.log(
    `percentiles ${name}: median ${median.toFixed(6)}ms · p95 ${p95.toFixed(6)}ms · samples ${iterations}`,
  )
}

reportPercentiles('small fixture', small, 20_000)
reportPercentiles('standard fixture', standard, 5_000)
reportPercentiles('limit-sized fixture', limitSized, 1_000)

describe('bounded request projection', () => {
  bench('small fixture', () => {
    projectRequest(small)
  })

  bench('standard fixture', () => {
    projectRequest(standard)
  })

  bench('limit-sized fixture', () => {
    projectRequest(limitSized)
  })
})
