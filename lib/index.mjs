import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Service } from "@deepseek-ai/cordis";
import { deepFreeze, isAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
//#region src/format.ts
/** Maximum command-result text retained by the official command lifecycle. */
const MAX_COMMAND_OUTPUT = 4096;
const TRUNCATION_MARKER = "\n… output truncated";
function shortId(id) {
	return id.slice(0, 8);
}
function plural(count, noun) {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
function list(values) {
	return values.length === 0 ? "-" : values.join(", ");
}
function outcome(record) {
	const value = record.outcome;
	if (value.kind === "running") return "outcome running";
	const timing = [
		value.firstChunkMs === void 0 ? void 0 : `ttft ${value.firstChunkMs}ms`,
		`total ${value.totalMs}ms`,
		value.usage === void 0 ? void 0 : `tokens ${value.usage.inputTokens} in / ${value.usage.outputTokens} out`
	].filter((part) => part !== void 0);
	return `outcome ${value.kind === "finished" ? `finished:${value.finish.kind}` : value.kind === "threw" ? `threw:${value.error.kind}` : `incomplete:${value.reason}`} · ${timing.join(" · ")}`;
}
/**
* Render one retained request attempt.
* @param record - immutable structural request record.
* @returns concise plain text with no ANSI sequences.
*/
function formatRecord(record) {
	const prompt = record.promptAssembly;
	return [
		`flight ${shortId(record.id)}`,
		`turn ${record.turn} · step ${record.step} · attempt ${record.attempt}`,
		`model ${record.request.provider}/${record.request.model}`,
		`request ${plural(record.request.messages.total, "message")} · ${record.request.systemCharacters} system chars · ${plural(record.request.tools.length, "tool")}`,
		`tools ${list(record.request.tools.map((tool) => `${tool.name}(${tool.parameterNodes})`))}`,
		`prompt sections ${list(prompt?.sections.map((item) => item.name) ?? [])} · contexts ${list(prompt?.contexts.map((item) => item.name) ?? [])} · variables ${list(prompt?.variables ?? [])}`,
		outcome(record)
	].join("\n");
}
/**
* Render compact rows for retained request attempts.
* @param records - immutable records already scoped to the invoking Session.
* @returns plain text containing only identity, coordinates, model, and outcome.
*/
function formatRecordList(records) {
	return ["flight list", ...records.map((record) => `${shortId(record.id)} · turn ${record.turn} · step ${record.step} · attempt ${record.attempt} · ${record.request.provider}/${record.request.model} · ${record.outcome.kind}`)].join("\n");
}
/**
* Render process-local recorder health without Session detail.
* @param health - immutable health snapshot.
* @returns concise aggregate plain text.
*/
function formatHealth(health) {
	return [
		"flight health",
		`captured ${health.captured} · completed ${health.completed} · active ${health.active}`,
		`retained ${health.retained} · evicted ${health.evicted}`,
		`truncated records ${health.truncatedRecords} · projection failures ${health.projectionFailures} · subscriber failures ${health.subscriberFailures}`,
		`correlation misses ${health.correlationMisses}`,
		`missing-signal ${health.correlationMissesByReason["missing-signal"]} · missing-pending ${health.correlationMissesByReason["missing-pending"]}`,
		`agent-mismatch ${health.correlationMissesByReason["agent-mismatch"]} · session-mismatch ${health.correlationMissesByReason["session-mismatch"]}`
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
function formatNamed(change) {
	return `${change.field} ${change.name}: ${change.change} (${scalar(change.beforeSize)} → ${scalar(change.afterSize)})`;
}
function formatChange(change) {
	if (change.kind === "value") return formatValue(change);
	if (change.kind === "counter") return formatCounter(change);
	return formatNamed(change);
}
/**
* Render a deterministic record diff.
* @param diff - immutable structural diff.
* @returns plain-text change list.
*/
function formatDiff(diff) {
	return [`flight diff ${shortId(diff.fromId)} → ${shortId(diff.toId)}`, ...diff.changed ? diff.changes.map(formatChange) : ["no structural changes"]].join("\n");
}
/**
* Bound command text without cutting a UTF-16 surrogate pair.
* @param text - complete command-result text.
* @param max - maximum UTF-16 code units including the marker.
* @returns unchanged or safely truncated text.
*/
function boundCommandText(text, max = MAX_COMMAND_OUTPUT) {
	if (!Number.isSafeInteger(max) || max <= 19) throw new RangeError("max must fit the truncation marker");
	if (text.length <= max) return text;
	let end = max - 19;
	const finalCodeUnit = text.charCodeAt(end - 1);
	if (finalCodeUnit >= 55296 && finalCodeUnit <= 56319) end -= 1;
	return text.slice(0, end) + TRUNCATION_MARKER;
}
//#endregion
//#region src/command.ts
const USAGE = "usage: /flight [latest|list [limit]|show <id>|diff [from] [to]|health]";
function error(text) {
	return {
		kind: "error",
		text
	};
}
function success(text) {
	return {
		kind: "success",
		text: boundCommandText(text)
	};
}
function resolvePrefix(records, prefix) {
	const matches = records.filter((record) => record.id.startsWith(prefix));
	if (matches.length === 0) return error(`request id prefix "${prefix}" was not found in this Session`);
	if (matches.length > 1) return error(`request id prefix "${prefix}" is ambiguous in this Session`);
	return matches[0];
}
function isCommandResult(value) {
	return "kind" in value;
}
function latest(recorder, sessionId) {
	const record = recorder.latest(sessionId);
	return record === void 0 ? error("no retained flight records for this Session") : success(formatRecord(record));
}
function listRecords(recorder, sessionId, limit) {
	const records = recorder.list({
		sessionId,
		limit
	});
	return records.length === 0 ? error("no retained flight records for this Session") : success(formatRecordList(records));
}
function show(recorder, sessionId, prefix) {
	const record = resolvePrefix(recorder.list({ sessionId }), prefix);
	return isCommandResult(record) ? record : success(formatRecord(record));
}
function renderDiff(recorder, from, to) {
	const result = recorder.diff(from.id, to.id);
	if (result.kind === "missing") return error("one or more request records were evicted before diff completed");
	return success(formatDiff(result.diff));
}
function implicitDiff(recorder, sessionId) {
	const records = recorder.list({
		sessionId,
		limit: 2
	});
	if (records.length < 2) return error("diff requires at least two retained flight records for this Session");
	return renderDiff(recorder, records[1], records[0]);
}
function explicitDiff(recorder, sessionId, fromPrefix, toPrefix) {
	const records = recorder.list({ sessionId });
	const from = resolvePrefix(records, fromPrefix);
	if (isCommandResult(from)) return from;
	const to = resolvePrefix(records, toPrefix);
	if (isCommandResult(to)) return to;
	return renderDiff(recorder, from, to);
}
function execute(recorder, sessionId, rawInput) {
	const input = rawInput.trim();
	if (input === "") return latest(recorder, sessionId);
	const [command, ...args] = input.split(/\s+/u);
	if (command === "latest" && args.length === 0) return latest(recorder, sessionId);
	if (command === "list" && args.length === 0) return listRecords(recorder, sessionId, 10);
	if (command === "list" && args.length === 1) {
		const limit = Number(args[0]);
		if (Number.isSafeInteger(limit) && limit >= 1 && limit <= 20) return listRecords(recorder, sessionId, limit);
		return error(USAGE);
	}
	if (command === "health" && args.length === 0) return success(formatHealth(recorder.health()));
	if (command === "show" && args.length === 1) return show(recorder, sessionId, args[0]);
	if (command === "diff" && args.length === 0) return implicitDiff(recorder, sessionId);
	if (command === "diff" && args.length === 2) return explicitDiff(recorder, sessionId, args[0], args[1]);
	return error(USAGE);
}
/**
* Register `/flight` through the official human-command registry.
* @param ctx - optional command-injected Cordis child context.
* @param recorder - read-only flight diagnostics service.
*/
function registerFlightCommand(ctx, recorder) {
	ctx.commands.register({
		name: "flight",
		description: "Inspect content-free model request diagnostics",
		input: { hint: "[latest|list [limit]|show <id>|diff [from] [to]|health]" },
		recordInput: false,
		handler: ({ agent, rawInput }) => execute(recorder, agent.session.id, rawInput)
	});
}
//#endregion
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
//#region src/harness-adapter.ts
/** Register transparent official Harness listeners for recorder-owned handlers. */
function registerHarnessAdapter(ctx, handlers) {
	ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
		const result = await next();
		if (context.signal === void 0 || context.agent === void 0) return result;
		try {
			handlers.assembled({
				assembly: result,
				agent: context.agent,
				signal: context.signal
			});
		} catch (error) {
			handlers.projectionFailed("system-prompt/assemble", error);
		}
		return result;
	});
	ctx.on("agent/request", async (payload, next) => {
		const result = await next();
		try {
			handlers.requested({
				agent: payload.agent,
				sessionId: payload.agent.session.id,
				turn: payload.turn,
				step: payload.step,
				signal: payload.signal
			});
		} catch (error) {
			handlers.projectionFailed("agent/request", error);
		}
		return result;
	});
	ctx.on("llm/stream", (options, next) => {
		if (!isAgentLoopRequest(options)) return next();
		return handlers.streaming({
			options,
			initiator: ctx.agents.currentInitiator(),
			next
		});
	});
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
//#region src/index.ts
/**
* DeepSeek Harness request flight recorder service.
* @module dsh-request-flight-recorder
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
/** Content-free recorder for loop-built model requests and stream outcomes. */
var RequestFlightRecorder = class extends Service {
	static inject = [
		"llm",
		"agents",
		"systemPrompt"
	];
	static Config = z.object({ capacity: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(128) });
	store;
	promptBySignal = /* @__PURE__ */ new WeakMap();
	pendingBySignal = /* @__PURE__ */ new WeakMap();
	attemptsByAgent = /* @__PURE__ */ new WeakMap();
	activeIds = /* @__PURE__ */ new Set();
	subscriptions;
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
	/**
	* Register the recorder service and its effect-owned waterfall listeners.
	* @param ctx - Cordis context carrying the required DSH services.
	* @param config - validated bounded-retention configuration.
	*/
	constructor(ctx, config) {
		super(ctx, "requestFlightRecorder");
		this.store = new FlightRingStore(config.capacity);
		this.subscriptions = new FlightSubscriptions(() => {
			this.subscriberFailures += 1;
		});
		registerHarnessAdapter(ctx, {
			assembled: ({ assembly, agent, signal }) => {
				if (this.disposed) return;
				const projection = projectPromptAssembly(assembly);
				this.promptBySignal.set(signal, {
					agent,
					summary: projection.summary,
					omissions: projection.omissions
				});
			},
			requested: ({ agent, sessionId, turn, step, signal }) => {
				if (this.disposed) return;
				const assembly = this.promptBySignal.get(signal);
				this.promptBySignal.delete(signal);
				this.pendingBySignal.set(signal, {
					agent,
					sessionId,
					turn,
					step,
					...assembly?.agent === agent ? {
						promptAssembly: assembly.summary,
						promptOmissions: assembly.omissions
					} : {}
				});
			},
			streaming: ({ options, initiator, next }) => {
				if (options.signal === void 0) {
					this.miss("missing-signal");
					return next();
				}
				const pending = this.pendingBySignal.get(options.signal);
				if (pending === void 0) {
					this.miss("missing-pending");
					return next();
				}
				if (initiator !== pending.agent) {
					this.miss("agent-mismatch");
					return next();
				}
				if (options.sessionId !== pending.sessionId) {
					this.miss("session-mismatch");
					return next();
				}
				this.pendingBySignal.delete(options.signal);
				let id;
				let startedAt;
				try {
					startedAt = performance.now();
					id = this.beginRecord(options, pending);
				} catch (error) {
					this.projectionFailures += 1;
					this.change();
					this.warnCaptureFailure("llm/stream", error);
					return next();
				}
				let stream;
				try {
					stream = next();
				} catch (error) {
					this.finishRecord(id, {
						kind: "threw",
						error: classifyFlightError(error),
						totalMs: performance.now() - startedAt
					});
					throw error;
				}
				return observeStream(stream, (observation) => {
					if (this.disposed) return;
					this.applyObservation(id, observation);
				});
			},
			projectionFailed: (stage, error) => {
				this.projectionFailures += 1;
				this.change();
				this.warnCaptureFailure(stage, error);
			}
		});
		ctx.inject(["commands"], (commandCtx) => {
			registerFlightCommand(commandCtx, this);
		});
		ctx.effect(() => () => {
			this.disposed = true;
			this.store.clear();
			this.promptBySignal = /* @__PURE__ */ new WeakMap();
			this.pendingBySignal = /* @__PURE__ */ new WeakMap();
			this.attemptsByAgent = /* @__PURE__ */ new WeakMap();
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
		});
	}
	/** Return the stable protocol, schema, and capability handshake. */
	info() {
		return RECORDER_INFO;
	}
	/** Read one deeply frozen atomic view of recorder state. */
	snapshot(query) {
		return deepFreeze({
			info: this.info(),
			revision: this.revision,
			health: this.health(),
			records: this.store.list(query)
		});
	}
	/** Subscribe to coalesced out-of-stack recorder invalidations. */
	subscribe(listener) {
		return this.subscriptions.subscribe(listener);
	}
	/**
	* List retained records from newest to oldest.
	* @param query - optional session filter.
	* @returns a frozen detached array of immutable records.
	*/
	list(query) {
		return this.store.list(query);
	}
	/**
	* Read one retained request attempt.
	* @param id - request-attempt identity.
	* @returns the immutable record when it remains retained.
	*/
	get(id) {
		return this.store.get(id);
	}
	/**
	* Read the newest retained request attempt.
	* @param sessionId - optional session filter.
	* @returns the newest matching immutable record.
	*/
	latest(sessionId) {
		return this.store.latest(sessionId);
	}
	/**
	* Compare two retained attempts without exceptional missing-id control flow.
	* @param fromId - earlier retained request-attempt identity.
	* @param toId - later retained request-attempt identity.
	* @returns a frozen structural diff or exact missing identities.
	*/
	diff(fromId, toId) {
		const from = this.store.get(fromId);
		const to = this.store.get(toId);
		if (from === void 0 || to === void 0) {
			const missing = [...from === void 0 ? [fromId] : [], ...to === void 0 ? [toId] : []];
			return deepFreeze({
				kind: "missing",
				ids: missing
			});
		}
		return deepFreeze({
			kind: "ok",
			diff: diffFlightRecords(from, to)
		});
	}
	/**
	* Read a fresh process-local health snapshot.
	* @returns frozen capture, settlement, retention, and failure counters.
	*/
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
	beginRecord(options, pending) {
		const attempts = this.attemptsByAgent.get(pending.agent) ?? /* @__PURE__ */ new Map();
		if (!this.attemptsByAgent.has(pending.agent)) this.attemptsByAgent.set(pending.agent, attempts);
		const coordinate = `${pending.turn}:${pending.step}`;
		const attempt = (attempts.get(coordinate) ?? 0) + 1;
		attempts.set(coordinate, attempt);
		const id = RequestAttemptId(randomUUID());
		const request = projectRequest(options);
		const omissions = pending.promptOmissions === void 0 ? request.omissions : mergeFlightRecordOmissions(request.omissions, pending.promptOmissions);
		const evicted = this.store.insert({
			schemaVersion: 1,
			id,
			sessionId: pending.sessionId,
			turn: pending.turn,
			step: pending.step,
			attempt,
			startedAt: Date.now(),
			request: request.summary,
			...pending.promptAssembly === void 0 ? {} : { promptAssembly: pending.promptAssembly },
			outcome: { kind: "running" },
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
			omissions
		});
		this.captured += 1;
		if (hasFlightRecordOmissions(omissions)) this.truncatedRecords += 1;
		this.activeIds.add(id);
		if (evicted !== void 0) this.evicted += 1;
		this.change();
		return id;
	}
	miss(reason) {
		this.correlationMisses += 1;
		this.correlationMissesByReason[reason] += 1;
		this.change();
	}
	applyObservation(id, observation) {
		if (observation.kind === "first-chunk" || observation.kind === "usage") return;
		if (observation.kind === "threw") {
			this.finishRecord(id, {
				...observation,
				error: classifyFlightError(observation.error)
			});
			return;
		}
		this.finishRecord(id, observation);
	}
	finishRecord(id, outcome) {
		if (!this.activeIds.delete(id)) return;
		this.completed += 1;
		this.store.update(id, (record) => ({
			...record,
			outcome
		}));
		this.change();
	}
	change() {
		if (this.revision < Number.MAX_SAFE_INTEGER) this.revision += 1;
		this.subscriptions.publish(this.revision);
	}
	warnCaptureFailure(stage, error) {
		this.ctx.logger("request-flight-recorder").warn("capture failed at %s: %s", stage, classifyFlightError(error).kind);
	}
};
//#endregion
export { FLIGHT_LIMITS, FLIGHT_RECORDER_PROTOCOL_VERSION, FLIGHT_RECORD_SCHEMA_VERSION, RequestAttemptId, RequestFlightRecorder as default };
