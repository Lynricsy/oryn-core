/**
 * Oryn：端点拒绝对话中途工具变更（`tool_addition` / `tool_removal`）时的降级。
 *
 * 夹具让 Core 在请求尾部插入 `tool_addition`：历史里最近一条 assistant 记录的声明表只有
 * `lookup`，本次活动工具多了 `extra`。部分网关改写了 `tools[]` 的名字却没改写控制块，
 * 于是回 400 `references unknown tool`。期望：同一回合关掉工具变更重放一次；重放成功后
 * 本进程内对该端点闩锁；无关的 400 与重放仍失败的情况都原样上抛且不闩锁。
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import {
	clearToolChangeFallback,
	isToolChangeRejection,
	withoutMidConversationToolChanges,
} from "@oh-my-pi/pi-ai/providers/oryn-tool-change-fallback";
import type { AssistantMessage, Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

const TOOL_CHANGES_BETA = "mid-conversation-tool-changes-2026-07-01";
const TOOL_CHANGE_REFUSAL = "messages.2.content.0: tool_addition/tool_removal references unknown tool 'extra'";
const UNRELATED_REFUSAL = "max_tokens: must be greater than 0";

const MODEL: Model<"anthropic-messages"> = buildModel({
	id: "claude-opus-5-5",
	name: "Claude Opus 5.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://gateway.example",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

function tool(name: string): NonNullable<Context["tools"]>[number] {
	return {
		name,
		description: `${name} tool`,
		parameters: { type: "object", properties: {}, additionalProperties: false },
	};
}

function previousReply(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "earlier answer" }],
		api: "anthropic-messages",
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
		requestControls: { messageIndex: 1, tools: { declared: ["lookup"], deferred: [], active: ["lookup"] } },
	};
}

const CONTEXT: Context = {
	systemPrompt: ["You are a precise assistant."],
	messages: [
		{ role: "user", content: "first question", timestamp: 1 },
		previousReply(),
		{ role: "user", content: "second question", timestamp: 3 },
	],
	tools: [tool("lookup"), tool("extra")],
};

type Reply = { kind: "ok" } | { kind: "reject"; message: string };

interface Capture {
	bodies: MessageCreateParams[];
	betaHeaders: string[];
}

function rejection(message: string): Response {
	return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), {
		status: 400,
		headers: { "Content-Type": "application/json" },
	});
}

function success(): Response {
	const events: Array<Record<string, unknown>> = [
		{ type: "message_start", message: { id: "msg_ok", usage: { input_tokens: 10, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 1 } },
		{ type: "message_stop" },
	];
	const body = `${events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream", "request-id": "req_tool_change_fallback" },
	});
}

/** 按顺序回放 `replies`，并记下每次请求的请求体与 `anthropic-beta` 头。 */
function scriptedFetch(capture: Capture, replies: Reply[]): FetchImpl {
	return async (input, init) => {
		const raw = init?.body;
		const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw ?? "{}");
		capture.bodies.push(JSON.parse(text) as MessageCreateParams);
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		capture.betaHeaders.push(headers.get("anthropic-beta") ?? "");
		const reply = replies[capture.bodies.length - 1];
		if (reply === undefined) throw new Error(`unexpected request #${capture.bodies.length}`);
		return reply.kind === "ok" ? success() : rejection(reply.message);
	};
}

function runTurn(replies: Reply[]): Promise<{ capture: Capture; message: AssistantMessage }> {
	const capture: Capture = { bodies: [], betaHeaders: [] };
	return streamAnthropic(MODEL, CONTEXT, {
		apiKey: "sk-ant-api-test",
		providerSessionState: new Map<string, ProviderSessionState>(),
		fetch: scriptedFetch(capture, replies),
	})
		.result()
		.then(message => ({ capture, message }));
}

/** 请求体里的全部工具变更块类型（`tool_addition` / `tool_removal`）。 */
function toolChangeBlocks(body: MessageCreateParams): string[] {
	const found: string[] = [];
	for (const message of body.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "tool_addition" || block.type === "tool_removal") found.push(block.type);
		}
	}
	return found;
}

function systemMessageCount(body: MessageCreateParams): number {
	return body.messages.filter(message => message.role === "system").length;
}

function deferredTools(body: MessageCreateParams): string[] {
	return (body.tools ?? []).filter(entry => entry.defer_loading === true).map(entry => entry.name);
}

withOfficialAnthropicEndpoint();

