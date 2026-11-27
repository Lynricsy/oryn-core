/**
 * Oryn: a tool result with `details.orynEndTurn: true` ends the turn once its
 * tool batch has finished — no further model request, and the run settles like
 * a normal end of turn (no aborted assistant message).
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcHostToolBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-tools";
import type { RpcHostToolCallRequest, RpcHostToolCancelRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const viewSchema = type({ endTurn: "boolean", "fail?": "boolean" });
const slowSchema = type({ value: "string" });

const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.keys.setRuntime("mock", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);
afterAll(() => sharedAuthStorage.close());

const viewTool: AgentTool<typeof viewSchema> = {
	name: "render_ui",
	label: "Render UI",
	description: "Render a view",
	parameters: viewSchema,
	async execute(_toolCallId, params) {
		const details = params.endTurn ? { view: "v1", orynEndTurn: true } : { view: "v1" };
		if (params.fail) return { content: [{ type: "text", text: "render failed" }], details, isError: true };
		return { content: [{ type: "text", text: "rendered" }], details };
	},
};

function viewCall(id: string, args: { endTurn: boolean; fail?: boolean }): MockResponse {
	return { content: [{ type: "toolCall", id, name: "render_ui", arguments: args }], stopReason: "toolUse" };
}

function textStop(text: string): MockResponse {
	return { content: [text], stopReason: "stop" };
}

type Harness = { session: AgentSession; mock: MockModel; tempDir: TempDir; events: AgentEvent[] };
const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.dispose();
		harness.tempDir.removeSync();
	}
});

function createHarness(responses: MockResponse[], tools: AgentTool[] = [viewTool]): Harness {
	const tempDir = TempDir.createSync("@oryn-end-turn-");
	const mock = createMockModel({ responses });
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry: sharedModelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	const events: AgentEvent[] = [];
	agent.subscribe(event => {
		events.push(event);
	});
	const harness = { session, mock, tempDir, events };
	harnesses.push(harness);
	return harness;
}

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

function assistants(messages: AgentMessage[]): AssistantMessage[] {
	return messages.filter((message): message is AssistantMessage => message.role === "assistant");
}

function toolResults(messages: AgentMessage[]): ToolResultMessage[] {
	return messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

async function run(harness: Harness, text: string): Promise<void> {
	await harness.session.prompt(text);
	await harness.session.waitForIdle();
}

function expectEndedAtView(harness: Harness): void {
	const messages = harness.session.agent.state.messages;
	expect(harness.mock.calls).toHaveLength(1);
	const replies = assistants(messages);
	expect(replies).toHaveLength(1);
	expect(replies[0]?.stopReason).toBe("toolUse");
	expect(messages.at(-1)?.role).toBe("toolResult");
	expect(harness.events.filter(event => event.type === "agent_end")).toHaveLength(1);
	const turnEnds = harness.events.filter(
		(event): event is Extract<AgentEvent, { type: "turn_end" }> => event.type === "turn_end",
	);
	expect(turnEnds.every(event => event.message.role !== "assistant" || event.message.stopReason !== "aborted")).toBe(
		true,
	);
}

describe("Oryn end-turn tool results", () => {
	it("ends the turn after a view marked orynEndTurn without asking the model again", async () => {
		const harness = createHarness([viewCall("call-view", { endTurn: true }), textStop("should not be requested")]);
		await run(harness, "show me");

		expectEndedAtView(harness);
		const [result] = toolResults(harness.session.agent.state.messages);
		expect(result?.isError).toBe(false);
		expect(result?.details).toMatchObject({ orynEndTurn: true });
	});

	it("asks the model again when the view does not end the turn", async () => {
		const harness = createHarness([viewCall("call-view", { endTurn: false }), textStop("done")]);
		await run(harness, "show me");

		expect(harness.mock.calls).toHaveLength(2);
		const replies = assistants(harness.session.agent.state.messages);
		expect(replies.at(-1)?.stopReason).toBe("stop");
	});

	it("does not end the turn on an error result", async () => {
		const harness = createHarness([viewCall("call-view", { endTurn: true, fail: true }), textStop("recovered")]);
		await run(harness, "show me");

		expect(harness.mock.calls).toHaveLength(2);
		const [result] = toolResults(harness.session.agent.state.messages);
		expect(result?.isError).toBe(true);
	});

	it("finishes the whole tool batch before stopping", async () => {
		// The sibling only completes after the view's result is in, so stopping the run at the
		// view (instead of after the batch) would abort it.
		const viewDone = Promise.withResolvers<void>();
		const slowTool: AgentTool<typeof slowSchema> = {
			name: "slow_record",
			label: "Slow Record",
			description: "Record a value after the view finished",
			parameters: slowSchema,
			async execute(_toolCallId, params, signal) {
				await viewDone.promise;
				await Promise.resolve();
				if (signal?.aborted) throw new Error("aborted");
				return { content: [{ type: "text", text: `recorded:${params.value}` }], details: { value: params.value } };
			},
		};
		const harness = createHarness(
			[
				{
					content: [
						{ type: "toolCall", id: "call-view", name: "render_ui", arguments: { endTurn: true } },
						{ type: "toolCall", id: "call-slow", name: "slow_record", arguments: { value: "kept" } },
					],
					stopReason: "toolUse",
				},
				textStop("should not be requested"),
			],
			[viewTool, slowTool as AgentTool],
		);
		harness.session.agent.subscribe(event => {
			if (event.type === "tool_execution_end" && event.toolName === "render_ui") viewDone.resolve();
		});
		await run(harness, "show and record");

		expectEndedAtView(harness);
		const results = toolResults(harness.session.agent.state.messages);
		expect(results.map(result => [result.toolName, result.isError])).toEqual([
			["render_ui", false],
			["slow_record", false],
		]);
		expect(results[1]?.content).toEqual([{ type: "text", text: "recorded:kept" }]);
	});

	it("answers the next prompt normally", async () => {
		const harness = createHarness([viewCall("call-view", { endTurn: true }), textStop("second answer")]);
		await run(harness, "show me");
		expect(harness.mock.calls).toHaveLength(1);

		await run(harness, "thanks");
		expect(harness.mock.calls).toHaveLength(2);
		expect(assistants(harness.session.agent.state.messages).at(-1)?.stopReason).toBe("stop");
	});

	it("keeps orynEndTurn from an RPC host tool result", async () => {
		const frames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const bridge: RpcHostToolBridge = new RpcHostToolBridge(frame => {
			frames.push(frame);
			if (frame.type !== "host_tool_call") return;
			queueMicrotask(() =>
				bridge.handleResult({
					type: "host_tool_result",
					id: frame.id,
					result: { content: [{ type: "text", text: "host rendered" }], details: { orynEndTurn: true } },
				}),
			);
		});
		const [hostView] = bridge.setTools([
			{
				name: "host_render_ui",
				description: "Render a view in the host",
				parameters: { type: "object", properties: {}, additionalProperties: false },
			},
		]);
		const harness = createHarness(
			[
				{
					content: [{ type: "toolCall", id: "call-host", name: "host_render_ui", arguments: {} }],
					stopReason: "toolUse",
				},
				textStop("should not be requested"),
			],
			[hostView as AgentTool],
		);
		await run(harness, "show me from the host");

		expect(frames.map(frame => frame.type)).toEqual(["host_tool_call"]);
		expectEndedAtView(harness);
		const [result] = toolResults(harness.session.agent.state.messages);
		expect(result?.details).toEqual({ orynEndTurn: true });
	});
});
