/**
 * Transport router: try the official Provider API first, fall back to the
 * CLI-style generate transport on Go keys.
 *
 * Ported from patlux/pi-commandcode-provider v0.7.1 (commit 6fd0ac7)
 * src/transport.ts, adapted from the generic ModelLike/ContextLike shapes to
 * the pi native types (Model<Api>, TranscriptContext, SimpleStreamOptions).
 *
 * Behavior:
 * - Only a 403 whose JSON body carries error.code === "upgrade_required"
 *   triggers the fallback. Any other 403 (permission_denied, …) or any other
 *   provider error passes through untouched.
 * - The selected transport is memoized per API key so later requests skip
 *   the doomed Provider API attempt. A different apiKey (or reset()) clears
 *   the memoization. Stale in-flight requests never overwrite the transport
 *   selected for a newer key.
 * - Detection wraps options.fetch and clones the response before the native
 *   SDK consumes it, so neither path observes a consumed body. The caller's
 *   onResponse is skipped for the failed provider attempt: no response-header
 *   events leak from a request that fell back.
 * - No secrets are logged or embedded in errors here; bodies are only
 *   inspected for the upgrade_required code.
 */

import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	SimpleStreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";

export type CommandCodeTransport = "unknown" | "provider" | "generate";

export interface GoRouterDeps {
	createStream: () => AssistantMessageEventStream;
	streamProvider: (
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
	streamGenerate: (
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
}

export interface GoRouter {
	stream: (
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
	streamSimple: (
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
	getTransport: () => CommandCodeTransport;
	reset: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function isUpgradeRequired(response: Response): Promise<boolean> {
	if (response.status !== 403) return false;

	try {
		const body: unknown = await response.clone().json();
		if (!isRecord(body)) return false;
		const error = isRecord(body.error) ? body.error : body;
		return error.code === "upgrade_required";
	} catch {
		return false;
	}
}

function errorMessageFor(model: Model<Api>, error: unknown): AssistantMessage {
	return {
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
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

export function createCommandCodeTransportRouter(deps: GoRouterDeps): GoRouter {
	let transport: CommandCodeTransport = "unknown";
	let apiKey: string | undefined;

	function pipe(
		source: AssistantMessageEventStream,
		target: AssistantMessageEventStream,
	): Promise<void> {
		return (async () => {
			for await (const event of source) target.push(event);
		})();
	}

	function route(
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		if (options?.apiKey !== apiKey) {
			apiKey = options?.apiKey;
			transport = "unknown";
		}
		const requestApiKey = options?.apiKey;
		if (transport === "generate") return deps.streamGenerate(model, context, options);

		const output = deps.createStream();
		let upgradeRequired = false;
		const fetchImpl = options?.fetch ?? fetch;
		const providerOptions: SimpleStreamOptions = {
			...options,
			fetch: (async (input, init) => {
				const response = await fetchImpl(input, init);
				if (await isUpgradeRequired(response)) upgradeRequired = true;
				return response;
			}) as typeof fetch,
			onResponse: (async (response, responseModel) => {
				if (upgradeRequired) return;
				await options?.onResponse?.(response, responseModel);
			}) as SimpleStreamOptions["onResponse"],
		};

		const run = async () => {
			const providerStream = deps.streamProvider(model, context, providerOptions);

			for await (const event of providerStream) {
				if (!upgradeRequired) {
					if (apiKey === requestApiKey) transport = "provider";
					output.push(event);
				}
			}

			if (upgradeRequired) {
				if (apiKey === requestApiKey) transport = "generate";
				await pipe(deps.streamGenerate(model, context, options), output);
			}
			output.end();
		};

		run().catch((error: unknown) => {
			output.push({
				type: "error",
				reason: "error",
				error: errorMessageFor(model, error),
			});
			output.end();
		});

		return output;
	}

	return {
		stream: route,
		streamSimple: route,
		getTransport(): CommandCodeTransport {
			return transport;
		},
		reset(): void {
			transport = "unknown";
			apiKey = undefined;
		},
	};
}
