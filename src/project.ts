/**
 * Content-free structural projections of model requests and prompt assemblies.
 * @module dsh-request-flight-recorder/project
 */

import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import {
  FLIGHT_LIMITS,
  emptyFlightRecordOmissions,
  type ProjectionResult,
} from './limits.js'
import type {
  FlightRecordOmissions,
  MessageSummary,
  PromptAssemblySummary,
  PromptContributionSummary,
  RequestSummary,
} from './types.js'

type OmissionField =
  | 'messageRoles'
  | 'messageSources'
  | 'messageBlockTypes'

type MutableOmissions = {
  -readonly [Key in keyof FlightRecordOmissions]: FlightRecordOmissions[Key]
}

function increment(
  counts: Record<string, number>,
  key: string,
  omissionField: OmissionField,
  omissions: MutableOmissions,
): void {
  if (key.length > FLIGHT_LIMITS.nameCharacters) {
    omissions[omissionField] += 1
    omissions.oversizedNames += 1
    return
  }
  if (counts[key] !== undefined) {
    counts[key] += 1
    return
  }
  if (Object.keys(counts).length === FLIGHT_LIMITS.messageCounterKeys) {
    omissions[omissionField] += 1
    return
  }
  counts[key] = 1
}

function sourceKey(source: Message['source']): string {
  if (source.kind !== 'plugin') return source.kind
  return `plugin:${source.form ?? 'opaque'}`
}

function projectMessages(
  messages: readonly Message[],
  omissions: MutableOmissions,
): MessageSummary {
  const byRole: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  const byBlockType: Record<string, number> = {}

  for (const message of messages) {
    increment(byRole, message.role, 'messageRoles', omissions)
    increment(
      bySource,
      sourceKey(message.source),
      'messageSources',
      omissions,
    )
    for (const block of message.content) {
      increment(
        byBlockType,
        block.type,
        'messageBlockTypes',
        omissions,
      )
    }
  }

  return {
    total: messages.length,
    byRole,
    bySource,
    byBlockType,
  }
}

function countJsonNodes(value: unknown): {
  readonly nodes: number
  readonly truncated: boolean
} {
  const stack: unknown[] = [value]
  const seen = new WeakSet<object>()
  let nodes = 0
  let truncated = false

  while (stack.length > 0) {
    if (nodes === FLIGHT_LIMITS.toolSchemaNodes) {
      return { nodes, truncated: true }
    }

    const current = stack.pop()
    if (current !== null && typeof current === 'object') {
      if (seen.has(current)) {
        truncated = true
        continue
      }
      seen.add(current)
      const values = Array.isArray(current)
        ? current
        : Object.values(current)
      for (let index = values.length - 1; index >= 0; index -= 1) {
        stack.push(values[index])
      }
    }
    nodes += 1
  }

  return { nodes, truncated }
}

function projectNamed<T, Result>(
  items: readonly T[],
  limit: number,
  nameOf: (item: T) => string,
  project: (item: T) => Result,
  omissionField:
    | 'requestTools'
    | 'promptTools'
    | 'promptSections'
    | 'promptContexts'
    | 'promptVariables',
  omissions: MutableOmissions,
): Result[] {
  const result: Result[] = []
  for (const item of items) {
    const name = nameOf(item)
    if (name.length > FLIGHT_LIMITS.nameCharacters) {
      omissions[omissionField] += 1
      omissions.oversizedNames += 1
      continue
    }
    if (result.length === limit) {
      omissions[omissionField] += 1
      continue
    }
    result.push(project(item))
  }
  return result
}

/**
 * Project one exact model request into a content-free structural summary.
 * @param options - final request observed at `llm/stream`.
 * @returns structural request facts with no message, prompt, or schema text.
 */
export function projectRequest(
  options: GenerateOptions,
): ProjectionResult<RequestSummary> {
  const omissions: MutableOmissions = {
    ...emptyFlightRecordOmissions(),
  }
  const projectedTools = projectNamed(
    options.tools ?? [],
    FLIGHT_LIMITS.tools,
    tool => tool.name,
    (tool) => {
    const parameters = countJsonNodes(tool.parameters)
    return {
      name: tool.name,
      parameterNodes: parameters.nodes,
      truncated: parameters.truncated,
    }
    },
    'requestTools',
    omissions,
  )
  omissions.truncatedToolSchemas = projectedTools
    .filter(tool => tool.truncated)
    .length

  return {
    summary: {
      provider: options.provider,
      model: options.model,
      ...(options.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: String(options.reasoningEffort) }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.stop === undefined ? {} : { stopCount: options.stop.length }),
      messages: projectMessages(options.messages, omissions),
      systemCharacters: options.system?.length ?? 0,
      tools: projectedTools.map(({ name, parameterNodes }) => ({
        name,
        parameterNodes,
      })),
    },
    omissions,
  }
}

/**
 * Project one authoritative prompt assembly without retaining contributed text.
 * @param assembly - result returned by the prompt-assembly waterfall.
 * @returns ordered contribution identities and sizes.
 */
export function projectPromptAssembly(
  assembly: PromptAssembly,
): ProjectionResult<PromptAssemblySummary> {
  const omissions: MutableOmissions = {
    ...emptyFlightRecordOmissions(),
  }
  return {
    summary: {
      sections: projectNamed(
        assembly.sections,
        FLIGHT_LIMITS.promptSections,
        section => section.name,
        section => ({
          name: section.name,
          characters: section.text.length,
        } satisfies PromptContributionSummary),
        'promptSections',
        omissions,
      ),
      contexts: projectNamed(
        assembly.contexts,
        FLIGHT_LIMITS.promptContexts,
        context => context.name,
        context => ({
          name: context.name,
          characters: context.text.length,
        } satisfies PromptContributionSummary),
        'promptContexts',
        omissions,
      ),
      tools: projectNamed(
        assembly.tools,
        FLIGHT_LIMITS.tools,
        tool => tool.name,
        tool => tool.name,
        'promptTools',
        omissions,
      ),
      variables: projectNamed(
        Object.keys(assembly.variables),
        FLIGHT_LIMITS.promptVariables,
        name => name,
        name => name,
        'promptVariables',
        omissions,
      ),
    },
    omissions,
  }
}