describe("Oryn tool-change fallback", () => {
	beforeEach(() => {
		clearToolChangeFallback();
	});

	it("fixture: the first request really carries a tool_addition for the newly active tool", async () => {
		expect(MODEL.compat.supportsMidConversationToolChanges).toBe(true);
		const { capture } = await runTurn([{ kind: "reject", message: TOOL_CHANGE_REFUSAL }, { kind: "ok" }]);

		const first = capture.bodies[0];
		expect(toolChangeBlocks(first)).toEqual(["tool_addition"]);
		expect(systemMessageCount(first)).toBe(1);
		expect(deferredTools(first)).toEqual(["extra"]);
		expect(capture.betaHeaders[0]).toContain(TOOL_CHANGES_BETA);
	});

	it("replays a tool-change 400 once without tool changes and completes the turn", async () => {
		const { capture, message } = await runTurn([{ kind: "reject", message: TOOL_CHANGE_REFUSAL }, { kind: "ok" }]);

		expect(capture.bodies).toHaveLength(2);
		const replay = capture.bodies[1];
		expect(systemMessageCount(replay)).toBe(0);
		expect(toolChangeBlocks(replay)).toEqual([]);
		expect(deferredTools(replay)).toEqual([]);
		expect((replay.tools ?? []).map(entry => entry.name)).toEqual(["lookup", "extra"]);
		expect(capture.betaHeaders[1]).not.toContain(TOOL_CHANGES_BETA);
		expect(message.stopReason).not.toBe("error");
		expect(message.errorMessage).toBeUndefined();
	});

	it("latches the endpoint after a successful replay", async () => {
		await runTurn([{ kind: "reject", message: TOOL_CHANGE_REFUSAL }, { kind: "ok" }]);

		const { capture, message } = await runTurn([{ kind: "ok" }]);

		expect(capture.bodies).toHaveLength(1);
		expect(toolChangeBlocks(capture.bodies[0])).toEqual([]);
		expect(systemMessageCount(capture.bodies[0])).toBe(0);
		expect(capture.betaHeaders[0]).not.toContain(TOOL_CHANGES_BETA);
		expect(message.stopReason).not.toBe("error");
	});

	it("surfaces an unrelated 400 untouched after a single request", async () => {
		const { capture, message } = await runTurn([{ kind: "reject", message: UNRELATED_REFUSAL }]);

		expect(capture.bodies).toHaveLength(1);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain(UNRELATED_REFUSAL);
	});

	it("does not latch when the replay fails too", async () => {
		const failed = await runTurn([
			{ kind: "reject", message: TOOL_CHANGE_REFUSAL },
			{ kind: "reject", message: TOOL_CHANGE_REFUSAL },
		]);

		expect(failed.capture.bodies).toHaveLength(2);
		expect(failed.message.stopReason).toBe("error");
		expect(failed.message.errorMessage).toContain("tool_addition");

		const next = await runTurn([{ kind: "reject", message: TOOL_CHANGE_REFUSAL }, { kind: "ok" }]);

		expect(toolChangeBlocks(next.capture.bodies[0])).toEqual(["tool_addition"]);
		expect(next.capture.betaHeaders[0]).toContain(TOOL_CHANGES_BETA);
		expect(next.message.stopReason).not.toBe("error");
	});
});

describe("isToolChangeRejection", () => {
	function failure(errorMessage: string, errorStatus?: number): AssistantMessage {
		return { ...previousReply(), stopReason: "error", errorMessage, errorStatus };
	}

	it("needs a 400 that names a tool-change block", () => {
		expect(isToolChangeRejection(failure(TOOL_CHANGE_REFUSAL, 400))).toBe(true);
		expect(isToolChangeRejection(failure(`400 ${TOOL_CHANGE_REFUSAL}`))).toBe(true);
		expect(isToolChangeRejection(failure("400 tool_reference_unresolved"))).toBe(true);
		expect(isToolChangeRejection(failure(UNRELATED_REFUSAL, 400))).toBe(false);
		expect(isToolChangeRejection(failure(TOOL_CHANGE_REFUSAL, 500))).toBe(false);
		expect(isToolChangeRejection({ ...previousReply(), errorMessage: TOOL_CHANGE_REFUSAL, errorStatus: 400 })).toBe(
			false,
		);
	});

	it("turns tool changes off through compat only", () => {
		const off = withoutMidConversationToolChanges(MODEL);
		expect(off.compat.supportsMidConversationToolChanges).toBe(false);
		expect(off.id).toBe(MODEL.id);
		expect(MODEL.compat.supportsMidConversationToolChanges).toBe(true);
	});
});
