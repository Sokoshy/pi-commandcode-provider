/**
 * Modified in 2026 by Sokoshy: added the mocked routing and generate-transport
 * suite. Originally Copyright 2026 Command Code, Apache License 2.0 — see the
 * LICENSE and NOTICE files.
 *
 * Deterministic model-mapping, Go-fallback routing and generate-transport
 * tests, plus an optional live check against the Command Code API.
 *
 *   bun test.ts                                       # deterministic tests
 *   bun test.ts --live                                # list the live catalog
 *   CMD_API_KEY=... bun test.ts --live                # one model per API
 *   CMD_API_KEY=... bun test.ts --live claude-sonnet-5
 *   CMD_API_KEY=... bun test.ts --live --all
 *   CMD_API_KEY=... bun test.ts --live --reasoning high claude-sonnet-5
 *
 * With no CMD_API_KEY set, it prints the routing table, which shows what the
 * live /models endpoint serves.
 *
 * No deterministic test below needs a real key: provider and generate HTTP
 * traffic is mocked. Never print an API key in test output.
 */

import assert from "node:assert/strict";
import {
	calculateCost,
	createAssistantMessageEventStream,
	createModels,
	normalizeContext,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type ThinkingLevel,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { commandCodeProvider, loadModels } from "./index.ts";
import { createCommandCodeTransportRouter } from "./src/go-router.ts";
import { createGoGenerateStream } from "./src/go-generate.ts";
import {
	mapFinishReason,
	messagesToCC,
	parseStreamEventLine,
	systemPromptToText,
	toolsToJson,
} from "./src/go-converters.ts";
import { redactCommandCodeErrorText } from "./src/go-overflow.ts";

const DEFAULT_IDS = ["claude-sonnet-5", "gpt-5.6-luna", "moonshotai/Kimi-K3"];

const WEATHER_TOOL = {
	name: "get_weather",
	description: "Get the current weather for a city.",
	parameters: {
		type: "object" as const,
		properties: { city: { type: "string" as const, description: "City name" } },
		required: ["city"],
		additionalProperties: false,
	},
};

async function testModelMapping(): Promise<void> {
	const fixture = {
		data: [
			{ id: "claude-opus-5", supported_endpoints: ["/messages"], context_length: 200_000 },
			{ id: "gpt-test", supported_endpoints: ["/chat/completions", "/responses"] },
			{ id: "vendor/new-model", supported_endpoints: ["/chat/completions", "/responses"] },
			{
				id: "vendor/capable-model",
				supported_endpoints: ["/chat/completions"],
				reasoning: true,
				modalities: { input: ["text", "image"] },
				max_output_tokens: 8_192,
			},
			{ id: "vendor/unsupported", supported_endpoints: ["/unknown"] },
		],
	};
	const url = `data:application/json,${encodeURIComponent(JSON.stringify(fixture))}`;
	const models = await loadModels(url);

	assert.equal(models.length, 4);
	assert.deepEqual(
		models.map(({ id, api, reasoning, input }) => ({ id, api, reasoning, input })),
		[
			{ id: "claude-opus-5", api: "anthropic-messages", reasoning: true, input: ["text", "image"] },
			{ id: "gpt-test", api: "openai-responses", reasoning: true, input: ["text", "image"] },
			{ id: "vendor/new-model", api: "openai-completions", reasoning: true, input: ["text"] },
			{
				id: "vendor/capable-model",
				api: "openai-completions",
				reasoning: true,
				input: ["text", "image"],
			},
		],
	);
	assert.equal(models[0]?.contextWindow, 200_000);
	assert.equal(models[3]?.maxTokens, 8_192);
	assert.deepEqual(models[0]?.compat, { forceAdaptiveThinking: true });
	assert.deepEqual(models[2]?.compat, { supportsDeveloperRole: false, maxTokensField: "max_tokens" });
}

// ---------------------------------------------------------------------------
// Go-fallback test helpers (all mocked, no network, no real key)
// ---------------------------------------------------------------------------

const TEST_KEY_A = "user_testkey_alpha_001";
const TEST_KEY_B = "user_testkey_beta_002";

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "moonshotai/Kimi-K3",
		name: "Kimi K3",
		api: "openai-completions",
		provider: "command-code",
		baseUrl: "https://api.commandcode.ai/provider/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 32_768,
		...overrides,
	};
}

