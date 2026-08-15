/**
 * Host locale resolution and complete command dictionaries.
 * @module dsh-request-flight-recorder/locale
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  LOCALE_PREFERENCE_FIELD,
  LOCALE_SETTINGS_NAMESPACE,
  type LocaleSettings,
} from '@deepseek-ai/dsh-client-locale'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {
  CorrelationMissReason,
  FlightErrorKind,
  FlightOutcome,
  IncompleteFlightOutcome,
} from './types.js'

export type FlightLocale = 'zh' | 'en'

type OutcomeKind = FlightOutcome['kind']
type IncompleteReason = IncompleteFlightOutcome['reason']
type FinishKind = 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'

export interface FlightMessages {
  readonly commandName: '/flight'
  readonly description: string
  readonly hint: string
  readonly usage: string
  readonly truncated: string
  readonly unavailable: string
  readonly noRecords: string
  readonly diffNeedsTwo: string
  readonly noStructuralChanges: string
  readonly recordTitle: (id: string) => string
  readonly notFound: (prefix: string) => string
  readonly ambiguous: (prefix: string) => string
  readonly titles: {
    readonly list: string
    readonly diff: string
    readonly health: string
    readonly explain: string
    readonly stats: string
  }
  readonly labels: {
    readonly turn: string
    readonly step: string
    readonly attempt: string
    readonly model: string
    readonly request: string
    readonly tools: string
    readonly prompt: string
    readonly sections: string
    readonly contexts: string
    readonly variables: string
    readonly outcome: string
    readonly ttft: string
    readonly total: string
    readonly tokens: string
    readonly input: string
    readonly output: string
    readonly captured: string
    readonly completed: string
    readonly active: string
    readonly retained: string
    readonly evicted: string
    readonly truncatedRecords: string
    readonly correlationMisses: string
    readonly projectionFailures: string
    readonly subscriberFailures: string
    readonly successRatio: string
    readonly firstChunk: string
    readonly median: string
    readonly p95: string
  }
  readonly outcomes: Readonly<Record<OutcomeKind, string>>
  readonly finishes: Readonly<Record<FinishKind, string>>
  readonly incomplete: Readonly<Record<IncompleteReason, string>>
  readonly errors: Readonly<Record<FlightErrorKind, string>>
  readonly correlation: Readonly<Record<CorrelationMissReason, string>>
  readonly namedChanges: Readonly<Record<'added' | 'removed' | 'changed', string>>
  readonly facts: {
    readonly running: string
    readonly incomplete: string
    readonly threw: string
    readonly requestTruncated: string
    readonly promptTruncated: string
    readonly slowFirstChunk: string
    readonly slowTotal: string
    readonly missingPromptAssembly: string
    readonly noAnomaly: string
  }
  readonly suggestions: {
    readonly title: string
    readonly compare: string
    readonly inspectLifecycle: string
  }
  readonly retainedWindow: string
  readonly messages: (count: number) => string
  readonly characters: (count: number) => string
  readonly toolCount: (count: number) => string
}

const zhMessages: FlightMessages = {
  commandName: '/flight',
  description: '检查不含正文的模型请求诊断',
  hint: '[latest|list [failed|slow|truncated] [limit]|show <id>|diff [from] [to]|health|explain <id>|stats]',
  usage: '用法：/flight [latest|list [failed|slow|truncated] [limit]|show <id>|diff [from] [to]|health|explain <id>|stats]',
  truncated: '\n… 输出已截断',
  unavailable: '不可用',
  noRecords: '当前 Session 没有保留的飞行记录',
  diffNeedsTwo: 'Diff 至少需要当前 Session 中的两条保留记录',
  noStructuralChanges: '没有结构变化',
  recordTitle: id => `飞行记录 ${id}`,
  notFound: prefix => `当前 Session 中未找到请求 ID 前缀“${prefix}”`,
  ambiguous: prefix => `当前 Session 中的请求 ID 前缀“${prefix}”不唯一`,
  titles: {
    list: '飞行记录列表',
    diff: '飞行记录差异',
    health: '飞行记录健康状态',
    explain: '飞行记录解释',
    stats: '飞行记录统计',
  },
  labels: {
    turn: '轮次',
    step: '步骤',
    attempt: '尝试',
    model: '模型',
    request: '请求',
    tools: '工具',
    prompt: '提示词',
    sections: '区段',
    contexts: '上下文',
    variables: '变量',
    outcome: '结果',
    ttft: '首 Chunk',
    total: '总耗时',
    tokens: 'Token',
    input: '输入',
    output: '输出',
    captured: '已捕获',
    completed: '已完成',
    active: '进行中',
    retained: '已保留',
    evicted: '已淘汰',
    truncatedRecords: '已截断记录',
    correlationMisses: '关联失败',
    projectionFailures: '投影失败',
    subscriberFailures: '订阅者失败',
    successRatio: '成功率',
    firstChunk: '首 Chunk',
    median: '中位数',
    p95: 'P95',
  },
  outcomes: {
    running: '进行中',
    finished: '成功结束',
    threw: '异常',
    incomplete: '未完整结束',
  },
  finishes: {
    stop: '正常停止',
    'tool-calls': '工具调用',
    'max-tokens': '达到 Token 上限',
    aborted: '已中止',
    error: '错误',
  },
  incomplete: {
    'stream-ended-without-finish': '流结束但没有 Finish',
    'consumer-returned': '消费者提前返回',
    'consumer-threw': '消费者抛出异常',
  },
  errors: {
    error: '错误',
    'type-error': '类型错误',
    'range-error': '范围错误',
    'syntax-error': '语法错误',
    'reference-error': '引用错误',
    'uri-error': 'URI 错误',
    'eval-error': '求值错误',
    'aggregate-error': '聚合错误',
    'abort-error': '中止错误',
    'timeout-error': '超时错误',
    'non-error-thrown': '抛出非 Error 值',
  },
  correlation: {
    'missing-signal': '缺少 Signal',
    'missing-pending': '缺少待处理请求',
    'agent-mismatch': 'Agent 不匹配',
    'session-mismatch': 'Session 不匹配',
  },
  namedChanges: {
    added: '新增',
    removed: '移除',
    changed: '变更',
  },
  facts: {
    running: '请求仍在进行中',
    incomplete: '流未完整结束',
    threw: '请求以有限错误分类结束',
    requestTruncated: '请求结构存在省略',
    promptTruncated: '提示词结构存在省略',
    slowFirstChunk: '首 Chunk 延迟达到慢请求阈值',
    slowTotal: '总耗时达到慢请求阈值',
    missingPromptAssembly: '没有 Prompt Assembly 证据',
    noAnomaly: '未发现已知异常',
  },
  suggestions: {
    title: '建议检查',
    compare: '与相邻请求的结构差异进行比较',
    inspectLifecycle: '检查请求消费者与流生命周期',
  },
  retainedWindow: '当前 Session 保留窗口',
  messages: count => `${count} 条消息`,
  characters: count => `${count} 个字符`,
  toolCount: count => `${count} 个工具`,
}

const enMessages: FlightMessages = {
  commandName: '/flight',
  description: 'Inspect content-free model request diagnostics',
  hint: '[latest|list [failed|slow|truncated] [limit]|show <id>|diff [from] [to]|health|explain <id>|stats]',
  usage: 'usage: /flight [latest|list [failed|slow|truncated] [limit]|show <id>|diff [from] [to]|health|explain <id>|stats]',
  truncated: '\n… output truncated',
  unavailable: 'unavailable',
  noRecords: 'no retained flight records for this Session',
  diffNeedsTwo: 'diff requires at least two retained flight records for this Session',
  noStructuralChanges: 'no structural changes',
  recordTitle: id => `flight ${id}`,
  notFound: prefix => `request id prefix "${prefix}" was not found in this Session`,
  ambiguous: prefix => `request id prefix "${prefix}" is ambiguous in this Session`,
  titles: {
    list: 'flight list',
    diff: 'flight diff',
    health: 'flight health',
    explain: 'flight explanation',
    stats: 'flight statistics',
  },
  labels: {
    turn: 'turn',
    step: 'step',
    attempt: 'attempt',
    model: 'model',
    request: 'request',
    tools: 'tools',
    prompt: 'prompt',
    sections: 'sections',
    contexts: 'contexts',
    variables: 'variables',
    outcome: 'outcome',
    ttft: 'ttft',
    total: 'total',
    tokens: 'tokens',
    input: 'in',
    output: 'out',
    captured: 'captured',
    completed: 'completed',
    active: 'active',
    retained: 'retained',
    evicted: 'evicted',
    truncatedRecords: 'truncated records',
    correlationMisses: 'correlation misses',
    projectionFailures: 'projection failures',
    subscriberFailures: 'subscriber failures',
    successRatio: 'success ratio',
    firstChunk: 'first chunk',
    median: 'median',
    p95: 'P95',
  },
  outcomes: {
    running: 'running',
    finished: 'finished',
    threw: 'threw',
    incomplete: 'incomplete',
  },
  finishes: {
    stop: 'stop',
    'tool-calls': 'tool calls',
    'max-tokens': 'max tokens',
    aborted: 'aborted',
    error: 'error',
  },
  incomplete: {
    'stream-ended-without-finish': 'stream ended without finish',
    'consumer-returned': 'consumer returned',
    'consumer-threw': 'consumer threw',
  },
  errors: {
    error: 'error',
    'type-error': 'type error',
    'range-error': 'range error',
    'syntax-error': 'syntax error',
    'reference-error': 'reference error',
    'uri-error': 'URI error',
    'eval-error': 'eval error',
    'aggregate-error': 'aggregate error',
    'abort-error': 'abort error',
    'timeout-error': 'timeout error',
    'non-error-thrown': 'non-Error value thrown',
  },
  correlation: {
    'missing-signal': 'missing signal',
    'missing-pending': 'missing pending request',
    'agent-mismatch': 'agent mismatch',
    'session-mismatch': 'session mismatch',
  },
  namedChanges: {
    added: 'added',
    removed: 'removed',
    changed: 'changed',
  },
  facts: {
    running: 'request is still running',
    incomplete: 'stream did not finish completely',
    threw: 'request ended with a finite error classification',
    requestTruncated: 'request structure contains omissions',
    promptTruncated: 'prompt structure contains omissions',
    slowFirstChunk: 'first chunk latency reached the slow threshold',
    slowTotal: 'total duration reached the slow threshold',
    missingPromptAssembly: 'prompt assembly evidence is absent',
    noAnomaly: 'no known anomaly was found',
  },
  suggestions: {
    title: 'checks',
    compare: 'compare structural differences with adjacent requests',
    inspectLifecycle: 'inspect the request consumer and stream lifecycle',
  },
  retainedWindow: 'retained window for this Session',
  messages: count => `${count} message${count === 1 ? '' : 's'}`,
  characters: count => `${count} system chars`,
  toolCount: count => `${count} tool${count === 1 ? '' : 's'}`,
}

export const FLIGHT_MESSAGES: Readonly<Record<FlightLocale, FlightMessages>> =
  Object.freeze({
    zh: Object.freeze(zhMessages),
    en: Object.freeze(enMessages),
  })

export function normalizeFlightLocale(value: unknown): FlightLocale {
  return value === 'en' ? 'en' : 'zh'
}

export function readFlightLocale(ctx: Context): FlightLocale {
  const settings = ctx.get('settings')
  if (settings === undefined) return 'zh'
  const section = settings.get(
    settingsNamespace(LOCALE_SETTINGS_NAMESPACE),
  ) as LocaleSettings | undefined
  return normalizeFlightLocale(section?.[LOCALE_PREFERENCE_FIELD])
}
