/**
 * Modified in 2026 by Sokoshy: added the Go-plan fallback transport and its
 * router. Originally Copyright 2026 Command Code, Apache License 2.0 —
 * see the LICENSE and NOTICE files.
 * The model list (and the route for each model) comes from
 * https://api.commandcode.ai/provider/v1/models at startup, merged by id with
 * the capability view — reasoning efforts, prices, modalities, output caps —
 * from the same endpoint with `?view=client`. No part of the catalog is
 * hardcoded, so new Command Code models appear without a change here.
 * Known families have temporary fallbacks until the endpoints supply the data.
 * If the capability view fails the provider still loads with default thinking
 * levels and $0 prices, and reports a warning at session start.
 *
 * The public endpoint returns ids, names, context windows and routes; prices
 * live in the capability view, so pi reports real costs once both fetches
 * succeed.
 *
 * Usage:
 *   pi install git:git@github.com:Sokoshy/pi-commandcode-provider
 *   # then /login command-code, or set CMD_API_KEY=...
 */

import {
	createProvider,
	envApiKeyAuth,
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessageEventStream,
	type Model,
	type ModelCost,
	type ThinkingLevelMap,
	type Provider,
	type ProviderEnv,
	type ProviderStreams,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
// the root, /compat, /oauth and /providers/all are mapped. The /api/*.lazy
// subpaths are not, so they fail to load from an npm install. /compat
// re-exports the same lazy factories.
import { anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Go fallback transport: ported from patlux/pi-commandcode-provider
// v0.7.1 (commit 6fd0ac7). Only the router, the /alpha/generate stream and
// the converters are imported; the upstream catalog above stays untouched.
import { createGoGenerateStream, GO_GENERATE_API_BASE } from "./src/go-generate.ts";
import { normalizeCommandCodeMessage } from "./src/go-overflow.ts";
import { createCommandCodeTransportRouter } from "./src/go-router.ts";
const PROVIDER_ID = "command-code";
const PROVIDER_NAME = "Command Code (unofficial fork)";
// The Anthropic SDK appends /v1/messages to the base URL. The OpenAI SDKs
// append /chat/completions and /responses.
const BASE_URL = "https://api.commandcode.ai/provider";
const OPENAI_BASE_URL = `${BASE_URL}/v1`;
const MODELS_URL = `${OPENAI_BASE_URL}/models`;
const MODELS_TIMEOUT_MS = 10_000;

const ZDR_HEADER = "x-cmd-zdr";
const ZDR_ENV = "CMD_ZDR";
const MODELS_URL_ENV = "CMD_MODELS_URL";
const GENERATE_BASE_URL_ENV = "CMD_GENERATE_BASE_URL";
const CLIENT_MODELS_URL = `${OPENAI_BASE_URL}/models?view=client`;
const CLIENT_MODELS_URL_ENV = "CMD_CLIENT_MODELS_URL";
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const FALLBACK_MAX_TOKENS = 32_768;
const FALLBACK_CONTEXT_WINDOW = 131_072;

/**
 * One entry from /provider/v1/models. The API does not return the fields after
 * `supported_endpoints` yet. This reads them anyway, so the extension picks
 * them up as soon as the API sends them.
 */
interface CommandCodeModelListItem {
	id: string;
	name?: string;
	context_length?: number;
	supported_endpoints?: string[];
	pricing?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	max_output_tokens?: number;
	modalities?: { input?: string[] };
	reasoning?: boolean;
}

/**
 * Pricing block from the capability view. USD per million tokens.
 * `contextTiers` carries the same rates with increasing `maxContext`; the
 * entry without `maxContext` applies above the previous boundary.
 */
interface CommandCodePricingRates {
	inputCost?: number;
	outputCost?: number;
	cacheReadCost?: number;
	cacheWriteCost?: number;
}
interface CommandCodePricing extends CommandCodePricingRates {
	cacheWrite1hCost?: number;
	contextTiers?: { maxContext?: number; rates?: CommandCodePricingRates }[];
}

/**
 * One entry from /provider/v1/models?view=client, the capability view the
 * Command Code CLI reads at startup. Not documented upstream and may change
 * shape without notice, so every field is optional and the merge degrades to
 * public-endpoint metadata when the view fails.
 */
interface CommandCodeClientModelItem {
	id: string;
	name?: string;
	context_length?: number;
	reasoningEfforts?: string[] | null;
	pricing?: CommandCodePricing;
	inputModalities?: string[];
	maxOutputTokens?: number | null;
	behaviorProfile?: string;
	minimumPlan?: string;
}

/** pi's extended thinking levels; xhigh and max are hidden unless the map defines them. */
const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Map the registry's reasoning efforts onto pi levels; efforts outside the registry are hidden. */
function thinkingLevelMapFromEfforts(efforts: string[]): ThinkingLevelMap {
	const supported = new Set(efforts);
	const map: ThinkingLevelMap = {};
	for (const level of MODEL_THINKING_LEVELS) map[level] = supported.has(level) ? level : null;
	return map;
}

function costRates(rates: CommandCodePricingRates | undefined) {
	return {
		input: rates?.inputCost ?? 0,
		output: rates?.outputCost ?? 0,
		cacheRead: rates?.cacheReadCost ?? 0,
		cacheWrite: rates?.cacheWriteCost ?? 0,
	};
}

function tiersFromContextTiers(rows?: CommandCodePricing["contextTiers"]) {
	if (!Array.isArray(rows) || rows.length < 2) return undefined;
	const tiers: { inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }[] = [];
	let previousBoundary: number | undefined;
	for (const row of rows) {
		if (!row) continue;
		if (previousBoundary !== undefined && row.rates) {
			tiers.push({ inputTokensAbove: previousBoundary, ...costRates(row.rates) });
		}
		if (typeof row.maxContext === "number") previousBoundary = row.maxContext;
	}
	return tiers.length > 0 ? tiers : undefined;
}

/** USD-per-million base rates, plus request-wide tiers for long-context pricing when the registry prices it higher. */
function costFromPricing(pricing: CommandCodePricing): ModelCost {
	const base = costRates(pricing);
	const tiers = tiersFromContextTiers(pricing.contextTiers);
	return tiers ? { ...base, tiers } : base;
}

/**
 * Capability defaults per model family, used until /models reports them.
 */
const FAMILIES: { match: RegExp; reasoning: boolean; vision: boolean }[] = [
	{ match: /^claude-/, reasoning: true, vision: true },
	{ match: /^gpt-/, reasoning: true, vision: true },
	{ match: /^google\//, reasoning: true, vision: true },
];

/**
 * Claude models from Opus 4.6, Sonnet 4.6 and Fable 5 onward reject
 * `thinking: {type: "enabled"}` and require `{type: "adaptive"}` with
 * `output_config.effort`. Without this match, pi sends the budget form and the
 * gateway answers 400.
 */
const ADAPTIVE_THINKING = /(opus[-.](4[-.]6|4[-.]7|4[-.]8|5)|sonnet[-.](4[-.]6|5)|fable[-.]5|mythos[-.]5)/;

function envValue(name: string, env?: ProviderEnv): string | undefined {
	return env?.[name] || (typeof process !== "undefined" ? process.env[name] : undefined) || undefined;
}

function toModel(item: CommandCodeModelListItem, clientItem?: CommandCodeClientModelItem): Model<Api> | undefined {
	const endpoints = item.supported_endpoints ?? [];
	// Claude answers on /messages only and returns 400 on any other route.
	// OpenAI ids go to Responses. Everything else uses Chat Completions.
	const api: Api | undefined = endpoints.includes("/messages")
		? "anthropic-messages"
		: endpoints.includes("/responses") && item.id.startsWith("gpt-")
			? "openai-responses"
			: endpoints.includes("/chat/completions")
				? "openai-completions"
				: endpoints.includes("/responses")
					? "openai-responses"
					: undefined;
	if (!api) return undefined;

	const family = FAMILIES.find((entry) => entry.match.test(item.id));
	// The capability view reports modalities as a flat list ("text", "image",
	// "file"); pi models only carry text/image, so "file" is dropped here.
	const modalities = clientItem?.inputModalities ?? item.modalities?.input;
	const vision = Array.isArray(modalities) ? modalities.includes("image") : (family?.vision ?? false);
	const cost: ModelCost = clientItem?.pricing
		? costFromPricing(clientItem.pricing)
		: item.pricing
			? {
					input: item.pricing.input ?? 0,
					output: item.pricing.output ?? 0,
					cacheRead: item.pricing.cache_read ?? 0,
					cacheWrite: item.pricing.cache_write ?? 0,
				}
			: NO_COST;
	const model: Model<Api> = {
		id: item.id,
		name: clientItem?.name || item.name || item.id,
		api,
		provider: PROVIDER_ID,
		baseUrl: api === "anthropic-messages" ? BASE_URL : OPENAI_BASE_URL,
		reasoning: item.reasoning ?? family?.reasoning ?? true,
		input: vision ? ["text", "image"] : ["text"],
		cost,
		contextWindow: item.context_length || clientItem?.context_length || FALLBACK_CONTEXT_WINDOW,
		maxTokens: clientItem?.maxOutputTokens || item.max_output_tokens || FALLBACK_MAX_TOKENS,
		// CMD_ZDR=1 enforces zero-data-retention routing, the same switch the
		// Command Code CLI has. The gateway then serves the request from a
		// zero-data-retention upstream, or fails with 422 instead of using an
		// upstream that retains data. The header goes on the model because that
		// is the field pi merges into each request.
		...(envValue(ZDR_ENV) === "1" ? { headers: { [ZDR_HEADER]: "1" } } : {}),
	};
	if (Array.isArray(clientItem?.reasoningEfforts)) {
		// The registry lists exactly the efforts the model accepts; map every
		// pi level so xhigh/max become visible (pi hides them otherwise) and
		// unsupported levels such as minimal drop out.
		model.thinkingLevelMap = thinkingLevelMapFromEfforts(clientItem.reasoningEfforts);
	}
	// reasoningEfforts === null means the model picks its own depth (Kimi
	// K2.x, Qwen 3.6/3.7, ...). pi's default map applies unchanged.

	if (api === "openai-completions") {
		// Several upstreams behind this route reject the `developer` role that pi
		// sends to reasoning models. Every upstream accepts `system`.
		model.compat = { supportsDeveloperRole: false, maxTokensField: "max_tokens" };
	} else if (api === "anthropic-messages" && ADAPTIVE_THINKING.test(item.id)) {
		model.compat = { forceAdaptiveThinking: true };
	}
	return model;
}

export interface LoadCatalogResult {
	models: Model<Api>[];
	/** true when the capability view was fetched and merged. */
	capabilitiesLoaded: boolean;
	/** why the capability view is missing, when it is (the public catalog still loads). */
	capabilitiesError?: string;
}

/**
 * Load the public catalog (routing) and, unless `clientUrl` is null, the
 * capability view — reasoning efforts, prices, modalities, output caps — and
 * merge the two by id. Throws when the public catalog cannot be fetched; the
 * capability view degrades to a missing-metadata warning so pi still starts.
 */
export async function loadCatalog(
	url = MODELS_URL,
	clientUrl: string | null = CLIENT_MODELS_URL,
	signal?: AbortSignal,
): Promise<LoadCatalogResult> {
	const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(MODELS_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`Command Code /models returned ${response.status}`);
	const body = (await response.json()) as { data?: CommandCodeModelListItem[] };
	const items = Array.isArray(body.data) ? body.data : [];

	let clients: Map<string, CommandCodeClientModelItem> | undefined;
	let capabilitiesError: string | undefined;
	if (clientUrl) {
		try {
			const clientResponse = await fetch(clientUrl, { signal: signal ?? AbortSignal.timeout(MODELS_TIMEOUT_MS) });
			if (!clientResponse.ok) throw new Error(`Command Code /models?view=client returned ${clientResponse.status}`);
			const clientBody = (await clientResponse.json()) as { data?: CommandCodeClientModelItem[] };
			const clientItems = Array.isArray(clientBody.data) ? clientBody.data : [];
			clients = new Map(
				clientItems.filter((entry) => entry && typeof entry.id === "string").map((entry) => [entry.id, entry]),
			);
		} catch (error) {
			capabilitiesError = error instanceof Error ? error.message : String(error);
		}
	}
	const models = items
		.map((item) => toModel(item, clients?.get(item.id)))
		.filter((model): model is Model<Api> => model !== undefined);
	return { models, capabilitiesLoaded: clients !== undefined, capabilitiesError };
}

export async function loadModels(url = MODELS_URL, signal?: AbortSignal): Promise<Model<Api>[]> {
	const result = await loadCatalog(url, CLIENT_MODELS_URL, signal);
	return result.models;
}

export function commandCodeProvider(models: Model<Api>[]): Provider<Api> {
	// Native Provider API implementations, one per route reported by /models.
	const nativeApis = {
		"anthropic-messages": anthropicMessagesApi(),
		"openai-completions": openAICompletionsApi(),
		"openai-responses": openAIResponsesApi(),
	};
	// CLI-style fallback for Go keys, which the Provider API refuses with
	// 403 upgrade_required (see https://commandcode.ai/docs/provider).
	const streamGenerate = createGoGenerateStream({
		apiBase: envValue(GENERATE_BASE_URL_ENV) ?? GO_GENERATE_API_BASE,
	});
	const streamProvider = (
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const native = (nativeApis as Record<string, ProviderStreams | undefined>)[model.api];
		if (!native) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "error",
					reason: "error",
					error: {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "error",
						errorMessage: `Command Code: no provider route for api "${model.api}" (model ${model.id}).`,
						timestamp: Date.now(),
					},
				});
				stream.end();
			});
			return stream;
		}
		// Both entry points delegate to the native streamSimple implementations:
		// that is the path the upstream extension used for every request, and
		// the router only observes the response status around it.
		return native.streamSimple(model, context, options);
	};
	const router = createCommandCodeTransportRouter({
		createStream: () => createAssistantMessageEventStream(),
		streamProvider,
		streamGenerate,
	});
	return createProvider<Api>({
		id: PROVIDER_ID,
		name: PROVIDER_NAME,
		auth: { apiKey: envApiKeyAuth("Command Code API key", ["CMD_API_KEY", "COMMAND_CODE_API_KEY"]) },
		models,
		api: {
			stream: router.stream,
			streamSimple: router.streamSimple,
		},
	});
}

