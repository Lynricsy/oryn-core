/**
 * Oryn：不经模型直接执行会话的内置工具（`oryn_tool_defs` / `oryn_tool_call` / `oryn_tool_cancel`）。
 *
 * Oryn 的全局助手在控制面沙箱里运行，它的「电脑」是一台普通 orb；orb 里常驻一个不调模型的 omp，
 * 由宿主经这三个命令遥控其内置工具。执行路径与 eval 的工具桥（`callSessionTool`）相同：
 * 按名字取工具、按工具自身的 schema 校验参数（去掉未声明的 intent 字段）、调用 `tool.execute`。
 * 工具运行中的部分结果以 `oryn_tool_update` 帧推送，每个调用每 250 毫秒至多一帧：窗口内只留最新一帧，
 * 调用结束时还没发出的那一帧丢弃，由最终结果取代。
 *
 * 错误约定：工具不存在、被拒、参数校验失败、`callId` 重复是 RPC 错误；工具执行时抛错仍是成功响应，
 * 结果为 `{content:[{type:"text", text}], isError:true}`，与 agent 循环把抛错变成工具错误一致。
 *
 * 三个命令都不排在串行命令队列后面（见 `rpc-mode.ts` 的 `BACKGROUND_COMMANDS`），因此多个调用可以并发，
 * 取消也能越过正在运行的调用。
 */
import {
	type AgentTool,
	type AgentToolContext,
	type AgentToolResult,
	validateAgentToolArguments,
} from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { isRecord } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { AgentSession } from "../../session/agent-session";
import { schemaDeclaresIntentField } from "../../utils/tool-schema";

/**
 * 不允许直接执行的工具：`checkpoint` / `rewind` 只在作为会话里的 toolResult 时生效；
 * `ask` 要等用户作答；`task` 派子 agent 要调模型；`todo`、`yield`、`goal` 改的是会话自己的状态。
 * 用 Set 而不是 Record：名字来自宿主输入，不能碰到原型上的键。
 */
export const ORYN_TOOL_EXEC_DENIED: ReadonlySet<string> = new Set([
	"checkpoint",
	"rewind",
	"ask",
	"task",
	"todo",
	"yield",
	"goal",
]);

/** 两次 `oryn_tool_update` 之间的最短间隔。 */
export const ORYN_TOOL_UPDATE_INTERVAL_MS = 250;

export interface OrynToolDef {
	name: string;
	description: string;
	parameters: unknown;
}

export interface OrynToolCallResult {
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
}

/** 工具运行中推送的部分结果。 */
export interface OrynToolUpdateFrame {
	type: "oryn_tool_update";
	callId: string;
	partialResult: OrynToolCallResult;
}

export type OrynToolExecRpcCommand =
	| { id?: string; type: "oryn_tool_defs"; names?: string[] }
	| { id?: string; type: "oryn_tool_call"; callId: string; toolName: string; arguments?: Record<string, unknown> }
	| { id?: string; type: "oryn_tool_cancel"; callId: string };

export type OrynToolExecRpcResponse =
	| { id?: string; type: "response"; command: "oryn_tool_defs"; success: true; data: { tools: OrynToolDef[] } }
	| { id?: string; type: "response"; command: "oryn_tool_call"; success: true; data: { result: OrynToolCallResult } }
	| { id?: string; type: "response"; command: "oryn_tool_cancel"; success: true; data: { cancelled: boolean } };

type ExecSession = Pick<
	AgentSession,
	| "getToolByName"
	| "getEnabledToolNames"
	| "sessionManager"
	| "modelRegistry"
	| "model"
	| "isStreaming"
	| "queuedMessageCount"
	| "settings"
>;

function toCallResult(result: AgentToolResult): OrynToolCallResult {
	const out: OrynToolCallResult = { content: result.content };
	if (result.details !== undefined) out.details = result.details;
	if (result.isError) out.isError = true;
	return out;
}

/** 一个 RPC 会话的工具执行器：持有在途调用，供取消使用。 */
export class OrynToolExecutor {
	readonly #session: ExecSession;
	readonly #emit: (frame: OrynToolUpdateFrame) => void;
	readonly #inflight = new Map<string, AbortController>();

	constructor(session: ExecSession, emit: (frame: OrynToolUpdateFrame) => void) {
		this.#session = session;
		this.#emit = emit;
	}

	/** `oryn_tool_defs`：按名字取工具定义；不存在或被拒的名字跳过。缺省返回当前启用的工具。 */
	defs(command: { names?: unknown }): { tools: OrynToolDef[] } {
		let names: string[];
		if (command.names === undefined) {
			names = this.#session.getEnabledToolNames();
		} else if (Array.isArray(command.names) && command.names.every(name => typeof name === "string")) {
			names = command.names;
		} else {
			throw new Error("oryn_tool_defs: names must be an array of strings");
		}
		const tools: OrynToolDef[] = [];
		const seen = new Set<string>();
		for (const name of names) {
			const tool = this.#session.getToolByName(name);
			if (!tool || ORYN_TOOL_EXEC_DENIED.has(tool.name) || seen.has(tool.name)) continue;
			seen.add(tool.name);
			tools.push({ name: tool.name, description: tool.description, parameters: toolWireSchema(tool) });
		}
		return { tools };
	}