function makeContext(
	messages: { role: "user"; content: string }[] = [{ role: "user", content: "Hello" }],
): TranscriptContext {
	return normalizeContext({
		systemPrompt: "You are helpful.",
		messages: messages.map((message) => ({ ...message, timestamp: Date.now() })),
		tools: [],
	});
}

function makeAssistant(model: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function providerTextEvents(model: Model<Api>, text: string): AssistantMessageEvent[] {
	const message = makeAssistant(model, text);
	return [
		{ type: "start", partial: message },
		{ type: "text_start", contentIndex: 0, partial: message },
		{ type: "text_delta", contentIndex: 0, delta: text, partial: message },
		{ type: "text_end", contentIndex: 0, content: text, partial: message },
		{ type: "done", reason: "stop", message },
	];
}

function providerErrorEvents(model: Model<Api>, errorMessage: string): AssistantMessageEvent[] {
	const error: AssistantMessage = {
		...makeAssistant(model, ""),
		content: [],
		stopReason: "error",
		errorMessage,
	};
	return [{ type: "error", reason: "error", error }];
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function eventTypes(events: AssistantMessageEvent[]): string[] {
	return events.map((event) => event.type);
}

function upgradeRequiredResponse(): Response {
	return new Response(
		JSON.stringify({ error: { code: "upgrade_required", message: "Go plan has no API access" } }),
		{ status: 403, headers: { "content-type": "application/json" } },
	);
}

function deniedResponse(): Response {
	return new Response(
		JSON.stringify({ error: { code: "permission_denied", message: "Nope" } }),
		{ status: 403, headers: { "content-type": "application/json" } },
	);
}

function okResponse(): Response {
	return new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function sseResponse(lines: string[]): Response {
	return new Response(`${lines.join("\n")}\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** Fake native Provider API stream that honors the injected fetch wrapper. */
function fakeProvider(
	eventsFor: (model: Model<Api>) => AssistantMessageEvent[],
	calls: { provider: number },
) {
	return (
		model: Model<Api>,
		_context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		(async () => {
			calls.provider += 1;
			await (options?.fetch ?? fetch)("https://api.commandcode.ai/provider/v1/chat/completions", {
				method: "POST",
			});
			await options?.onResponse?.({ status: 200, headers: {} }, model);
			for (const event of eventsFor(model)) stream.push(event);
			stream.end();
		})().catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			const [failure] = providerErrorEvents(model, message);
			if (failure) stream.push(failure);
			stream.end();
		});
		return stream;
	};
}

function fakeGenerate(text: string, calls: { generate: number }) {
	return (
		model: Model<Api>,
		_context: TranscriptContext,
		_options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		(async () => {
			calls.generate += 1;
			for (const event of providerTextEvents(model, text)) stream.push(event);
			stream.end();
		})();
		return stream;
	};
}

function finishLine(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "finish",
		finishReason: "stop",
		totalUsage: {
			inputTokens: 100,
			outputTokens: 10,
			inputTokenDetails: { noCacheTokens: 20, cacheReadTokens: 70, cacheWriteTokens: 10 },
		},
		...overrides,
	});
}

// ---------------------------------------------------------------------------
// Router tests
// ---------------------------------------------------------------------------

async function testRouterProviderAccepted(): Promise<void> {
	const calls = { provider: 0, generate: 0 };
	const router = createCommandCodeTransportRouter({
		createStream: () => createAssistantMessageEventStream(),
		streamProvider: fakeProvider((model) => providerTextEvents(model, "via-provider"), calls),
		streamGenerate: fakeGenerate("via-generate", calls),
	});
	const model = makeModel();
	const events = await collect(
		router.stream(model, makeContext(), { apiKey: TEST_KEY_A, fetch: async () => okResponse() }),
	);
	assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "text_end", "done"]);
	assert.equal(router.getTransport(), "provider");
	assert.equal(calls.provider, 1);
	assert.equal(calls.generate, 0);
	const [done] = events.slice(-1);
	assert.equal(done?.type, "done");
	if (done?.type === "done") {
		const [block] = done.message.content;
		assert.equal(block?.type, "text");
		if (block?.type === "text") assert.equal(block.text, "via-provider");
	}
}

async function testRouterUpgradeRequiredFallsBack(): Promise<void> {
	const calls = { provider: 0, generate: 0 };
	const router = createCommandCodeTransportRouter({
		createStream: () => createAssistantMessageEventStream(),
		streamProvider: fakeProvider((model) => providerTextEvents(model, "via-provider"), calls),
		streamGenerate: fakeGenerate("via-generate", calls),
	});
	const model = makeModel();
	const events = await collect(
		router.stream(model, makeContext(), {
			apiKey: TEST_KEY_A,
			fetch: async () => upgradeRequiredResponse(),
		}),
	);
	assert.equal(router.getTransport(), "generate");
	assert.equal(calls.provider, 1);
	assert.equal(calls.generate, 1);
	const [done] = events.slice(-1);
	assert.equal(done?.type, "done");
	if (done?.type === "done") {
		const [block] = done.message.content;
		if (block?.type === "text") assert.equal(block.text, "via-generate");
		else assert.fail("expected generate text");
	}
}

async function testRouterOther403DoesNotFallBack(): Promise<void> {
	const calls = { provider: 0, generate: 0 };
	const router = createCommandCodeTransportRouter({
		createStream: () => createAssistantMessageEventStream(),
		streamProvider: fakeProvider((model) => providerErrorEvents(model, "denied"), calls),
		streamGenerate: fakeGenerate("via-generate", calls),
	});
	const model = makeModel();
	const events = await collect(
		router.stream(model, makeContext(), {
			apiKey: TEST_KEY_A,
			fetch: async () => deniedResponse(),
		}),
	);
	assert.equal(router.getTransport(), "provider");
	assert.equal(calls.generate, 0);
	assert.equal(events.at(-1)?.type, "error");
}

async function testRouterReusesSelectedTransport(): Promise<void> {
	const calls = { provider: 0, generate: 0 };
	const router = createCommandCodeTransportRouter({
		createStream: () => createAssistantMessageEventStream(),
		streamProvider: fakeProvider((model) => providerTextEvents(model, "via-provider"), calls),
		streamGenerate: fakeGenerate("via-generate", calls),
	});
	const model = makeModel();
	const fetchImpl = async () => upgradeRequiredResponse();
	const options = { apiKey: TEST_KEY_A, fetch: fetchImpl };
	await collect(router.stream(model, makeContext(), options));
	await collect(router.stream(model, makeContext(), options));
	assert.equal(router.getTransport(), "generate");
	assert.equal(calls.provider, 1);
	assert.equal(calls.generate, 2);
}

async function testRouterKeyChangeResets(): Promise<void> {
	const calls = { provider: 0, generate: 0 };
	let goKey = true;
	const router = createCommandCodeTransportRouter({
		createStream: () => createAssistantMessageEventStream(),
		streamProvider: fakeProvider((model) => providerTextEvents(model, "via-provider"), calls),
		streamGenerate: fakeGenerate("via-generate", calls),
	});
	const model = makeModel();
	await collect(
		router.stream(model, makeContext(), {
			apiKey: TEST_KEY_A,
			fetch: async () => upgradeRequiredResponse(),
		}),
	);
	assert.equal(router.getTransport(), "generate");
	goKey = false;
	await collect(
		router.stream(model, makeContext(), {
			apiKey: TEST_KEY_B,
			fetch: async () => (goKey ? upgradeRequiredResponse() : okResponse()),
		}),
	);
	assert.equal(router.getTransport(), "provider");
	assert.equal(calls.provider, 2);
	assert.equal(calls.generate, 1);
	router.reset();
	assert.equal(router.getTransport(), "unknown");
}

async function testRouterStaleRequestDoesNotOverwrite(): Promise<void> {
	const calls = { provider: 0, generate: 0 };
	let releaseFirst!: (response: Response) => void;
	const firstFetch = new Promise<Response>((resolve) => {
		releaseFirst = resolve;
	});
	const router = createCommandCodeTransportRouter({
		createStream: () => createAssistantMessageEventStream(),
		streamProvider: fakeProvider((model) => providerTextEvents(model, "via-provider"), calls),
		streamGenerate: fakeGenerate("via-generate", calls),
	});
	const model = makeModel();
	const first = collect(
		router.stream(model, makeContext(), { apiKey: TEST_KEY_A, fetch: () => firstFetch }),
	);
	const second = await collect(
		router.stream(model, makeContext(), { apiKey: TEST_KEY_B, fetch: async () => okResponse() }),
	);
	assert.equal(second.at(-1)?.type, "done");
	releaseFirst(upgradeRequiredResponse());
	const firstEvents = await first;
	assert.equal(router.getTransport(), "provider");
	assert.equal(calls.generate, 1);
	assert.ok(firstEvents.length > 0);
}

async function testRouterEndToEndGoGenerate(): Promise<void> {
	const streamGenerate = createGoGenerateStream({ apiBase: "https://api.commandcode.ai" });
	const router = createCommandCodeTransportRouter({
		createStream: () => createAssistantMessageEventStream(),
		streamProvider: fakeProvider((model) => providerTextEvents(model, "via-provider"), {
			provider: 0,
		}),
		streamGenerate,
	});
	const model = makeModel();
	const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("/alpha/generate")) {
			return sseResponse([JSON.stringify({ type: "text-delta", text: "go-hello" }), finishLine()]);
		}
		return upgradeRequiredResponse();
	};
	const events = await collect(
		router.stream(model, makeContext(), { apiKey: TEST_KEY_A, fetch: fetchImpl as typeof fetch }),
	);
	assert.equal(router.getTransport(), "generate");
	assert.equal(events.at(-1)?.type, "done");
	const [done] = events.slice(-1);
	if (done?.type === "done") {
		const [block] = done.message.content;
		if (block?.type === "text") assert.equal(block.text, "go-hello");
		else assert.fail("expected generated text");
	} else {
		assert.fail("expected done");
	}
}

// ---------------------------------------------------------------------------
// Generate-transport tests (real stream, mocked fetch)
// ---------------------------------------------------------------------------

async function testGenerateTextStreaming(): Promise<void> {
	let seenAuth: string | undefined;
	const streamGenerate = createGoGenerateStream({ apiBase: "https://api.commandcode.ai" });
	const model = makeModel();
	const fetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		seenAuth = new Headers(init?.headers).get("authorization") ?? undefined;
		return sseResponse([
			JSON.stringify({ type: "text-delta", text: "Hello " }),
			JSON.stringify({ type: "text-delta", text: "world" }),
			finishLine(),
		]);
	};
	const events = await collect(
		streamGenerate(model, makeContext(), {
			apiKey: TEST_KEY_A,
			fetch: fetchImpl as typeof fetch,
		}),
	);
	assert.deepEqual(eventTypes(events), [
		"start",
		"text_start",
		"text_delta",
		"text_delta",
		"text_end",
		"done",
	]);
	assert.equal(seenAuth, `Bearer ${TEST_KEY_A}`);
	const [done] = events.slice(-1);
	if (done?.type === "done") {
		assert.equal(done.reason, "stop");
		const [block] = done.message.content;
		if (block?.type === "text") assert.equal(block.text, "Hello world");
		else assert.fail("expected text block");
		assert.equal(done.message.usage.input, 20);
		assert.equal(done.message.usage.output, 10);
		assert.equal(done.message.usage.cacheRead, 70);
		assert.equal(done.message.usage.cacheWrite, 10);
		assert.equal(done.message.usage.totalTokens, 110);
	} else {
		assert.fail("expected done");
	}
}

async function testGenerateReasoning(): Promise<void> {
	let seenBody = "";
	const streamGenerate = createGoGenerateStream({ apiBase: "https://api.commandcode.ai" });
	const model = makeModel();
	const fetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		seenBody = String(init?.body ?? "");
		return sseResponse([
			JSON.stringify({ type: "reasoning-start" }),
			JSON.stringify({ type: "reasoning-delta", text: "let me think" }),
			JSON.stringify({ type: "reasoning-end" }),
			JSON.stringify({ type: "text-delta", text: "answer" }),
			finishLine(),
		]);
	};
	const events = await collect(
		streamGenerate(model, makeContext(), {
			apiKey: TEST_KEY_A,
			reasoning: "high",
			fetch: fetchImpl as typeof fetch,
		}),
	);
	assert.deepEqual(eventTypes(events), [
		"start",
		"thinking_start",
		"thinking_delta",
		"thinking_end",
		"text_start",
		"text_delta",
		"text_end",
		"done",
	]);
	const body = JSON.parse(seenBody) as { params: { reasoning_effort?: string } };
	assert.equal(body.params.reasoning_effort, "high");
}

async function testGenerateEffortLevels(): Promise<void> {
	const bodies: string[] = [];
	const streamGenerate = createGoGenerateStream({ apiBase: "https://api.commandcode.ai" });
	const model = makeModel();
	const fetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		bodies.push(String(init?.body ?? ""));
		return sseResponse([finishLine()]);
	};
	const fetchAsFetch = fetchImpl as typeof fetch;
	await collect(streamGenerate(model, makeContext(), { apiKey: TEST_KEY_A, fetch: fetchAsFetch }));
	await collect(
		streamGenerate(makeModel({ reasoning: false }), makeContext(), {
			apiKey: TEST_KEY_A,
			reasoning: "high",
			fetch: fetchAsFetch,
		}),
	);
	// Note: ThinkingLevel excludes "off" in this pi version, so absence of a
	// level is the only way to request no explicit effort. The implementation
	// still tolerates "off" from untyped callers.
	const efforts = bodies.map(
		(raw) => (JSON.parse(raw) as { params: { reasoning_effort?: string } }).params.reasoning_effort,
	);
	assert.deepEqual(efforts, [undefined, undefined]);
}

async function testGenerateToolCalls(): Promise<void> {
	const streamGenerate = createGoGenerateStream({ apiBase: "https://api.commandcode.ai" });
	const model = makeModel();
	const fetchImpl = async (): Promise<Response> =>
		sseResponse([
			JSON.stringify({ type: "tool-input-start", id: "call_1", toolName: "get_weather" }),
			JSON.stringify({ type: "tool-input-delta", id: "call_1", delta: '{"city":"Lis' }),
			JSON.stringify({ type: "tool-input-delta", id: "call_1", delta: 'bon"}' }),
			JSON.stringify({
				type: "tool-call",
				toolCallId: "call_1",
				toolName: "get_weather",
				input: { city: "Lisbon" },
			}),
			finishLine({ finishReason: "tool-calls" }),
		]);
	const events = await collect(
		streamGenerate(model, makeContext(), {
			apiKey: TEST_KEY_A,
			fetch: fetchImpl as typeof fetch,
		}),
	);
	assert.deepEqual(eventTypes(events), [
		"start",
		"toolcall_start",
		"toolcall_delta",
		"toolcall_delta",
		"toolcall_end",
		"done",
	]);
	const [done] = events.slice(-1);
	assert.equal(done?.type, "done");
	if (done?.type === "done") {
		assert.equal(done.reason, "toolUse");
		const [block] = done.message.content;
		assert.equal(block?.type, "toolCall");
		if (block?.type === "toolCall") {
			assert.equal(block.id, "call_1");
			assert.equal(block.name, "get_weather");
			assert.deepEqual(block.arguments, { city: "Lisbon" });
		}
	}
}

async function testGenerateUsageDerivedWithoutDetails(): Promise<void> {
	const streamGenerate = createGoGenerateStream({ apiBase: "https://api.commandcode.ai" });
	const priced = makeModel({
		cost: { input: 1_000_000, output: 2_000_000, cacheRead: 500_000, cacheWrite: 0 },
	});
	const fetchImpl = async (): Promise<Response> =>
		sseResponse([
			finishLine({
				totalUsage: { inputTokens: 100, outputTokens: 10 },
			}),
		]);
	const events = await collect(
		streamGenerate(priced, makeContext(), {
			apiKey: TEST_KEY_A,
			fetch: fetchImpl as typeof fetch,
		}),
	);
	const [done] = events.slice(-1);
	assert.equal(done?.type, "done");
	if (done?.type === "done") {
		assert.equal(done.message.usage.input, 100);
		assert.equal(done.message.usage.output, 10);
		assert.equal(done.message.usage.totalTokens, 110);
		assert.equal(done.message.usage.cost.input, 100);
		assert.equal(done.message.usage.cost.output, 20);
		const expected = calculateCost(priced, done.message.usage);
		assert.deepEqual(done.message.usage.cost, expected);
	}
}

async function testGenerateIncompleteStream(): Promise<void> {
	const streamGenerate = createGoGenerateStream({ apiBase: "https://api.commandcode.ai" });
	const fetchImpl = async (): Promise<Response> =>
		sseResponse([JSON.stringify({ type: "text-delta", text: "truncated" })]);
	const events = await collect(
		streamGenerate(makeModel(), makeContext(), {
			apiKey: TEST_KEY_A,
			fetch: fetchImpl as typeof fetch,
		}),
	);
	assert.equal(events.at(-1)?.type, "error");
	const [failure] = events.slice(-1);
	if (failure?.type === "error") {
		assert.match(failure.error.errorMessage ?? "", /no finish event/i);
	}
}

async function testGenerateNetworkErrorRedacted(): Promise<void> {
	const streamGenerate = createGoGenerateStream({ apiBase: "https://api.commandcode.ai" });
	const secret = "user_networksecret_789";
	const fetchImpl = async (): Promise<Response> => {
		throw new Error(`socket failed for Bearer ${secret}`);
	};
	const events = await collect(
		streamGenerate(makeModel(), makeContext(), {
			apiKey: TEST_KEY_A,
			fetch: fetchImpl as typeof fetch,
		}),
	);
	assert.equal(events.at(-1)?.type, "error");
	const serialized = JSON.stringify(events);
	assert.ok(!serialized.includes(secret), "credential leaked into events");
	const [failure] = events.slice(-1);
	if (failure?.type === "error") {
		assert.ok(!(failure.error.errorMessage ?? "").includes(secret));
	}
}

async function testGenerateAbort(): Promise<void> {
	const streamGenerate = createGoGenerateStream({ apiBase: "https://api.commandcode.ai" });
	let called = 0;
	const fetchImpl = async (): Promise<Response> => {
		called += 1;
		return sseResponse([finishLine()]);
	};
	const controller = new AbortController();
	controller.abort();
	const events = await collect(
		streamGenerate(makeModel(), makeContext(), {
			apiKey: TEST_KEY_A,
			signal: controller.signal,
			fetch: fetchImpl as typeof fetch,
		}),
	);
	assert.deepEqual(eventTypes(events), ["start", "error"]);
	assert.equal(called, 0);
	const [failure] = events.slice(-1);
	assert.equal(failure?.type, "error");
	if (failure?.type === "error") assert.equal(failure.reason, "aborted");
}

async function testGenerateMissingKey(): Promise<void> {
	const streamGenerate = createGoGenerateStream({ apiBase: "https://api.commandcode.ai" });
	let called = 0;
	const fetchImpl = async (): Promise<Response> => {
		called += 1;
		return sseResponse([finishLine()]);
	};
	const events = await collect(
		streamGenerate(makeModel(), makeContext(), {
			apiKey: "   ",
			fetch: fetchImpl as typeof fetch,
		}),
	);
	assert.equal(called, 0);
	assert.equal(events.at(-1)?.type, "error");
}

async function testGenerateImageRefusal(): Promise<void> {
	const streamGenerate = createGoGenerateStream({ apiBase: "https://api.commandcode.ai" });
	const fetchImpl = async (): Promise<Response> => sseResponse([finishLine()]);
	const context = normalizeContext({
		systemPrompt: "You are helpful.",
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "What is this?" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
				timestamp: Date.now(),
			},
		],
		tools: [],
	});
	const events = await collect(
		streamGenerate(makeModel({ input: ["text"] }), context, {
			apiKey: TEST_KEY_A,
			fetch: fetchImpl as typeof fetch,
		}),
	);
	assert.equal(events.at(-1)?.type, "error");
	const [failure] = events.slice(-1);
	if (failure?.type === "error") {
		assert.match(failure.error.errorMessage ?? "", /image/i);
	}
}

async function testGeneratePayloadHooks(): Promise<void> {
	const streamGenerate = createGoGenerateStream({ apiBase: "https://api.commandcode.ai" });
	let payloadSeen = false;
	let responseSeen = 0;
	const fetchImpl = async (): Promise<Response> => sseResponse([finishLine()]);
	const events = await collect(
		streamGenerate(makeModel(), makeContext(), {
			apiKey: TEST_KEY_A,
			fetch: fetchImpl as typeof fetch,
			onPayload: (payload) => {
				payloadSeen = true;
				return payload;
			},
			onResponse: () => {
				responseSeen += 1;
			},
		}),
	);
	assert.equal(payloadSeen, true);
	assert.equal(responseSeen, 1);
	assert.equal(events.at(-1)?.type, "done");
}

// ---------------------------------------------------------------------------
// Converter tests
// ---------------------------------------------------------------------------

async function testConverters(): Promise<void> {
	const context = normalizeContext({
		systemPrompt: "Be brief.",
		messages: [
			{ role: "user", content: "Weather in Lisbon?", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_1", name: "get_weather", arguments: { city: "Lisbon" } }],
				api: "openai-completions",
				provider: "command-code",
				model: "moonshotai/Kimi-K3",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "get_weather",
				content: [{ type: "text", text: "Sunny" }],
				isError: false,
				timestamp: Date.now(),
			},
		],
		tools: [WEATHER_TOOL],
	});
	const cc = messagesToCC(context.messages, { allowImages: false }) as Record<string, unknown>[];
	assert.ok(cc.length >= 2);
	assert.equal((cc[0] as { role: string }).role, "user");
	const tools = toolsToJson(
		[{ name: "get_weather", description: "Weather", parameters: WEATHER_TOOL.parameters }],
		"moonshotai/Kimi-K3",
	) as Record<string, unknown>[];
	assert.equal(tools[0]?.type, "function");
	assert.equal(tools[0]?.name, "get_weather");
	assert.ok(typeof tools[0]?.input_schema === "object");

	assert.equal(parseStreamEventLine(": comment"), undefined);
	assert.equal(parseStreamEventLine("event: message"), undefined);
	assert.equal(parseStreamEventLine("data: [DONE]"), undefined);
	assert.equal(parseStreamEventLine("not json"), undefined);
	const parsed = parseStreamEventLine('data: {"type":"text-delta","text":"hi"}') as {
		type: string;
		text: string;
	};
	assert.equal(parsed.type, "text-delta");
	assert.equal(parsed.text, "hi");

	assert.equal(mapFinishReason("tool-calls"), "toolUse");
	assert.equal(mapFinishReason("max_tokens"), "length");
	assert.equal(mapFinishReason("stop"), "stop");
	assert.equal(systemPromptToText("hello"), "hello");
}

async function testRedaction(): Promise<void> {
	assert.ok(!redactCommandCodeErrorText("Bearer user_testkey_alpha_001").includes("user_testkey_alpha_001"));
	assert.ok(!redactCommandCodeErrorText("api_key=user_testkey_alpha_001").includes("user_testkey_alpha_001"));
	const leak = `failure for ${TEST_KEY_A}`;
	const redacted = redactCommandCodeErrorText(leak);
	assert.ok(!redacted.includes(TEST_KEY_A), "user token must be redacted");
}

async function runDeterministicTests(): Promise<void> {
	await testModelMapping();
	console.log("model mapping: ok");
	await testRouterProviderAccepted();
	console.log("router provider accepted: ok");
	await testRouterUpgradeRequiredFallsBack();
	console.log("router 403 upgrade_required falls back to Go: ok");
	await testRouterOther403DoesNotFallBack();
	console.log("router other 403 does not fall back: ok");
	await testRouterReusesSelectedTransport();
	console.log("router reuses selected transport: ok");
	await testRouterKeyChangeResets();
	console.log("router key change resets: ok");
	await testRouterStaleRequestDoesNotOverwrite();
	console.log("router stale request guard: ok");
	await testRouterEndToEndGoGenerate();
	console.log("router end-to-end Go generate: ok");
	await testGenerateTextStreaming();
	console.log("generate text streaming: ok");
	await testGenerateReasoning();
	console.log("generate reasoning: ok");
	await testGenerateEffortLevels();
	console.log("generate effort levels: ok");
	await testGenerateToolCalls();
	console.log("generate tool calls: ok");
	await testGenerateUsageDerivedWithoutDetails();
	console.log("generate usage: ok");
	await testGenerateIncompleteStream();
	console.log("generate incomplete stream: ok");
	await testGenerateNetworkErrorRedacted();
	console.log("generate network error redacted: ok");
	await testGenerateAbort();
	console.log("generate abort: ok");
	await testGenerateMissingKey();
	console.log("generate missing key: ok");
	await testGenerateImageRefusal();
	console.log("generate image refusal: ok");
	await testGeneratePayloadHooks();
	console.log("generate payload hooks: ok");
	await testConverters();
	console.log("converters: ok");
	await testRedaction();
	console.log("redaction: ok");
}

async function main(): Promise<void> {
	if (!process.argv.includes("--live")) {
		await runDeterministicTests();
		console.log("all deterministic tests: ok");
		return;
	}

	const apiKey = process.env.CMD_API_KEY;
	const args = process.argv.slice(2).filter((arg) => arg !== "--live");
	const all = args.includes("--all");
	const reasoningIndex = args.indexOf("--reasoning");
	const reasoning = reasoningIndex >= 0 ? (args[reasoningIndex + 1] as ThinkingLevel) : undefined;
	const requested = args.filter(
		(arg, index) => !arg.startsWith("--") && (reasoningIndex < 0 || index !== reasoningIndex + 1),
	);

	const catalog = await loadModels();
	console.log(`catalog: ${catalog.length} models (live)`);
	const byApi = new Map<Api, number>();
	for (const model of catalog) byApi.set(model.api, (byApi.get(model.api) ?? 0) + 1);
	for (const [api, count] of [...byApi].sort()) console.log(`  ${api}: ${count}`);
	const priced = catalog.filter((model) => model.cost.input > 0).length;
	console.log(`  priced by the API: ${priced}/${catalog.length}`);

	if (!apiKey) {
		console.log("\nCMD_API_KEY is unset, skipping live completions.");
		return;
	}

	const models = createModels();
	models.setProvider(commandCodeProvider(catalog));
	const targets: Model<Api>[] = all
		? catalog
		: (requested.length > 0 ? requested : DEFAULT_IDS).map((id) => {
				const model = catalog.find((entry) => entry.id === id);
				if (!model) throw new Error(`unknown model: ${id}`);
				return model;
			});

	let failed = 0;
	for (const model of targets) {
		const result = await models.completeSimple(
			model,
			{
				systemPrompt: "Call the tool. Do not answer from memory.",
				messages: [{ role: "user", content: "Weather in Lisbon?", timestamp: Date.now() }],
				tools: [WEATHER_TOOL],
			},
			{ apiKey, maxTokens: reasoning ? 4096 : 512, ...(reasoning ? { reasoning } : {}) },
		);
		const calls = result.content.filter((block) => block.type === "toolCall").length;
		const thinking = result.content.filter((block) => block.type === "thinking").length;
		const status = result.stopReason === "error" ? "ERROR" : calls > 0 ? "tool" : result.stopReason;
		if (result.stopReason === "error") failed++;
		console.log(
			`${String(status).padEnd(6)} ${model.api.padEnd(19)} ${model.id.padEnd(38)}` +
				`${reasoning ? ` think=${thinking}/${result.usage.reasoning ?? 0}` : ""}` +
				`${result.errorMessage ? ` ${result.errorMessage.slice(0, 100)}` : ""}`,
		);
	}
	console.log(`\n${targets.length} models | failed=${failed}`);
	if (failed > 0) process.exitCode = 1;
}

await main();
