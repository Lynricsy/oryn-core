/**
 * Oryn：端点拒绝「对话中途的工具变更」时降级。
 *
 * compat 打开 `supportsMidConversationToolChanges` 的模型会保持顶层 `tools` 字节稳定，
 * 活动工具集的变化改用 `tool_addition` / `tool_removal` 系统块声明。部分 Anthropic 兼容
 * 网关只改写 `tools[]` 里的工具名、不改写这些块，请求于是 400
 * （`tool_addition/tool_removal references unknown tool 'x'`）。400 对所有重试闸门都是终态，
 * 重放又是同一个请求体，线程会一直报错直到工具集变回去。
 *
 * 这里把这种拒绝改为关掉工具变更（普通顶层 `tools`、无控制块、不带 beta）重放一次；
 * 重放正常结束后，本进程内对该端点闩锁，之后的请求直接跳过会失败的那一次。
 * 误判的 400 只多花一次请求，且不会闩锁。
 *
 * 独立成文件，上游 provider 只多一处包裹表达式（见 ORYN.md 例外清单）。
 */
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";

type Attempt<O> = (model: Model<"anthropic-messages">, context: Context, options?: O) => AssistantMessageEventStream;

export const TOOL_CHANGE_REJECTION_PATTERN = /tool_addition|tool_removal|tool_reference_unresolved/;

/** 拒绝过工具变更、且关掉后重放成功的端点（provider、baseUrl、模型 id）。 */
const latchedEndpoints = new Set<string>();

function endpointKey(model: Model<"anthropic-messages">): string {
	return `${model.provider}\u0000${model.baseUrl ?? ""}\u0000${model.id}`;
}

/** 终止错误是否为拒绝 `tool_addition` / `tool_removal` 块的 HTTP 400。 */
export function isToolChangeRejection(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	const text = message.errorMessage ?? "";
	if (message.errorStatus !== 400 && !text.startsWith("400")) return false;
	return TOOL_CHANGE_REJECTION_PATTERN.test(text);
}

/** 经 compat 关掉对话中途工具变更的同一模型。 */
export function withoutMidConversationToolChanges(model: Model<"anthropic-messages">): Model<"anthropic-messages"> {
	return {
		...model,
		compat: {
			...model.compat,
			supportsMidConversationToolChanges: false,
		},
	};
}

/**
 * 包裹单次 provider 尝试：在任何输出之前到达的工具变更 400，换成一次关掉工具变更的重放。
 * 只扣住 `start` 事件；第一个其它事件即提交本次尝试并改为实时透传。
 */
export function withToolChangeFallback<O>(attempt: Attempt<O>): Attempt<O> {
	return (model, context, options) => {
		if (model.compat.supportsMidConversationToolChanges !== true) return attempt(model, context, options);
		const key = endpointKey(model);
		if (latchedEndpoints.has(key)) return attempt(withoutMidConversationToolChanges(model), context, options);

		const outer = new AssistantMessageEventStream();
		void (async () => {
			const buffered: AssistantMessageEvent[] = [];
			let committed = false;
			let terminal: AssistantMessageEvent | undefined;
			const flush = (): void => {
				for (const event of buffered) outer.push(event);
				buffered.length = 0;
			};
			let inner: AssistantMessageEventStream;
			try {
				inner = attempt(model, context, options);
				for await (const event of inner) {
					if (event.type === "done" || event.type === "error") {
						terminal = event;
						break;
					}
					if (!committed && event.type === "start") {
						buffered.push(event);
						continue;
					}
					committed = true;
					flush();
					outer.push(event);
					if (outer.done) return;
				}
			} catch (error) {
				flush();
				outer.fail(error);
				return;
			}

			if (!committed && terminal?.type === "error" && isToolChangeRejection(terminal.error)) {
				buffered.length = 0;
				try {
					const replay = attempt(withoutMidConversationToolChanges(model), context, options);
					for await (const event of replay) {
						// 先闩锁再投递 `done`：等 `result()` 的调用方可能立刻发下一次请求。
						if (event.type === "done") latchedEndpoints.add(key);
						outer.push(event);
						if (outer.done) return;
					}
					if (!outer.done) outer.end(await replay.result());
				} catch (error) {
					outer.fail(error);
				}
				return;
			}

			flush();
			if (terminal) {
				outer.push(terminal);
			} else if (!outer.done) {
				try {
					outer.end(await inner.result());
				} catch (error) {
					outer.fail(error);
				}
			}
		})();
		return outer;
	};
}

/** 仅测试：清空闩锁。 */
export function clearToolChangeFallback(): void {
	latchedEndpoints.clear();
}
