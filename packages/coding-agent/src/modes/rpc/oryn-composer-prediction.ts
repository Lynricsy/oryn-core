/**
 * Oryn：RPC 下的「下一条消息预测」（`composer.predictions`）。
 *
 * TUI 在回合正常结束后用 `ComposerPredictionController` 跑一次旁路请求，预测用户下一条消息并作为
 * 空输入框里的幽灵文本显示。RPC 模式上游没有接这个控制器；这里复用同一个控制器（请求、截止时间、
 * 用量记账、指标、过期判定都与 TUI 一致），只把它的「重绘」换成向宿主推送 `oryn_composer_prediction` 帧：
 * 每当当前可用的预测变化（出现、被新回合 / 压缩 / 关闭设置撤回、对话推进而过期）就推一帧完整的 `choices`，
 * 空数组表示撤回。
 *
 * 与 TUI 的差别：服务端看不到宿主的草稿，所以「输入框里已有草稿就不请求」这一条由宿主承担——
 * 宿主只在草稿是某个预测的前缀时显示它。
 */
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { ComposerPredictionController } from "../controllers/composer-prediction-controller";
import { cfgComposerPredictionAlternatives, cfgComposerPredictions } from "../settings";

/** 预测变化时推送的帧；`choices` 按可能性从高到低，空数组表示当前没有预测。 */
export interface OrynComposerPredictionFrame {
	type: "oryn_composer_prediction";
	choices: string[];
}

type PredictionContext = ConstructorParameters<typeof ComposerPredictionController>[0];

/** 回合结束的事件里，最后一条助手消息正常结束（不是出错、不是被中止）才算完成，与 TUI `#settledRunStatus` 的 `done` 一致。 */
function completedRun(event: Extract<AgentSessionEvent, { type: "agent_end" }>): boolean {
	for (let i = event.messages.length - 1; i >= 0; i--) {
		const message = event.messages[i];
		if (message.role !== "assistant") continue;
		return message.stopReason !== "error" && message.stopReason !== "aborted";
	}
	return false;
}

/** 一个 RPC 会话的下一条消息预测：观察会话事件发起 / 撤回预测，并把变化推给宿主。 */
export class OrynComposerPredictor {
	readonly #session: AgentSession;
	readonly #emit: (frame: OrynComposerPredictionFrame) => void;
	readonly #controller: ComposerPredictionController;
	/** 最后一次推给宿主的预测，用来去掉重复帧。 */
	#emitted: readonly string[] = [];

	constructor(
		session: AgentSession,
		emit: (frame: OrynComposerPredictionFrame) => void,
		options: ConstructorParameters<typeof ComposerPredictionController>[1] = {},
	) {
		this.#session = session;
		this.#emit = emit;
		// 控制器只用到 TUI 上下文里的这几项：草稿（RPC 下由宿主判断，这里视为空）与重绘通知（换成推送）。
		// 编辑器与 TUI 的其余成员控制器不会读到，结构上无法满足，只能整体断言。
		const context = {
			settings: session.settings,
			viewSession: session,
			focusedAgentId: undefined,
			editor: { getText: () => "" },
			ui: { requestRender: () => this.sync() },
		} as unknown as PredictionContext;
		this.#controller = new ComposerPredictionController(context, options);
		// 设置与会话同寿命，监听不需要退订。
		cfgComposerPredictions.listen(session, enabled => {
			if (!enabled) this.#controller.cancel();
		});
		// 已给出的多条候选在关掉候选设置后不该留到下一回合，与 TUI 一致。
		cfgComposerPredictionAlternatives.listen(session, enabled => {
			if (!enabled && (this.#controller.choices?.length ?? 0) > 1) this.#controller.cancel();
		});
	}

	/** 主会话的每个事件都交给这里。 */
	observe(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
			case "auto_compaction_start":
				this.#controller.cancel();
				break;
			case "agent_end":
				// 非终结的 agent_end 后面紧跟排队消息的续跑；自动重试还没开始时也会先收到 agent_end。
				// 两者都不算完成，与 TUI 的 retryPending 一致。
				if (event.isTerminal !== false && completedRun(event) && !this.#session.isRetrying) {
					this.#controller.request();
				}
				break;
		}
		// 对话推进（新消息）会让已推送的预测过期，即使控制器没有重绘。
		this.sync();
	}

	/**
	 * 把当前可用的预测与上次推送的比对，变了就推一帧。会话事件之外改动上下文的命令（`clear_context`、
	 * `navigate_tree`、`switch_leaf`、`compact`、`handoff` 等不一定发会话事件）也要在完成后调这里，
	 * 让已过期的预测被撤回。
	 */
	sync(): void {
		const choices = this.#controller.choices ?? [];
		const emitted = this.#emitted;
		if (choices.length === emitted.length && choices.every((choice, i) => choice === emitted[i])) return;
		this.#emitted = [...choices];
		this.#emit({ type: "oryn_composer_prediction", choices: [...choices] });
	}
}
