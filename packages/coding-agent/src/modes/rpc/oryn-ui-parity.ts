/**
 * Oryn：RPC 下与 TUI 对齐的几处命令行为（loop 捕获、计划模式互斥、取消后台任务）。
 *
 * - loop：TUI 在 loop 开启时把用户空闲时提交的下一条 prompt 记为循环 prompt
 *   （`input-controller` 的 `setLoopPrompt`）；RPC 的 `prompt` 命令要做同样的判定。
 * - 计划模式：TUI `handlePlanModeCommand` 在 goal（含暂停）或 vibe 开着时拒绝进入，
 *   文案与 RPC `set_vibe_mode` 的同类拒绝一致。
 * - `oryn_cancel_job`：`/jobs kill <id>` 的结构化版本，走同一个按归属限定的
 *   `AgentSession.cancelAsyncJob`。
 */
import { isTuiOnlyBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import type { AgentSession } from "../../session/agent-session";

export type OrynUiParityRpcCommand = { id?: string; type: "oryn_cancel_job"; jobId: string };

export interface OrynCancelJobResult {
	/** 只有本会话拥有、仍在运行的任务才会被取消；其它情况（不存在、已结束、属于子 agent）为 false。 */
	cancelled: boolean;
}

export type OrynUiParityRpcResponse = {
	id?: string;
	type: "response";
	command: "oryn_cancel_job";
	success: true;
	data: OrynCancelJobResult;
};

/**
 * `prompt` 命令里，内置命令处理完、即将交给 `session.prompt` 的文本是否成为循环 prompt。
 * 与 TUI 一致：只在空闲时（流式中提交的是引导消息，不改循环 prompt）；扩展命令在本地执行、
 * 不发给模型，不算；只有 TUI 能执行的内置命令在 TUI 里会被消费，也不算。
 * skill 命令不走这里：TUI 不论是否流式都记录，调用方在派发 skill 前单独处理。
 */
export function isOrynLoopPromptCandidate(
	session: Pick<AgentSession, "isStreaming" | "extensionRunner">,
	text: string,
): boolean {
	if (session.isStreaming || !text.trim()) return false;
	if (text.startsWith("/")) {
		const space = text.indexOf(" ");
		const name = space === -1 ? text.slice(1) : text.slice(1, space);
		if (session.extensionRunner?.getCommand(name) !== undefined) return false;
		if (isTuiOnlyBuiltinSlashCommand(text)) return false;
	}
	return true;
}

/** 进入计划模式前的互斥检查；可以进入时返回 `undefined`。 */
export function orynPlanModeConflict(
	session: Pick<AgentSession, "getGoalModeState" | "getVibeModeState">,
): string | undefined {
	const goalState = session.getGoalModeState();
	if (goalState?.enabled || goalState?.goal.status === "paused") return "Exit goal mode first.";
	if (session.getVibeModeState()?.enabled) return "Exit vibe mode first.";
	return undefined;
}

/** `oryn_cancel_job`：取消一个本会话拥有的运行中后台任务。 */
export function handleOrynCancelJob(
	session: Pick<AgentSession, "getAsyncJobSnapshot" | "cancelAsyncJob">,
	command: { jobId?: unknown },
): OrynCancelJobResult {
	if (typeof command.jobId !== "string" || !command.jobId.trim()) {
		throw new Error("oryn_cancel_job requires a non-empty jobId");
	}
	if (!session.getAsyncJobSnapshot({ recentLimit: 0 })) {
		throw new Error("Async background jobs are unavailable in this session.");
	}
	return { cancelled: session.cancelAsyncJob(command.jobId) };
}
