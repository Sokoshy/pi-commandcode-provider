/**
 *
 * Copyright (c) 2025 Pat Woz, MIT License (permission notice in NOTICE).
 * Adapted in 2026 by Sokoshy for this unofficial fork.
 * Pi <-> Command Code /alpha/generate converters.
 *
 * Ported from patlux/pi-commandcode-provider v0.7.1 (commit 6fd0ac7)
 * src/converters.ts, adapted from the generic MessageLike/ContextLike
 * shapes to the pi native types (Message, Tool, StopReason).
 */

import type { Message, StopReason, Tool } from "@earendil-works/pi-ai";
import { geminiSafeJsonSchema, toJsonSchema } from "./go-json-schema.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function recordArray(value: unknown): readonly Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isRecord);
}

export function recordOrEmpty(value: unknown): Record<string, unknown> {
	if (isRecord(value)) return value;
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			if (isRecord(parsed)) return parsed;
		} catch {
			// Some providers stream incomplete JSON argument fragments.
		}
	}
	return {};
}

export function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Hosts may pass a literal env-var name instead of the actual credential.
// Treat those as unresolved so a placeholder is never sent on the wire.
export const COMMAND_CODE_PLACEHOLDER_KEYS = new Set([
	"$COMMAND_CODE_API_KEY",
	"COMMAND_CODE_API_KEY",
	"$COMMANDCODE_API_KEY",
	"COMMANDCODE_API_KEY",
]);

export function usableCommandCodeApiKey(value: string | undefined): string | undefined {
	const trimmed = typeof value === "string" ? value.trim() : undefined;
	if (!trimmed) return undefined;
	if (COMMAND_CODE_PLACEHOLDER_KEYS.has(trimmed)) return undefined;
	return trimmed;
}

function imageParts(value: unknown): readonly Record<string, unknown>[] {
	if (isRecord(value)) return value.type === "image" ? [value] : [];
	return recordArray(value).filter((part) => part.type === "image");
}

function imageContentError(role: string): Error {
	return new Error(`Selected Command Code model does not support image content in ${role}`);
}

export function assertTextOnlyMessages(messages?: readonly Message[]): void {
	for (const message of messages ?? []) {
		if (message.role !== "toolResult" && imageParts(message.content).length > 0) {
			throw imageContentError(`${message.role} messages`);
		}
	}
}

function imageToCommandCode(part: Record<string, unknown>): Record<string, string> {
	const data = stringValue(part.data);
	const mimeType = stringValue(part.mimeType);
	if (!data || !mimeType) throw new Error("Invalid image content: expected base64 data and mimeType");

	return {
		type: "image",
		image: `data:${mimeType};base64,${data}`,
		mimeType,
	};
}

function userContentToCommandCode(content: unknown, allowImages: boolean): unknown {
	if (typeof content === "string") return content;

	return recordArray(content).flatMap((part) => {
		if (part.type === "text") return [{ type: "text", text: stringValue(part.text) ?? "" }];
		if (part.type === "image") {
			if (!allowImages) throw imageContentError("user messages");
			return [imageToCommandCode(part)];
		}
		return [];
	});
}