	/** `oryn_tool_call`：执行一个工具直到结束；工具抛错时返回 `isError` 结果而不是 RPC 错误。 */
	async call(command: { callId?: unknown; toolName?: unknown; arguments?: unknown }): Promise<{
		result: OrynToolCallResult;
	}> {
		const { callId, toolName } = command;
		if (typeof callId !== "string" || !callId) throw new Error("oryn_tool_call requires a non-empty callId");
		if (typeof toolName !== "string" || !toolName) throw new Error("oryn_tool_call requires a non-empty toolName");
		if (this.#inflight.has(callId)) throw new Error(`oryn_tool_call: callId ${callId} is already running`);
		const tool = this.#resolve(toolName);
		const args = this.#validate(tool, callId, command.arguments ?? {});

		const controller = new AbortController();
		this.#inflight.set(callId, controller);
		const updates = new UpdateThrottle(partial =>
			this.#emit({ type: "oryn_tool_update", callId, partialResult: toCallResult(partial) }),
		);
		try {
			const result = await tool.execute(
				callId,
				args,
				controller.signal,
				partial => updates.push(partial),
				this.#context(controller),
			);
			return { result: toCallResult(result) };
		} catch (err) {
			const text = err instanceof Error ? err.message : String(err);
			return { result: { content: [{ type: "text", text: text || "Tool failed" }], isError: true } };
		} finally {
			updates.close();
			this.#inflight.delete(callId);
		}
	}

	/** `oryn_tool_cancel`：中止一个在途调用；调用不存在（已结束或从未开始）时返回 false。 */
	cancel(command: { callId?: unknown }): { cancelled: boolean } {
		if (typeof command.callId !== "string" || !command.callId) {
			throw new Error("oryn_tool_cancel requires a non-empty callId");
		}
		const controller = this.#inflight.get(command.callId);
		if (!controller || controller.signal.aborted) return { cancelled: false };
		controller.abort(new Error("Cancelled by host"));
		return { cancelled: true };
	}

	#resolve(name: string): AgentTool {
		const tool = this.#session.getToolByName(name);
		if (!tool) throw new Error(`Unknown tool: ${name}`);
		if (ORYN_TOOL_EXEC_DENIED.has(tool.name)) throw new Error(`Tool ${tool.name} cannot run through oryn_tool_call`);
		return tool;
	}

	#validate(tool: AgentTool, callId: string, args: unknown): unknown {
		if (!isRecord(args)) throw new Error("oryn_tool_call: arguments must be an object");
		// 与 eval 工具桥一致：工具没有声明 intent 字段时去掉它，工具在两条入口看到的参数相同。
		const validationArgs = { ...args };
		if (!schemaDeclaresIntentField(toolWireSchema(tool))) delete validationArgs[INTENT_FIELD];
		return validateAgentToolArguments(
			tool,
			{ type: "toolCall", id: callId, name: tool.name, arguments: validationArgs },
			"payload",
		);
	}

	/** 直接调用不属于任何回合：没有 UI，`abort` 只中止本次调用。 */
	#context(controller: AbortController): AgentToolContext {
		const session = this.#session;
		return {
			sessionManager: session.sessionManager,
			modelRegistry: session.modelRegistry,
			model: session.model,
			isIdle: () => !session.isStreaming,
			hasQueuedMessages: () => session.queuedMessageCount > 0,
			abort: () => controller.abort(new Error("Aborted by tool")),
			settings: session.settings,
			hasUI: false,
			toolNames: session.getEnabledToolNames(),
		};
	}
}

/** 部分结果节流：窗口内只保留最新一帧，窗口结束时发出；`close` 之后丢弃未发出的帧。 */
class UpdateThrottle {
	readonly #send: (partial: AgentToolResult) => void;
	#last = 0;
	#pending: AgentToolResult | undefined;
	#timer: NodeJS.Timeout | undefined;
	#closed = false;

	constructor(send: (partial: AgentToolResult) => void) {
		this.#send = send;
	}

	push(partial: AgentToolResult): void {
		if (this.#closed) return;
		const wait = this.#last + ORYN_TOOL_UPDATE_INTERVAL_MS - Date.now();
		if (wait <= 0 && !this.#timer) {
			this.#fire(partial);
			return;
		}
		this.#pending = partial;
		this.#timer ??= setTimeout(
			() => {
				this.#timer = undefined;
				const next = this.#pending;
				this.#pending = undefined;
				if (next && !this.#closed) this.#fire(next);
			},
			Math.max(wait, 0),
		);
	}

	close(): void {
		this.#closed = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#pending = undefined;
	}

	#fire(partial: AgentToolResult): void {
		this.#last = Date.now();
		this.#send(partial);
	}
}
