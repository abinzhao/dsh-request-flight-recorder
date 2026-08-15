/**
 * Hard resource limits for content-free structural projections.
 * @module dsh-request-flight-recorder/limits
 */

import type { FlightRecordOmissions } from './types.js'

/** Non-configurable safety limits forming the v1 record contract. */
export const FLIGHT_LIMITS = Object.freeze({
  nameCharacters: 256,
  tools: 128,
  promptSections: 256,
  promptContexts: 256,
  promptVariables: 256,
  messageCounterKeys: 64,
  toolSchemaNodes: 4096,
} as const)

/** Create detached zero-valued omission accounting. */
export function emptyFlightRecordOmissions(): FlightRecordOmissions {
  return {
    requestTools: 0,
    promptTools: 0,
    promptSections: 0,
    promptContexts: 0,
    promptVariables: 0,
    messageRoles: 0,
    messageSources: 0,
    messageBlockTypes: 0,
    oversizedNames: 0,
    truncatedToolSchemas: 0,
  }
}

/** Merge omission counters without mutating any projection result. */
export function mergeFlightRecordOmissions(
  ...values: readonly FlightRecordOmissions[]
): FlightRecordOmissions {
  const result = emptyFlightRecordOmissions()
  return {
    requestTools: values.reduce((sum, value) => sum + value.requestTools, result.requestTools),
    promptTools: values.reduce((sum, value) => sum + value.promptTools, result.promptTools),
    promptSections: values.reduce((sum, value) => sum + value.promptSections, result.promptSections),
    promptContexts: values.reduce((sum, value) => sum + value.promptContexts, result.promptContexts),
    promptVariables: values.reduce((sum, value) => sum + value.promptVariables, result.promptVariables),
    messageRoles: values.reduce((sum, value) => sum + value.messageRoles, result.messageRoles),
    messageSources: values.reduce((sum, value) => sum + value.messageSources, result.messageSources),
    messageBlockTypes: values.reduce((sum, value) => sum + value.messageBlockTypes, result.messageBlockTypes),
    oversizedNames: values.reduce((sum, value) => sum + value.oversizedNames, result.oversizedNames),
    truncatedToolSchemas: values.reduce(
      (sum, value) => sum + value.truncatedToolSchemas,
      result.truncatedToolSchemas,
    ),
  }
}

/** Whether one record lost any structural observation to a hard limit. */
export function hasFlightRecordOmissions(
  omissions: FlightRecordOmissions,
): boolean {
  return Object.values(omissions).some(value => value > 0)
}

/** One projected structural summary and its omission accounting. */
export interface ProjectionResult<T> {
  readonly summary: T
  readonly omissions: FlightRecordOmissions
}