export function textContent(message: { content?: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (message.content === null || message.content === undefined) return "";
	if (!Array.isArray(message.content)) {
		try {
			return JSON.stringify(message.content) ?? String(message.content);
		} catch {
			return String(message.content);
		}
	}

	return recordArray(message.content)
		.filter((part) => part.type === "text")
		.map((part) => stringValue(part.text) ?? "")
		.join("\n");
}

export function getEnvironmentInfo(): string {
	return `${process.platform}-${process.arch}, Bun ${process.version}`;
}

export function toolsToJson(tools?: readonly Tool[], modelId?: string): unknown[] {
	if (!tools) return [];
	const geminiSafe = modelId !== undefined && modelId.startsWith("google/gemini-");
	return tools.map((tool) => {
		const schema = tool.parameters ? toJsonSchema(tool.parameters) : {};
		return {
			type: "function",
			name: tool.name,
			description: tool.description,
			input_schema: geminiSafe ? geminiSafeJsonSchema(schema) : schema,
		};
	});
}

interface ToolCallState {
	callIds: ReadonlySet<string>;
	resultIds: ReadonlySet<string>;
}

function toolCallState(messages?: readonly Message[]): ToolCallState {
	const callIds = new Set<string>();
	const resultIds = new Set<string>();

	for (const message of messages ?? []) {
		if (message.role === "assistant") {
			for (const content of recordArray(message.content)) {
				if (content.type === "toolCall") {
					const id = stringValue(content.id);
					if (id) callIds.add(id);
				}
			}
		} else if (message.role === "toolResult" && message.toolCallId) {
			resultIds.add(message.toolCallId);
		}
	}

	return { callIds, resultIds };
}

/**
 * Convert a pi transcript to /alpha/generate messages. System messages are
 * skipped: the replayed system prompt travels in the top-level `system`
 * field instead. Tool declarations travel in `tools`.
 */
export function messagesToCC(
	messages?: readonly Message[],
	options: { allowImages?: boolean } = {},
): unknown[] {
	const allowImages = options.allowImages ?? false;
	if (!allowImages) assertTextOnlyMessages(messages);

	const out: unknown[] = [];
	const { callIds, resultIds } = toolCallState(messages);

	const rawMessages = messages ?? [];
	for (let i = 0; i < rawMessages.length; i++) {
		const message = rawMessages[i];
		if (message.role === "user" || (message as { role: string }).role === "developer") {
			// Hosts may steer the agent by injecting developer-role messages
			// mid-conversation. /alpha/generate only accepts user, assistant,
			// and tool roles, so degrade the role to user instead of dropping
			// the message.
			out.push({
				role: "user",
				content: userContentToCommandCode(message.content, allowImages),
			});
		} else if (message.role === "assistant") {
			const parts: unknown[] = [];
			const missingResults: unknown[] = [];
			for (const content of recordArray(message.content)) {
				if (content.type === "text") {
					parts.push({ type: "text", text: stringValue(content.text) ?? "" });
				} else if (content.type === "toolCall") {
					const toolCallId = stringValue(content.id) ?? "";
					const toolName = stringValue(content.name) ?? "";
					if (!toolCallId) continue;
					parts.push({
						type: "tool-call",
						toolCallId,
						toolName,
						input: recordOrEmpty(content.arguments),
					});
					if (!resultIds.has(toolCallId)) {
						missingResults.push({
							type: "tool-result",
							toolCallId,
							toolName,
							output: {
								type: "error-text",
								value: "No result — the tool call did not complete (interrupted or lost).",
							},
						});
					}
				}
			}
			if (parts.length > 0) out.push({ role: "assistant", content: parts });
			if (missingResults.length > 0) out.push({ role: "tool", content: missingResults });
		} else if (message.role === "toolResult") {
			const pendingImages: Record<string, string>[] = [];
			let j = i;
			for (; j < rawMessages.length && rawMessages[j].role === "toolResult"; j++) {
				const toolMsg = rawMessages[j];
				if (toolMsg.role !== "toolResult") continue;
				if (!toolMsg.toolCallId || !callIds.has(toolMsg.toolCallId)) continue;
				const images = imageParts(toolMsg.content);
				const text = textContent(toolMsg);
				const outputText =
					text || (images.length > 0 && !allowImages ? "[Image omitted: model does not support images]" : "");
				out.push({
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: toolMsg.toolCallId,
							toolName: toolMsg.toolName,
							output: toolMsg.isError
								? { type: "error-text", value: outputText }
								: { type: "text", value: outputText },
						},
					],
				});

				if (images.length > 0 && allowImages) {
					pendingImages.push(...images.map(imageToCommandCode));
				}
			}
			i = j - 1;

			if (pendingImages.length > 0) {
				out.push({
					role: "user",
					content: pendingImages,
				});
			}
		}
	}
	return out;
}

export function parseStreamEventLine(line: string): unknown | undefined {
	let trimmed = line.trim();
	if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return undefined;
	if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
	if (!trimmed || trimmed === "[DONE]") return undefined;

	try {
		const parsed: unknown = JSON.parse(trimmed);
		return parsed;
	} catch {
		return undefined;
	}
}

export function mapFinishReason(reason: unknown): StopReason {
	if (reason === "tool-calls") return "toolUse";
	if (reason === "length" || reason === "max_tokens" || reason === "max-tokens" || reason === "max_output_tokens") {
		return "length";
	}
	return "stop";
}

function promptPartToText(value: unknown, depth = 0): string {
	if (depth > 10) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value))
		return value
			.map((v) => promptPartToText(v, depth + 1))
			.filter(Boolean)
			.join("\n");
	if (!isRecord(value)) return "";
	const text = stringValue(value.text);
	if (text) return text;
	const content = promptPartToText(value.content, depth + 1);
	if (content) return content;
	return "";
}

export function systemPromptToText(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value))
		return value
			.map((v) => promptPartToText(v, 0))
			.filter(Boolean)
			.join("\n\n");
	return promptPartToText(value, 0);
}
