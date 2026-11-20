/**
 * Oryn：RPC 下的下一条消息预测（`oryn_composer_prediction` 帧，见 ORYN.md「例外清单」）。
 * 控制器本身的请求 / 解析 / 记账由上游 `composer-prediction-controller.test.ts` 覆盖；这里只测 RPC 适配：
 * 哪些回合结束会发起预测、什么时候推帧、什么时候撤回。
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgComposerPredictions } from "@oh-my-pi/pi-coding-agent/modes/settings";
import {
	type OrynComposerPredictionFrame,
	OrynComposerPredictor,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/oryn-composer-prediction";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { EphemeralTurnOptions, EphemeralTurnResult } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const MODEL = { id: "claude-sonnet-4-5", provider: "anthropic", api: "anthropic-messages" } as Model;

function userMessage(content: string): Message {
	return { role: "user", content, timestamp: 1 } as Message;
}

function assistantMessage(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: { input: 10, output: 5 },
		stopReason,
		timestamp: 2,
	} as unknown as AssistantMessage;
}

function agentEnd(stopReason: AssistantMessage["stopReason"]): AgentSessionEvent {
	return { type: "agent_end", messages: [assistantMessage(stopReason)] };
}

/** 运行中途的循环停顿（排队消息、后台任务等会续跑）。 */
function agentPause(): AgentSessionEvent {
	return { type: "agent_pause", messages: [assistantMessage("stop")], yielded: true, awaiting: false };
}

function harness(options: { enabled?: boolean; retrying?: boolean } = {}) {
	const replies: Array<(replyText: string) => Promise<void>> = [];
	const frames: OrynComposerPredictionFrame[] = [];
	let frameArrived = Promise.withResolvers<void>();
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage(userMessage("fix the bug"));
	const messages: AgentMessage[] = [userMessage("fix the bug"), assistantMessage("stop")];
	// 不用 isolated 的覆盖层：覆盖层优先于 set()，测试里就关不掉设置了。
	const settings = Settings.isolated();
	cfgComposerPredictions.set(settings, options.enabled ?? true);
	const fake = {
		model: MODEL,
		settings,
		isStreaming: false,
		isCompacting: false,
		isRetrying: options.retrying ?? false,
		messages,
		sessionManager,
		ephemeralMaxTokensPreservesRequest: () => true,
		runEphemeralTurn(_turn: EphemeralTurnOptions): Promise<EphemeralTurnResult> {
			const { promise, resolve } = Promise.withResolvers<EphemeralTurnResult>();
			replies.push(async replyText => {
				resolve({ replyText, assistantMessage: assistantMessage("stop") });
				// 控制器在自己的 await 之后才给出预测。
				await promise;
				await Promise.resolve();
			});
			return promise;
		},
	};
	// 适配器只读这些成员；完整的 AgentSession 在单测里构造不出来。
	const session = fake as unknown as AgentSession;
	const predictor = new OrynComposerPredictor(session, frame => {
		frames.push(frame);
		frameArrived.resolve();
	});
	/** 下一帧推送；用于等设置监听这类异步触发。 */
	const nextFrame = () => {
		frameArrived = Promise.withResolvers<void>();
		return frameArrived.promise;
	};
	return { predictor, frames, replies, messages, settings, nextFrame };
}

describe("OrynComposerPredictor", () => {
	it("predicts after a completed turn and withdraws when the next turn starts", async () => {
		const { predictor, frames, replies } = harness();
		predictor.observe(agentEnd("stop"));
		expect(replies).toHaveLength(1);
		expect(frames).toEqual([]);

		await replies[0]!("now run the tests");
		expect(frames).toEqual([{ type: "oryn_composer_prediction", choices: ["now run the tests"] }]);

		predictor.observe({ type: "agent_start" } as AgentSessionEvent);
		expect(frames.at(-1)).toEqual({ type: "oryn_composer_prediction", choices: [] });
		expect(frames).toHaveLength(2);
	});

	it("does not predict after an aborted or failed turn, a paused run, a pending retry, or while disabled", () => {
		const cases = [
			[harness(), agentEnd("aborted")],
			[harness(), agentEnd("error")],
			[harness(), agentPause()],
			[harness({ retrying: true }), agentEnd("stop")],
			[harness({ enabled: false }), agentEnd("stop")],
		] as const;
		for (const [h, event] of cases) h.predictor.observe(event);

		expect(cases.map(([h]) => h.replies.length)).toEqual([0, 0, 0, 0, 0]);
	});

	it("pushes each change once and withdraws a prediction the conversation moved past", async () => {
		const { predictor, frames, replies, messages } = harness();
		predictor.observe(agentEnd("stop"));
		await replies[0]!("ship it");
		predictor.observe({ type: "turn_start" } as AgentSessionEvent);
		expect(frames).toHaveLength(1);

		messages.push(userMessage("something else"));
		predictor.observe({ type: "message_end", message: messages.at(-1) } as AgentSessionEvent);
		expect(frames).toEqual([
			{ type: "oryn_composer_prediction", choices: ["ship it"] },
			{ type: "oryn_composer_prediction", choices: [] },
		]);
	});

	it("withdraws the offered prediction when composer.predictions is turned off", async () => {
		const { predictor, frames, replies, settings, nextFrame } = harness();
		predictor.observe(agentEnd("stop"));
		await replies[0]!("ship it");

		const withdrawn = nextFrame();
		cfgComposerPredictions.set(settings, false);
		await withdrawn;

		expect(frames.at(-1)).toEqual({ type: "oryn_composer_prediction", choices: [] });
	});
});
