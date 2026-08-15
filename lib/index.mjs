import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { deepFreeze, isAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import { LOCALE_PREFERENCE_FIELD, LOCALE_SETTINGS_NAMESPACE } from "@deepseek-ai/dsh-client-locale";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
//#region src/diff.ts
/**
* Deterministic content-free request flight record comparison.
* @module dsh-request-flight-recorder/diff
*/
function finishKind(record) {
	return record.outcome.kind === "finished" ? record.outcome.finish.kind : null;
}
function timing(record, key) {
	if (record.outcome.kind === "running") return null;
	return record.outcome[key] ?? null;
}
function usage(record, key) {
	return "usage" in record.outcome ? record.outcome.usage?.[key] ?? null : null;
}
function addValue(changes, field, before, after) {
	if (before === after) return;
	changes.push({
		kind: "value",
		field,
		before,
		after
	});
}
function addCounter(changes, field, key, before, after) {
	if (before === after) return;
	changes.push({
		kind: "counter",
		field,
		key,
		before,
		after,
		delta: before === null || after === null ? null : after - before
	});
}
function addKeyedCounters(changes, field, before, after) {
	const keys = [.../* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after)])].sort();
	for (const key of keys) addCounter(changes, field, key, before[key] ?? 0, after[key] ?? 0);
}
function tools(record) {
	return new Map(record.request.tools.map((tool) => [tool.name, tool.parameterNodes]));
}
function sections(record) {
	return new Map((record.promptAssembly?.sections ?? []).map((section) => [section.name, section.characters]));
}
function contexts(record) {
	return new Map((record.promptAssembly?.contexts ?? []).map((context) => [context.name, context.characters]));
}
function variables(record) {
	return new Map((record.promptAssembly?.variables ?? []).map((name) => [name, null]));
}
function addNamed(changes, field, before, after) {
	const names = [.../* @__PURE__ */ new Set([...before.keys(), ...after.keys()])].sort();
	for (const name of names) {
		const existedBefore = before.has(name);
		const existsAfter = after.has(name);
		const beforeSize = existedBefore ? before.get(name) : null;
		const afterSize = existsAfter ? after.get(name) : null;
		if (existedBefore && existsAfter && beforeSize === afterSize) continue;
		changes.push({
			kind: "named",
			field,
			name,
			change: !existedBefore ? "added" : !existsAfter ? "removed" : "changed",
			beforeSize,
			afterSize
		});
	}
}
/**
* Compare two retained request attempts without accessing model-visible content.
* @param from - earlier request attempt.
* @param to - later request attempt.
* @returns deeply frozen deterministic structural changes.
*/
function diffFlightRecords(from, to) {
	const changes = [];
	addValue(changes, "request.provider", from.request.provider, to.request.provider);
	addValue(changes, "request.model", from.request.model, to.request.model);
	addValue(changes, "request.reasoningEffort", from.request.reasoningEffort ?? null, to.request.reasoningEffort ?? null);
	addValue(changes, "request.temperature", from.request.temperature ?? null, to.request.temperature ?? null);
	addValue(changes, "request.maxTokens", from.request.maxTokens ?? null, to.request.maxTokens ?? null);
	addValue(changes, "outcome.kind", from.outcome.kind, to.outcome.kind);
	addValue(changes, "outcome.finish", finishKind(from), finishKind(to));
	addCounter(changes, "request.systemCharacters", null, from.request.systemCharacters, to.request.systemCharacters);
	addCounter(changes, "messages.total", null, from.request.messages.total, to.request.messages.total);
	addKeyedCounters(changes, "messages.byRole", from.request.messages.byRole, to.request.messages.byRole);
	addKeyedCounters(changes, "messages.bySource", from.request.messages.bySource, to.request.messages.bySource);
	addKeyedCounters(changes, "messages.byBlockType", from.request.messages.byBlockType, to.request.messages.byBlockType);
	addCounter(changes, "timing.firstChunkMs", null, timing(from, "firstChunkMs"), timing(to, "firstChunkMs"));
	addCounter(changes, "timing.totalMs", null, timing(from, "totalMs"), timing(to, "totalMs"));
	addCounter(changes, "usage.inputTokens", null, usage(from, "inputTokens"), usage(to, "inputTokens"));
	addCounter(changes, "usage.outputTokens", null, usage(from, "outputTokens"), usage(to, "outputTokens"));
	addNamed(changes, "tools", tools(from), tools(to));
	addNamed(changes, "prompt.sections", sections(from), sections(to));
	addNamed(changes, "prompt.contexts", contexts(from), contexts(to));
	addNamed(changes, "prompt.variables", variables(from), variables(to));
	return deepFreeze({
		fromId: from.id,
		toId: to.id,
		changed: changes.length > 0,
		changes
	});
}
//#endregion
//#region src/format.ts
/** Maximum command-result text retained by the official command lifecycle. */
const MAX_COMMAND_OUTPUT = 4096;
function shortId(id) {
	return id.slice(0, 8);
}
function list(values) {
	return values.length === 0 ? "-" : values.join(", ");
}
function outcome(record, messages) {
	const value = record.outcome;
	if (value.kind === "running") return `${messages.labels.outcome} ${messages.outcomes.running}`;
	const timing = [
		value.firstChunkMs === void 0 ? void 0 : `${messages.labels.ttft} ${value.firstChunkMs}ms`,
		`${messages.labels.total} ${value.totalMs}ms`,
		value.usage === void 0 ? void 0 : `${messages.labels.tokens} ${value.usage.inputTokens} ${messages.labels.input} / ${value.usage.outputTokens} ${messages.labels.output}`
	].filter((part) => part !== void 0);
	const status = value.kind === "finished" ? `${messages.outcomes.finished}:${messages.finishes[value.finish.kind]}` : value.kind === "threw" ? `${messages.outcomes.threw}:${messages.errors[value.error.kind]}` : `${messages.outcomes.incomplete}:${messages.incomplete[value.reason]}`;
	return `${messages.labels.outcome} ${status} · ${timing.join(" · ")}`;
}
/**
* Render one retained request attempt.
* @param record - immutable structural request record.
* @returns concise plain text with no ANSI sequences.
*/
function formatRecord(record, messages) {
	const prompt = record.promptAssembly;
	return [
		messages.recordTitle(shortId(record.id)),
		`${messages.labels.turn} ${record.turn} · ${messages.labels.step} ${record.step} · ${messages.labels.attempt} ${record.attempt}`,
		`${messages.labels.model} ${record.request.provider}/${record.request.model}`,
		`${messages.labels.request} ${messages.messages(record.request.messages.total)} · ${messages.characters(record.request.systemCharacters)} · ${messages.toolCount(record.request.tools.length)}`,
		`${messages.labels.tools} ${list(record.request.tools.map((tool) => `${tool.name}(${tool.parameterNodes})`))}`,
		`${messages.labels.prompt} ${messages.labels.sections} ${list(prompt?.sections.map((item) => item.name) ?? [])} · ${messages.labels.contexts} ${list(prompt?.contexts.map((item) => item.name) ?? [])} · ${messages.labels.variables} ${list(prompt?.variables ?? [])}`,
		outcome(record, messages)
	].join("\n");
}
/**
* Render compact rows for retained request attempts.
* @param records - immutable records already scoped to the invoking Session.
* @returns plain text containing only identity, coordinates, model, and outcome.
*/
function formatRecordList(records, messages) {
	return [messages.titles.list, ...records.map((record) => `${shortId(record.id)} · ${messages.labels.turn} ${record.turn} · ${messages.labels.step} ${record.step} · ${messages.labels.attempt} ${record.attempt} · ${record.request.provider}/${record.request.model} · ${messages.outcomes[record.outcome.kind]}`)].join("\n");
}
/**
* Render process-local recorder health without Session detail.
* @param health - immutable health snapshot.
* @returns concise aggregate plain text.
*/
function formatHealth(health, messages) {
	return [
		messages.titles.health,
		`${messages.labels.captured} ${health.captured} · ${messages.labels.completed} ${health.completed} · ${messages.labels.active} ${health.active}`,
		`${messages.labels.retained} ${health.retained} · ${messages.labels.evicted} ${health.evicted}`,
		`${messages.labels.truncatedRecords} ${health.truncatedRecords} · ${messages.labels.projectionFailures} ${health.projectionFailures} · ${messages.labels.subscriberFailures} ${health.subscriberFailures}`,
		`${messages.labels.correlationMisses} ${health.correlationMisses}`,
		`${messages.correlation["missing-signal"]} ${health.correlationMissesByReason["missing-signal"]} · ${messages.correlation["missing-pending"]} ${health.correlationMissesByReason["missing-pending"]}`,
		`${messages.correlation["agent-mismatch"]} ${health.correlationMissesByReason["agent-mismatch"]} · ${messages.correlation["session-mismatch"]} ${health.correlationMissesByReason["session-mismatch"]}`
	].join("\n");
}
function scalar(value) {
	return value === null ? "∅" : String(value);
}
function formatValue(change) {
	return `${change.field}: ${scalar(change.before)} → ${scalar(change.after)}`;
}
function formatCounter(change) {
	const field = change.key === null ? change.field : `${change.field}[${change.key}]`;
	const delta = change.delta === null ? "" : ` (${change.delta >= 0 ? "+" : ""}${change.delta})`;
	return `${field}: ${scalar(change.before)} → ${scalar(change.after)}${delta}`;
}
function formatNamed(change, messages) {
	return `${change.field} ${change.name}: ${messages.namedChanges[change.change]} (${scalar(change.beforeSize)} → ${scalar(change.afterSize)})`;
}
function formatChange(change, messages) {
	if (change.kind === "value") return formatValue(change);
	if (change.kind === "counter") return formatCounter(change);
	return formatNamed(change, messages);
}
/**
* Render a deterministic record diff.
* @param diff - immutable structural diff.
* @returns plain-text change list.
*/
function formatDiff(diff, messages) {
	return [`${messages.titles.diff} ${shortId(diff.fromId)} → ${shortId(diff.toId)}`, ...diff.changed ? diff.changes.map((change) => formatChange(change, messages)) : [messages.noStructuralChanges]].join("\n");
}
function formatFact(fact, messages) {
	if (fact.kind === "running") return messages.facts.running;
	if (fact.kind === "incomplete") return `${messages.facts.incomplete}: ${messages.incomplete[fact.reason]}`;
	if (fact.kind === "threw") return `${messages.facts.threw}: ${messages.errors[fact.error]}`;
	if (fact.kind === "request-truncated") return `${messages.facts.requestTruncated}: ${fact.count}`;
	if (fact.kind === "prompt-truncated") return `${messages.facts.promptTruncated}: ${fact.count}`;
	if (fact.kind === "slow-first-chunk") return `${messages.facts.slowFirstChunk}: ${fact.milliseconds}ms`;
	if (fact.kind === "slow-total") return `${messages.facts.slowTotal}: ${fact.milliseconds}ms`;
	if (fact.kind === "missing-prompt-assembly") return messages.facts.missingPromptAssembly;
	return messages.facts.noAnomaly;
}
function formatExplanation(record, facts, messages) {
	return [
		`${messages.titles.explain} ${shortId(record.id)}`,
		...facts.map((fact) => `- ${formatFact(fact, messages)}`),
		`${messages.suggestions.title}:`,
		`- ${messages.suggestions.compare}`,
		`- ${messages.suggestions.inspectLifecycle}`
	].join("\n");
}
function metric(value, messages) {
	return value === void 0 ? messages.unavailable : String(value);
}
function milliseconds(value, messages) {
	return value === void 0 ? messages.unavailable : `${value}ms`;
}
function ratio(value, messages) {
	if (value === void 0) return messages.unavailable;
	return `${Math.round(value * 1e3) / 10}%`;
}
function formatWindowStats(stats, messages) {
	return [
		`${messages.titles.stats} · ${messages.retainedWindow}`,
		`${messages.labels.retained} ${stats.retained} · ${messages.labels.truncatedRecords} ${stats.truncated}`,
		`${messages.outcomes.running} ${stats.outcomes.running} · ${messages.outcomes.finished} ${stats.outcomes.finished} · ${messages.outcomes.threw} ${stats.outcomes.threw} · ${messages.outcomes.incomplete} ${stats.outcomes.incomplete}`,
		`${messages.labels.successRatio} ${ratio(stats.successRatio, messages)}`,
		`${messages.labels.firstChunk}: ${messages.labels.median} ${milliseconds(stats.firstChunk.median, messages)} · ${messages.labels.p95} ${milliseconds(stats.firstChunk.p95, messages)}`,
		`${messages.labels.total}: ${messages.labels.median} ${milliseconds(stats.total.median, messages)} · ${messages.labels.p95} ${milliseconds(stats.total.p95, messages)}`,
		`${messages.labels.tokens}: ${messages.labels.input} ${metric(stats.inputTokens, messages)} · ${messages.labels.output} ${metric(stats.outputTokens, messages)}`
	].join("\n");
}
/**
* Bound command text without cutting a UTF-16 surrogate pair.
* @param text - complete command-result text.
* @param max - maximum UTF-16 code units including the marker.
* @returns unchanged or safely truncated text.
*/
function boundCommandText(text, messages, max = MAX_COMMAND_OUTPUT) {
	const marker = messages.truncated;
	if (!Number.isSafeInteger(max) || max <= marker.length) throw new RangeError("max must fit the truncation marker");
	if (text.length <= max) return text;
	let end = max - marker.length;
	const finalCodeUnit = text.charCodeAt(end - 1);
	if (finalCodeUnit >= 55296 && finalCodeUnit <= 56319) end -= 1;
	return text.slice(0, end) + marker;
}
/**
* Service Definition for the user-settings capability seam (`ctx.settings`). Providers store one raw document of
* per-namespace sections; plugins register a namespace schema and read the
* resolved value, which layers schema defaults, the registrant's composition
* `base`, and the user document section, in that order.
* @module @deepseek-ai/dsh-settings
*/
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
/**
* Brand a raw string as a {@link SettingsNamespace}.
* @param value - candidate namespace; lowercase kebab-case, as in plugin short names.
* @returns the branded namespace.
*/
function settingsNamespace(value) {
	if (!NAMESPACE_PATTERN.test(value)) throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`);
	return value;
}
Service.init;
const FLIGHT_MESSAGES = Object.freeze({
	zh: Object.freeze({
		commandName: "/flight",
		description: "检查不含正文的模型请求诊断",
		hint: "[latest|list [failed|slow|truncated] [limit]|show <id>|diff [from] [to]|health|explain <id>|stats]",
		usage: "用法：/flight [latest|list [failed|slow|truncated] [limit]|show <id>|diff [from] [to]|health|explain <id>|stats]",
		truncated: "\n… 输出已截断",
		unavailable: "不可用",
		noRecords: "当前 Session 没有保留的飞行记录",
		diffNeedsTwo: "Diff 至少需要当前 Session 中的两条保留记录",
		noStructuralChanges: "没有结构变化",
		recordTitle: (id) => `飞行记录 ${id}`,
		notFound: (prefix) => `当前 Session 中未找到请求 ID 前缀“${prefix}”`,
		ambiguous: (prefix) => `当前 Session 中的请求 ID 前缀“${prefix}”不唯一`,
		titles: {
			list: "飞行记录列表",
			diff: "飞行记录差异",
			health: "飞行记录健康状态",
			explain: "飞行记录解释",
			stats: "飞行记录统计"
		},
		labels: {
			turn: "轮次",
			step: "步骤",
			attempt: "尝试",
			model: "模型",
			request: "请求",
			tools: "工具",
			prompt: "提示词",
			sections: "区段",
			contexts: "上下文",
			variables: "变量",
			outcome: "结果",
			ttft: "首 Chunk",
			total: "总耗时",
			tokens: "Token",
			input: "输入",
			output: "输出",
			captured: "已捕获",
			completed: "已完成",
			active: "进行中",
			retained: "已保留",
			evicted: "已淘汰",
			truncatedRecords: "已截断记录",
			correlationMisses: "关联失败",
			projectionFailures: "投影失败",
			subscriberFailures: "订阅者失败",
			successRatio: "成功率",
			firstChunk: "首 Chunk",
			median: "中位数",
			p95: "P95"
		},
		outcomes: {
			running: "进行中",
			finished: "成功结束",
			threw: "异常",
			incomplete: "未完整结束"
		},
		finishes: {
			stop: "正常停止",
			"tool-calls": "工具调用",
			"max-tokens": "达到 Token 上限",
			aborted: "已中止",
			error: "错误"
		},
		incomplete: {
			"stream-ended-without-finish": "流结束但没有 Finish",
			"consumer-returned": "消费者提前返回",
			"consumer-threw": "消费者抛出异常"
		},
		errors: {
			error: "错误",
			"type-error": "类型错误",
			"range-error": "范围错误",
			"syntax-error": "语法错误",
			"reference-error": "引用错误",
			"uri-error": "URI 错误",
			"eval-error": "求值错误",
			"aggregate-error": "聚合错误",
			"abort-error": "中止错误",
			"timeout-error": "超时错误",
			"non-error-thrown": "抛出非 Error 值"
		},
		correlation: {
			"missing-signal": "缺少 Signal",
			"missing-pending": "缺少待处理请求",
			"agent-mismatch": "Agent 不匹配",
			"session-mismatch": "Session 不匹配"
		},
		namedChanges: {
			added: "新增",
			removed: "移除",
			changed: "变更"
		},
		facts: {
			running: "请求仍在进行中",
			incomplete: "流未完整结束",
			threw: "请求以有限错误分类结束",
			requestTruncated: "请求结构存在省略",
			promptTruncated: "提示词结构存在省略",
			slowFirstChunk: "首 Chunk 延迟达到慢请求阈值",
			slowTotal: "总耗时达到慢请求阈值",
			missingPromptAssembly: "没有 Prompt Assembly 证据",
			noAnomaly: "未发现已知异常"
		},
		suggestions: {
			title: "建议检查",
			compare: "与相邻请求的结构差异进行比较",
			inspectLifecycle: "检查请求消费者与流生命周期"
		},
		retainedWindow: "当前 Session 保留窗口",
		messages: (count) => `${count} 条消息`,
		characters: (count) => `${count} 个字符`,
		toolCount: (count) => `${count} 个工具`
	}),
	en: Object.freeze({
		commandName: "/flight",
		description: "Inspect content-free model request diagnostics",
		hint: "[latest|list [failed|slow|truncated] [limit]|show <id>|diff [from] [to]|health|explain <id>|stats]",
		usage: "usage: /flight [latest|list [failed|slow|truncated] [limit]|show <id>|diff [from] [to]|health|explain <id>|stats]",
		truncated: "\n… output truncated",
		unavailable: "unavailable",
		noRecords: "no retained flight records for this Session",
		diffNeedsTwo: "diff requires at least two retained flight records for this Session",
		noStructuralChanges: "no structural changes",
		recordTitle: (id) => `flight ${id}`,
		notFound: (prefix) => `request id prefix "${prefix}" was not found in this Session`,
		ambiguous: (prefix) => `request id prefix "${prefix}" is ambiguous in this Session`,
		titles: {
			list: "flight list",
			diff: "flight diff",
			health: "flight health",
			explain: "flight explanation",
			stats: "flight statistics"
		},
		labels: {
			turn: "turn",
			step: "step",
			attempt: "attempt",
			model: "model",
			request: "request",
			tools: "tools",
			prompt: "prompt",
			sections: "sections",
			contexts: "contexts",
			variables: "variables",
			outcome: "outcome",
			ttft: "ttft",
			total: "total",
			tokens: "tokens",
			input: "in",
			output: "out",
			captured: "captured",
			completed: "completed",
			active: "active",
			retained: "retained",
			evicted: "evicted",
			truncatedRecords: "truncated records",
			correlationMisses: "correlation misses",
			projectionFailures: "projection failures",
			subscriberFailures: "subscriber failures",
			successRatio: "success ratio",
			firstChunk: "first chunk",
			median: "median",
			p95: "P95"
		},
		outcomes: {
			running: "running",
			finished: "finished",
			threw: "threw",
			incomplete: "incomplete"
		},
		finishes: {
			stop: "stop",
			"tool-calls": "tool calls",
			"max-tokens": "max tokens",
			aborted: "aborted",
			error: "error"
		},
		incomplete: {
			"stream-ended-without-finish": "stream ended without finish",
			"consumer-returned": "consumer returned",
			"consumer-threw": "consumer threw"
		},
		errors: {
			error: "error",
			"type-error": "type error",
			"range-error": "range error",
			"syntax-error": "syntax error",
			"reference-error": "reference error",
			"uri-error": "URI error",
			"eval-error": "eval error",
			"aggregate-error": "aggregate error",
			"abort-error": "abort error",
			"timeout-error": "timeout error",
			"non-error-thrown": "non-Error value thrown"
		},
		correlation: {
			"missing-signal": "missing signal",
			"missing-pending": "missing pending request",
			"agent-mismatch": "agent mismatch",
			"session-mismatch": "session mismatch"
		},
		namedChanges: {
			added: "added",
			removed: "removed",
			changed: "changed"
		},
		facts: {
			running: "request is still running",
			incomplete: "stream did not finish completely",
			threw: "request ended with a finite error classification",
			requestTruncated: "request structure contains omissions",
			promptTruncated: "prompt structure contains omissions",
			slowFirstChunk: "first chunk latency reached the slow threshold",
			slowTotal: "total duration reached the slow threshold",
			missingPromptAssembly: "prompt assembly evidence is absent",
			noAnomaly: "no known anomaly was found"
		},
		suggestions: {
			title: "checks",
			compare: "compare structural differences with adjacent requests",
			inspectLifecycle: "inspect the request consumer and stream lifecycle"
		},
		retainedWindow: "retained window for this Session",
		messages: (count) => `${count} message${count === 1 ? "" : "s"}`,
		characters: (count) => `${count} system chars`,
		toolCount: (count) => `${count} tool${count === 1 ? "" : "s"}`
	})
});
function normalizeFlightLocale(value) {
	return value === "en" ? "en" : "zh";
}
function readFlightLocale(ctx) {
	const settings = ctx.get("settings");
	if (settings === void 0) return "zh";
	return normalizeFlightLocale(settings.get(settingsNamespace(LOCALE_SETTINGS_NAMESPACE))?.[LOCALE_PREFERENCE_FIELD]);
}
//#endregion
//#region src/limits.ts
/** Non-configurable safety limits forming the v1 record contract. */
const FLIGHT_LIMITS = Object.freeze({
	nameCharacters: 256,
	tools: 128,
	promptSections: 256,
	promptContexts: 256,
	promptVariables: 256,
	messageCounterKeys: 64,
	toolSchemaNodes: 4096
});
/** Create detached zero-valued omission accounting. */
function emptyFlightRecordOmissions() {
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
		truncatedToolSchemas: 0
	};
}
/** Merge omission counters without mutating any projection result. */
function mergeFlightRecordOmissions(...values) {
	const result = emptyFlightRecordOmissions();
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
		truncatedToolSchemas: values.reduce((sum, value) => sum + value.truncatedToolSchemas, result.truncatedToolSchemas)
	};
}
/** Whether one record lost any structural observation to a hard limit. */
function hasFlightRecordOmissions(omissions) {
	return Object.values(omissions).some((value) => value > 0);
}
Object.freeze({
	slowFirstChunkMs: 1e3,
	slowTotalMs: 2e3
});
function sorted(values) {
	return [...values].sort((left, right) => left - right);
}
function nearestRank(values, percentile) {
	if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) throw new RangeError("percentile must be greater than zero and at most one");
	if (values.length === 0) return void 0;
	const ordered = sorted(values);
	return ordered[Math.ceil(percentile * ordered.length) - 1];
}
function median(values) {
	if (values.length === 0) return void 0;
	const ordered = sorted(values);
	const middle = Math.floor(ordered.length / 2);
	return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}
function isTerminal(outcome) {
	return outcome.kind !== "running";
}
function isSlow(record, thresholds) {
	const outcome = record.outcome;
	return isTerminal(outcome) && (outcome.firstChunkMs !== void 0 && outcome.firstChunkMs >= thresholds.slowFirstChunkMs || outcome.totalMs >= thresholds.slowTotalMs);
}
function filterFlightRecords(records, filter, thresholds) {
	if (filter === "all") return Object.freeze([...records]);
	return Object.freeze(records.filter((record) => {
		if (filter === "failed") return record.outcome.kind === "threw" || record.outcome.kind === "incomplete";
		if (filter === "slow") return isSlow(record, thresholds);
		return hasFlightRecordOmissions(record.omissions);
	}));
}
function requestOmissions(record) {
	const omissions = record.omissions;
	return omissions.requestTools + omissions.messageRoles + omissions.messageSources + omissions.messageBlockTypes + omissions.oversizedNames + omissions.truncatedToolSchemas;
}
function promptOmissions(record) {
	const omissions = record.omissions;
	return omissions.promptTools + omissions.promptSections + omissions.promptContexts + omissions.promptVariables;
}
function explainFlightRecord(record, thresholds) {
	const facts = [];
	const outcome = record.outcome;
	if (outcome.kind === "running") facts.push({ kind: "running" });
	else if (outcome.kind === "incomplete") facts.push({
		kind: "incomplete",
		reason: outcome.reason
	});
	else if (outcome.kind === "threw") facts.push({
		kind: "threw",
		error: outcome.error.kind
	});
	const requestCount = requestOmissions(record);
	if (requestCount > 0) facts.push({
		kind: "request-truncated",
		count: requestCount
	});
	const promptCount = promptOmissions(record);
	if (promptCount > 0) facts.push({
		kind: "prompt-truncated",
		count: promptCount
	});
	if (isTerminal(outcome) && outcome.firstChunkMs !== void 0 && outcome.firstChunkMs >= thresholds.slowFirstChunkMs) facts.push({
		kind: "slow-first-chunk",
		milliseconds: outcome.firstChunkMs
	});
	if (isTerminal(outcome) && outcome.totalMs >= thresholds.slowTotalMs) facts.push({
		kind: "slow-total",
		milliseconds: outcome.totalMs
	});
	if (record.promptAssembly === void 0) facts.push({ kind: "missing-prompt-assembly" });
	if (facts.length === 0) facts.push({ kind: "no-anomaly" });
	return Object.freeze(facts);
}
function summarizeFlightWindow(records) {
	const outcomes = {
		running: 0,
		finished: 0,
		threw: 0,
		incomplete: 0
	};
	const firstChunk = [];
	const total = [];
	let inputTokens;
	let outputTokens;
	let terminal = 0;
	let truncated = 0;
	for (const record of records) {
		const outcome = record.outcome;
		outcomes[outcome.kind] += 1;
		if (hasFlightRecordOmissions(record.omissions)) truncated += 1;
		if (!isTerminal(outcome)) continue;
		terminal += 1;
		total.push(outcome.totalMs);
		if (outcome.firstChunkMs !== void 0) firstChunk.push(outcome.firstChunkMs);
		if (outcome.usage !== void 0) {
			inputTokens = (inputTokens ?? 0) + outcome.usage.inputTokens;
			outputTokens = (outputTokens ?? 0) + outcome.usage.outputTokens;
		}
	}
	return Object.freeze({
		retained: records.length,
		outcomes: Object.freeze(outcomes),
		successRatio: terminal === 0 ? void 0 : outcomes.finished / terminal,
		firstChunk: Object.freeze({
			median: median(firstChunk),
			p95: nearestRank(firstChunk, .95)
		}),
		total: Object.freeze({
			median: median(total),
			p95: nearestRank(total, .95)
		}),
		inputTokens,
		outputTokens,
		truncated
	});
}
//#endregion
//#region src/command.ts
function error(text) {
	return {
		kind: "error",
		text
	};
}
function success(text, messages) {
	return {
		kind: "success",
		text: boundCommandText(text, messages)
	};
}
function resolvePrefix(records, prefix, messages) {
	const matches = records.filter((record) => record.id.startsWith(prefix));
	if (matches.length === 0) return error(messages.notFound(prefix));
	if (matches.length > 1) return error(messages.ambiguous(prefix));
	return matches[0];
}
function isCommandResult(value) {
	return "kind" in value;
}
function latest(records, messages) {
	const record = records[0];
	return record === void 0 ? error(messages.noRecords) : success(formatRecord(record, messages), messages);
}
function listRecords(records, filter, limit, thresholds, messages) {
	const selected = filterFlightRecords(records, filter, thresholds).slice(0, limit);
	return selected.length === 0 ? error(messages.noRecords) : success(formatRecordList(selected, messages), messages);
}
function parseLimit(value) {
	const limit = Number(value);
	return Number.isSafeInteger(limit) && limit >= 1 && limit <= 20 ? limit : void 0;
}
function parseList(args) {
	if (args.length === 0) return {
		filter: "all",
		limit: 10
	};
	if (args.length === 1) {
		const limit = parseLimit(args[0]);
		if (limit !== void 0) return {
			filter: "all",
			limit
		};
		const filter = args[0];
		if (filter === "all" || filter === "failed" || filter === "slow" || filter === "truncated") return {
			filter,
			limit: 10
		};
		return;
	}
	if (args.length === 2) {
		const [filter, rawLimit] = args;
		const limit = parseLimit(rawLimit);
		if (limit !== void 0 && (filter === "all" || filter === "failed" || filter === "slow" || filter === "truncated")) return {
			filter,
			limit
		};
	}
}
function show(records, prefix, messages) {
	const record = resolvePrefix(records, prefix, messages);
	return isCommandResult(record) ? record : success(formatRecord(record, messages), messages);
}
function renderDiff(from, to, messages) {
	return success(formatDiff(diffFlightRecords(from, to), messages), messages);
}
function implicitDiff(records, messages) {
	if (records.length < 2) return error(messages.diffNeedsTwo);
	return renderDiff(records[1], records[0], messages);
}
function explicitDiff(records, fromPrefix, toPrefix, messages) {
	const from = resolvePrefix(records, fromPrefix, messages);
	if (isCommandResult(from)) return from;
	const to = resolvePrefix(records, toPrefix, messages);
	if (isCommandResult(to)) return to;
	return renderDiff(from, to, messages);
}
function execute(recorder, sessionId, rawInput, messages, thresholds) {
	const snapshot = recorder.snapshot({ sessionId });
	const records = snapshot.records;
	const input = rawInput.trim();
	if (input === "") return latest(records, messages);
	const [command, ...args] = input.split(/\s+/u);
	if (command === "latest" && args.length === 0) return latest(records, messages);
	if (command === "list") {
		const parsed = parseList(args);
		return parsed === void 0 ? error(messages.usage) : listRecords(records, parsed.filter, parsed.limit, thresholds, messages);
	}
	if (command === "health" && args.length === 0) return success(formatHealth(snapshot.health, messages), messages);
	if (command === "show" && args.length === 1) return show(records, args[0], messages);
	if (command === "diff" && args.length === 0) return implicitDiff(records, messages);
	if (command === "diff" && args.length === 2) return explicitDiff(records, args[0], args[1], messages);
	if (command === "explain" && args.length === 1) {
		const record = resolvePrefix(records, args[0], messages);
		return isCommandResult(record) ? record : success(formatExplanation(record, explainFlightRecord(record, thresholds), messages), messages);
	}
	if (command === "stats" && args.length === 0) return success(formatWindowStats(summarizeFlightWindow(records), messages), messages);
	return error(messages.usage);
}
/**
* Register `/flight` through the official human-command registry.
* @param ctx - optional command-injected Cordis child context.
* @param recorder - stable read-only flight recorder.
*/
function registerFlightCommand(ctx, recorder, options) {
	const startupMessages = FLIGHT_MESSAGES[options.startupLocale];
	ctx.commands.register({
		name: "flight",
		description: startupMessages.description,
		input: { hint: startupMessages.hint },
		recordInput: false,
		handler: ({ agent, rawInput }) => {
			const messages = FLIGHT_MESSAGES[options.currentLocale()];
			return execute(recorder, agent.session.id, rawInput, messages, options.thresholds);
		}
	});
}
//#endregion
//#region src/error.ts
const ERROR_KINDS = Object.freeze({
	Error: "error",
	TypeError: "type-error",
	RangeError: "range-error",
	SyntaxError: "syntax-error",
	ReferenceError: "reference-error",
	URIError: "uri-error",
	EvalError: "eval-error",
	AggregateError: "aggregate-error",
	AbortError: "abort-error",
	TimeoutError: "timeout-error"
});
/** Classify a thrown value without retaining arbitrary names or content. */
function classifyFlightError(error) {
	if (!(error instanceof Error)) return Object.freeze({ kind: "non-error-thrown" });
	let name;
	try {
		name = error.name;
	} catch {
		return Object.freeze({ kind: "error" });
	}
	return Object.freeze({ kind: ERROR_KINDS[name] ?? "error" });
}
//#endregion
//#region src/observe-stream.ts
function optionalState(firstChunkMs, usage) {
	return {
		...firstChunkMs === void 0 ? {} : { firstChunkMs },
		...usage === void 0 ? {} : { usage }
	};
}
/**
* Observe a model stream without buffering or replacing its chunks.
* @param stream - downstream model stream.
* @param observe - no-control callback receiving structural observations.
* @param now - monotonic millisecond clock.
* @returns an async iterable that preserves downstream values and failures.
*/
function observeStream(stream, observe, now = performance.now.bind(performance)) {
	const startedAt = now();
	function notify(event) {
		try {
			observe(event);
		} catch {}
	}
	return { [Symbol.asyncIterator]() {
		const downstream = stream[Symbol.asyncIterator]();
		let firstChunkMs;
		let usage;
		let settled = false;
		return {
			async next() {
				let result;
				try {
					result = await downstream.next();
				} catch (error) {
					if (!settled) {
						settled = true;
						notify({
							kind: "threw",
							error,
							totalMs: now() - startedAt,
							...optionalState(firstChunkMs, usage)
						});
					}
					throw error;
				}
				if (result.done) {
					if (!settled) {
						settled = true;
						notify({
							kind: "incomplete",
							reason: "stream-ended-without-finish",
							totalMs: now() - startedAt,
							...optionalState(firstChunkMs, usage)
						});
					}
					return result;
				}
				if (firstChunkMs === void 0) {
					firstChunkMs = now() - startedAt;
					notify({
						kind: "first-chunk",
						elapsedMs: firstChunkMs
					});
				}
				if (result.value.type === "usage") {
					usage = result.value.usage;
					notify({
						kind: "usage",
						usage
					});
				} else if (result.value.type === "finish" && !settled) {
					settled = true;
					notify({
						kind: "finished",
						finish: result.value.reason,
						totalMs: now() - startedAt,
						...optionalState(firstChunkMs, usage)
					});
				}
				return result;
			},
			async return() {
				if (!settled) {
					settled = true;
					notify({
						kind: "incomplete",
						reason: "consumer-returned",
						totalMs: now() - startedAt,
						...optionalState(firstChunkMs, usage)
					});
				}
				return downstream.return === void 0 ? {
					done: true,
					value: void 0
				} : downstream.return();
			},
			async throw(error) {
				if (!settled) {
					settled = true;
					notify({
						kind: "incomplete",
						reason: "consumer-threw",
						totalMs: now() - startedAt,
						...optionalState(firstChunkMs, usage)
					});
				}
				if (downstream.throw === void 0) throw error;
				return downstream.throw(error);
			}
		};
	} };
}
//#endregion
//#region src/project.ts
function increment(counts, key, omissionField, omissions) {
	if (key.length > FLIGHT_LIMITS.nameCharacters) {
		omissions[omissionField] += 1;
		omissions.oversizedNames += 1;
		return;
	}
	if (counts[key] !== void 0) {
		counts[key] += 1;
		return;
	}
	if (Object.keys(counts).length === FLIGHT_LIMITS.messageCounterKeys) {
		omissions[omissionField] += 1;
		return;
	}
	counts[key] = 1;
}
function sourceKey(source) {
	if (source.kind !== "plugin") return source.kind;
	return `plugin:${source.form ?? "opaque"}`;
}
function projectMessages(messages, omissions) {
	const byRole = {};
	const bySource = {};
	const byBlockType = {};
	for (const message of messages) {
		increment(byRole, message.role, "messageRoles", omissions);
		increment(bySource, sourceKey(message.source), "messageSources", omissions);
		for (const block of message.content) increment(byBlockType, block.type, "messageBlockTypes", omissions);
	}
	return {
		total: messages.length,
		byRole,
		bySource,
		byBlockType
	};
}
function countJsonNodes(value) {
	const stack = [value];
	const seen = /* @__PURE__ */ new WeakSet();
	let nodes = 0;
	let truncated = false;
	while (stack.length > 0) {
		if (nodes === FLIGHT_LIMITS.toolSchemaNodes) return {
			nodes,
			truncated: true
		};
		const current = stack.pop();
		if (current !== null && typeof current === "object") {
			if (seen.has(current)) {
				truncated = true;
				continue;
			}
			seen.add(current);
			const values = Array.isArray(current) ? current : Object.values(current);
			for (let index = values.length - 1; index >= 0; index -= 1) stack.push(values[index]);
		}
		nodes += 1;
	}
	return {
		nodes,
		truncated
	};
}
function projectNamed(items, limit, nameOf, project, omissionField, omissions) {
	const result = [];
	for (const item of items) {
		if (nameOf(item).length > FLIGHT_LIMITS.nameCharacters) {
			omissions[omissionField] += 1;
			omissions.oversizedNames += 1;
			continue;
		}
		if (result.length === limit) {
			omissions[omissionField] += 1;
			continue;
		}
		result.push(project(item));
	}
	return result;
}
/**
* Project one exact model request into a content-free structural summary.
* @param options - final request observed at `llm/stream`.
* @returns structural request facts with no message, prompt, or schema text.
*/
function projectRequest(options) {
	const omissions = { ...emptyFlightRecordOmissions() };
	const projectedTools = projectNamed(options.tools ?? [], FLIGHT_LIMITS.tools, (tool) => tool.name, (tool) => {
		const parameters = countJsonNodes(tool.parameters);
		return {
			name: tool.name,
			parameterNodes: parameters.nodes,
			truncated: parameters.truncated
		};
	}, "requestTools", omissions);
	omissions.truncatedToolSchemas = projectedTools.filter((tool) => tool.truncated).length;
	return {
		summary: {
			provider: options.provider,
			model: options.model,
			...options.reasoningEffort === void 0 ? {} : { reasoningEffort: String(options.reasoningEffort) },
			...options.temperature === void 0 ? {} : { temperature: options.temperature },
			...options.maxTokens === void 0 ? {} : { maxTokens: options.maxTokens },
			...options.stop === void 0 ? {} : { stopCount: options.stop.length },
			messages: projectMessages(options.messages, omissions),
			systemCharacters: options.system?.length ?? 0,
			tools: projectedTools.map(({ name, parameterNodes }) => ({
				name,
				parameterNodes
			}))
		},
		omissions
	};
}
/**
* Project one authoritative prompt assembly without retaining contributed text.
* @param assembly - result returned by the prompt-assembly waterfall.
* @returns ordered contribution identities and sizes.
*/
function projectPromptAssembly(assembly) {
	const omissions = { ...emptyFlightRecordOmissions() };
	return {
		summary: {
			sections: projectNamed(assembly.sections, FLIGHT_LIMITS.promptSections, (section) => section.name, (section) => ({
				name: section.name,
				characters: section.text.length
			}), "promptSections", omissions),
			contexts: projectNamed(assembly.contexts, FLIGHT_LIMITS.promptContexts, (context) => context.name, (context) => ({
				name: context.name,
				characters: context.text.length
			}), "promptContexts", omissions),
			tools: projectNamed(assembly.tools, FLIGHT_LIMITS.tools, (tool) => tool.name, (tool) => tool.name, "promptTools", omissions),
			variables: projectNamed(Object.keys(assembly.variables), FLIGHT_LIMITS.promptVariables, (name) => name, (name) => name, "promptVariables", omissions)
		},
		omissions
	};
}
//#endregion
//#region src/types.ts
/** Stable schema carried by every v1 record. */
const FLIGHT_RECORD_SCHEMA_VERSION = 1;
/** Stable in-process reader protocol version. */
const FLIGHT_RECORDER_PROTOCOL_VERSION = 1;
/**
* Brand a runtime string as a request-attempt identity.
* @param value - unique request-attempt value.
* @returns the same string with its compile-time brand.
*/
function RequestAttemptId(value) {
	return value;
}
//#endregion
//#region src/harness-adapter.ts
/**
* DeepSeek Harness event and stream adapter.
* @module dsh-request-flight-recorder/harness-adapter
*/
function normalizeFlightObservation(observation) {
	if (observation.kind === "first-chunk" || observation.kind === "usage") return;
	if (observation.kind === "finished" && (observation.finish.kind === "aborted" || observation.finish.kind === "error")) return {
		kind: "threw",
		error: { kind: "error" },
		...observation.firstChunkMs === void 0 ? {} : { firstChunkMs: observation.firstChunkMs },
		totalMs: observation.totalMs,
		...observation.usage === void 0 ? {} : { usage: observation.usage }
	};
	if (observation.kind === "threw") return {
		...observation,
		error: classifyFlightError(observation.error)
	};
	return observation;
}
/** Register the complete Harness capture boundary against one state owner. */
function registerHarnessAdapter(ctx, state) {
	let assemblies = /* @__PURE__ */ new WeakMap();
	let pendingRequests = /* @__PURE__ */ new WeakMap();
	let attemptsByAgent = /* @__PURE__ */ new WeakMap();
	let disposed = false;
	const logger = ctx.logger("request-flight-recorder");
	const projectionFailed = (stage, error) => {
		state.projectionFailed();
		logger.warn("capture failed at %s: %s", stage, classifyFlightError(error).kind);
	};
	const capture = (options, pending) => {
		const byCoordinate = attemptsByAgent.get(pending.agent) ?? /* @__PURE__ */ new Map();
		attemptsByAgent.set(pending.agent, byCoordinate);
		const coordinate = `${pending.turn}:${pending.step}`;
		const attempt = (byCoordinate.get(coordinate) ?? 0) + 1;
		byCoordinate.set(coordinate, attempt);
		const projected = projectRequest(options);
		const id = RequestAttemptId(randomUUID());
		state.capture({
			schemaVersion: 1,
			id,
			sessionId: pending.sessionId,
			turn: pending.turn,
			step: pending.step,
			attempt,
			startedAt: Date.now(),
			request: projected.summary,
			...pending.promptAssembly === void 0 ? {} : { promptAssembly: pending.promptAssembly },
			evidence: [
				{
					kind: "exact",
					source: "llm/stream"
				},
				{
					kind: "exact",
					source: "agent/request"
				},
				...pending.promptAssembly === void 0 ? [] : [{
					kind: "derived",
					source: "system-prompt/assemble"
				}]
			],
			omissions: pending.promptOmissions === void 0 ? projected.omissions : mergeFlightRecordOmissions(projected.omissions, pending.promptOmissions),
			outcome: { kind: "running" }
		});
		return {
			id,
			startedAt: performance.now()
		};
	};
	ctx.on("system-prompt/assemble", async (assembly, eventContext, next) => {
		const output = await next();
		if (disposed) return output;
		if (eventContext.agent === void 0 || eventContext.signal === void 0) return output;
		try {
			const projected = projectPromptAssembly(output);
			assemblies.set(eventContext.signal, {
				agent: eventContext.agent,
				summary: projected.summary,
				omissions: projected.omissions
			});
		} catch (error) {
			projectionFailed("system-prompt/assemble", error);
		}
		return output;
	});
	ctx.on("agent/request", async (payload, next) => {
		const output = await next();
		if (disposed) return output;
		try {
			const assembly = assemblies.get(payload.signal);
			assemblies.delete(payload.signal);
			pendingRequests.set(payload.signal, {
				agent: payload.agent,
				sessionId: payload.agent.session.id,
				turn: payload.turn,
				step: payload.step,
				...assembly === void 0 || assembly.agent !== payload.agent ? {} : {
					promptAssembly: assembly.summary,
					promptOmissions: assembly.omissions
				}
			});
		} catch (error) {
			projectionFailed("agent/request", error);
		}
		return output;
	});
	ctx.on("llm/stream", (options, next) => {
		if (!isAgentLoopRequest(options)) return next();
		const signal = options.signal;
		if (signal === void 0) {
			state.correlationMiss("missing-signal");
			return next();
		}
		const pending = pendingRequests.get(signal);
		if (pending === void 0) {
			state.correlationMiss("missing-pending");
			return next();
		}
		if (ctx.agents.currentInitiator() !== pending.agent) {
			state.correlationMiss("agent-mismatch");
			return next();
		}
		if (options.sessionId !== pending.sessionId) {
			state.correlationMiss("session-mismatch");
			return next();
		}
		pendingRequests.delete(signal);
		let captureState;
		try {
			captureState = capture(options, pending);
		} catch (error) {
			projectionFailed("llm/stream", error);
			return next();
		}
		let downstream;
		try {
			downstream = next();
		} catch (error) {
			state.settle(captureState.id, {
				kind: "threw",
				error: classifyFlightError(error),
				totalMs: performance.now() - captureState.startedAt
			});
			throw error;
		}
		return observeStream(downstream, (observation) => {
			if (disposed) return;
			const outcome = normalizeFlightObservation(observation);
			if (outcome !== void 0) state.settle(captureState.id, outcome);
		});
	});
	ctx.effect(() => () => {
		disposed = true;
		assemblies = /* @__PURE__ */ new WeakMap();
		pendingRequests = /* @__PURE__ */ new WeakMap();
		attemptsByAgent = /* @__PURE__ */ new WeakMap();
	});
}
//#endregion
//#region src/ring-store.ts
/**
* Bounded in-memory retention for request flight records.
* @module dsh-request-flight-recorder/ring-store
*/
/** Insertion-ordered bounded store with newest-first immutable queries. */
var FlightRingStore = class {
	capacity;
	records = /* @__PURE__ */ new Map();
	order = [];
	/** Number of records currently retained. */
	get size() {
		return this.records.size;
	}
	/**
	* Create a bounded record store.
	* @param capacity - maximum retained records.
	*/
	constructor(capacity) {
		this.capacity = capacity;
		if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new RangeError("capacity must be a positive safe integer");
	}
	/**
	* Retain a new request record.
	* @param record - unique request-attempt record.
	*/
	insert(record) {
		if (this.records.has(record.id)) throw new Error(`request attempt already exists: ${record.id}`);
		this.records.set(record.id, deepFreeze(record));
		this.order.push(record.id);
		if (this.order.length <= this.capacity) return void 0;
		const evictedId = this.order.shift();
		const evicted = this.records.get(evictedId);
		this.records.delete(evictedId);
		return evicted;
	}
	/**
	* Replace one retained record without changing recency order.
	* @param id - retained request-attempt identity.
	* @param update - pure replacement callback.
	*/
	update(id, update) {
		const current = this.records.get(id);
		if (current === void 0) return;
		this.records.set(id, deepFreeze(update(current)));
	}
	/**
	* List retained records from newest to oldest.
	* @param query - optional session filter.
	* @returns a frozen detached array of immutable records.
	*/
	list(query = {}) {
		if (query.limit !== void 0 && (!Number.isSafeInteger(query.limit) || query.limit <= 0)) throw new RangeError("limit must be a positive safe integer");
		const result = [];
		for (let index = this.order.length - 1; index >= 0; index -= 1) {
			const id = this.order[index];
			const record = this.records.get(id);
			if (query.sessionId !== void 0 && record.sessionId !== query.sessionId) continue;
			if (query.turn !== void 0 && record.turn !== query.turn) continue;
			if (query.step !== void 0 && record.step !== query.step) continue;
			if (query.provider !== void 0 && record.request.provider !== query.provider) continue;
			if (query.model !== void 0 && record.request.model !== query.model) continue;
			if (query.outcome !== void 0 && record.outcome.kind !== query.outcome) continue;
			result.push(record);
			if (query.limit !== void 0 && result.length >= query.limit) break;
		}
		return Object.freeze(result);
	}
	/**
	* Read one retained record.
	* @param id - request-attempt identity.
	* @returns the immutable record when retained.
	*/
	get(id) {
		return this.records.get(id);
	}
	/**
	* Read the newest retained record.
	* @param sessionId - optional session filter.
	* @returns the newest matching immutable record.
	*/
	latest(sessionId) {
		return this.list(sessionId === void 0 ? {} : { sessionId })[0];
	}
	/** Remove every retained record. */
	clear() {
		this.records.clear();
		this.order.length = 0;
	}
};
//#endregion
//#region src/subscriptions.ts
/**
* Coalesced out-of-stack invalidation for optional live-view consumers.
* @module dsh-request-flight-recorder/subscriptions
*/
/** Process-local coalescing coordinator owned by one recorder lifetime. */
var FlightSubscriptions = class {
	onFailure;
	listeners = /* @__PURE__ */ new Set();
	constructor(onFailure = () => {}) {
		this.onFailure = onFailure;
	}
	subscribe(listener) {
		const state = {
			listener,
			active: true,
			scheduled: false,
			running: false,
			dirty: false,
			latestRevision: 0
		};
		this.listeners.add(state);
		return () => {
			if (!state.active) return;
			state.active = false;
			this.listeners.delete(state);
		};
	}
	publish(revision) {
		for (const state of this.listeners) {
			state.latestRevision = revision;
			if (state.running) {
				state.dirty = true;
				continue;
			}
			if (state.scheduled) continue;
			this.schedule(state);
		}
	}
	clear() {
		for (const state of this.listeners) state.active = false;
		this.listeners.clear();
	}
	schedule(state) {
		state.scheduled = true;
		setImmediate(() => {
			this.deliver(state);
		});
	}
	async deliver(state) {
		state.scheduled = false;
		if (!state.active) return;
		state.running = true;
		state.dirty = false;
		try {
			await state.listener(deepFreeze({ revision: state.latestRevision }));
		} catch (error) {
			try {
				this.onFailure(error);
			} catch {}
		} finally {
			state.running = false;
			if (state.active && state.dirty) this.schedule(state);
		}
	}
};
//#endregion
//#region src/recorder-state.ts
/**
* Transactional process-local state for request flight records.
* @module dsh-request-flight-recorder/recorder-state
*/
const RECORDER_INFO = deepFreeze({
	protocolVersion: 1,
	recordSchemaVersion: 1,
	capabilities: [
		"diff",
		"health",
		"query",
		"snapshot",
		"subscribe"
	]
});
function emptyCorrelationMissesByReason() {
	return {
		"missing-signal": 0,
		"missing-pending": 0,
		"agent-mismatch": 0,
		"session-mismatch": 0
	};
}
/** Internal transaction owner behind the stable read-only service. */
var FlightRecorderState = class {
	store;
	subscriptions;
	activeIds = /* @__PURE__ */ new Set();
	captured = 0;
	completed = 0;
	evicted = 0;
	truncatedRecords = 0;
	correlationMisses = 0;
	correlationMissesByReason = emptyCorrelationMissesByReason();
	projectionFailures = 0;
	subscriberFailures = 0;
	revision = 0;
	disposed = false;
	constructor(capacity) {
		this.store = new FlightRingStore(capacity);
		this.subscriptions = new FlightSubscriptions(() => {
			this.subscriberFailures += 1;
		});
	}
	info() {
		return RECORDER_INFO;
	}
	snapshot(query) {
		return deepFreeze({
			info: this.info(),
			revision: this.revision,
			health: this.health(),
			records: this.store.list(query)
		});
	}
	subscribe(listener) {
		return this.subscriptions.subscribe(listener);
	}
	list(query) {
		return this.store.list(query);
	}
	get(id) {
		return this.store.get(id);
	}
	latest(sessionId) {
		return this.store.latest(sessionId);
	}
	diff(fromId, toId) {
		const from = this.store.get(fromId);
		const to = this.store.get(toId);
		if (from === void 0 || to === void 0) return deepFreeze({
			kind: "missing",
			ids: [...from === void 0 ? [fromId] : [], ...to === void 0 ? [toId] : []]
		});
		return deepFreeze({
			kind: "ok",
			diff: diffFlightRecords(from, to)
		});
	}
	health() {
		return Object.freeze({
			captured: this.captured,
			completed: this.completed,
			active: this.activeIds.size,
			retained: this.store.size,
			evicted: this.evicted,
			truncatedRecords: this.truncatedRecords,
			correlationMisses: this.correlationMisses,
			correlationMissesByReason: Object.freeze({ ...this.correlationMissesByReason }),
			projectionFailures: this.projectionFailures,
			subscriberFailures: this.subscriberFailures
		});
	}
	capture(record) {
		if (this.disposed) return;
		if (record.outcome.kind !== "running") throw new Error("captured record must be running");
		const evicted = this.store.insert(record);
		this.captured += 1;
		this.activeIds.add(record.id);
		if (evicted !== void 0) this.evicted += 1;
		if (hasFlightRecordOmissions(record.omissions)) this.truncatedRecords += 1;
		this.change();
	}
	settle(id, outcome) {
		if (this.disposed || !this.activeIds.delete(id)) return false;
		this.completed += 1;
		this.store.update(id, (record) => ({
			...record,
			outcome
		}));
		this.change();
		return true;
	}
	correlationMiss(reason) {
		if (this.disposed) return;
		this.correlationMisses += 1;
		this.correlationMissesByReason[reason] += 1;
		this.change();
	}
	projectionFailed() {
		if (this.disposed) return;
		this.projectionFailures += 1;
		this.change();
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.store.clear();
		this.activeIds.clear();
		this.subscriptions.clear();
		this.captured = 0;
		this.completed = 0;
		this.evicted = 0;
		this.truncatedRecords = 0;
		this.correlationMisses = 0;
		this.correlationMissesByReason = emptyCorrelationMissesByReason();
		this.projectionFailures = 0;
		this.subscriberFailures = 0;
		this.revision = 0;
	}
	change() {
		this.revision = Math.min(Number.MAX_SAFE_INTEGER, this.revision + 1);
		this.subscriptions.publish(this.revision);
	}
};
//#endregion
//#region src/index.ts
/**
* DeepSeek Harness request flight recorder service.
* @module dsh-request-flight-recorder
*/
/** Content-free recorder for loop-built model requests and stream outcomes. */
var RequestFlightRecorder = class extends Service {
	static inject = [
		"llm",
		"agents",
		"systemPrompt"
	];
	static Config = z.object({
		capacity: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(128),
		slowFirstChunkMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1e3),
		slowTotalMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2e3)
	});
	state;
	/**
	* Register the recorder service and its effect-owned waterfall listeners.
	* @param ctx - Cordis context carrying the required DSH services.
	* @param config - validated bounded-retention configuration.
	*/
	constructor(ctx, config) {
		super(ctx, "requestFlightRecorder");
		this.state = new FlightRecorderState(config.capacity);
		ctx.effect(() => () => {
			this.state.dispose();
		});
		registerHarnessAdapter(ctx, this.state);
		ctx.inject(["commands"], (commandCtx) => {
			registerFlightCommand(commandCtx, this, {
				startupLocale: readFlightLocale(commandCtx),
				currentLocale: () => readFlightLocale(commandCtx),
				thresholds: {
					slowFirstChunkMs: config.slowFirstChunkMs,
					slowTotalMs: config.slowTotalMs
				}
			});
		});
	}
	/** Return the stable protocol, schema, and capability handshake. */
	info() {
		return this.state.info();
	}
	/** Read one deeply frozen atomic view of recorder state. */
	snapshot(query) {
		return this.state.snapshot(query);
	}
	/** Subscribe to coalesced out-of-stack recorder invalidations. */
	subscribe(listener) {
		return this.state.subscribe(listener);
	}
	/**
	* List retained records from newest to oldest.
	* @param query - optional record filters.
	* @returns a frozen detached array of immutable records.
	*/
	list(query) {
		return this.state.list(query);
	}
	/**
	* Read one retained request attempt.
	* @param id - request-attempt identity.
	* @returns the immutable record when it remains retained.
	*/
	get(id) {
		return this.state.get(id);
	}
	/**
	* Read the newest retained request attempt.
	* @param sessionId - optional session filter.
	* @returns the newest matching immutable record.
	*/
	latest(sessionId) {
		return this.state.latest(sessionId);
	}
	/**
	* Compare two retained attempts without exceptional missing-id control flow.
	* @param fromId - earlier retained request-attempt identity.
	* @param toId - later retained request-attempt identity.
	* @returns a frozen structural diff or exact missing identities.
	*/
	diff(fromId, toId) {
		return this.state.diff(fromId, toId);
	}
	/**
	* Read a fresh process-local health snapshot.
	* @returns frozen capture, settlement, retention, and failure counters.
	*/
	health() {
		return this.state.health();
	}
};
//#endregion
export { FLIGHT_LIMITS, FLIGHT_RECORDER_PROTOCOL_VERSION, FLIGHT_RECORD_SCHEMA_VERSION, RequestAttemptId, RequestFlightRecorder as default };