export default async function activate(pi: ExtensionAPI): Promise<void> {
	// Normalize this provider's context-overflow errors so pi can compact and
	// retry them like any other provider overflow. Other failures pass through.
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return undefined;
		const normalized = normalizeCommandCodeMessage(event.message, ctx.model?.provider);
		return normalized ? { message: normalized.message } : undefined;
	});
	try {
		const clientEnv = envValue(CLIENT_MODELS_URL_ENV);
		const clientUrl = clientEnv && /^(0|off|false|disable)$/i.test(clientEnv) ? null : (clientEnv ?? CLIENT_MODELS_URL);
		const result = await loadCatalog(envValue(MODELS_URL_ENV) ?? MODELS_URL, clientUrl);
		if (!result.capabilitiesLoaded) {
			// The public catalog alone is enough to route requests; only the
			// capability metadata (thinking levels, prices) is missing.
			const detail = result.capabilitiesError ? ` (${result.capabilitiesError})` : "";
			pi.on("session_start", async (_event, ctx) => {
				ctx.ui.notify(
					`Command Code: capability metadata unavailable${detail}; thinking levels and prices fall back to defaults.`,
					"warning",
				);
			});
		}
		pi.registerProvider(commandCodeProvider(result.models));
	} catch (error) {
		// No catalog means no models. Report that instead of registering an
		// empty provider.
		const reason = error instanceof Error ? error.message : String(error);
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(`Command Code: could not load the model list (${reason}).`, "warning");
		});
	}
}
