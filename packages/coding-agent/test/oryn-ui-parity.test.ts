/**
 * Oryn UI-command parity over RPC (see ORYN.md「例外清单」): loop prompt capture on `prompt`,
 * `/omfg` rule preview, `oryn_cancel_job`, `textModeExecutable` on available commands,
 * `set_plan_mode` goal/vibe exclusion, and the `mounted` flag on `get_active_tools`.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { OrynCancelJobResult } from "@oh-my-pi/pi-coding-agent/modes/rpc/oryn-ui-parity";
import { buildRpcActiveTools } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-reports";
import { RPC_OMFG_UI_KEY, runRpcOmfg } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-omfg";
import type {
	RpcActiveToolsResult,
	RpcAvailableSlashCommand,
	RpcJobsResult,
	RpcLoopModeState,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";

interface Frame {
	type: string;
	id?: string;
	command?: string;
	success?: boolean;
	error?: string;
	data?: unknown;
	[key: string]: unknown;
}

const FIXTURE = path.join(import.meta.dir, "fixtures", "oryn-ui-parity-rpc-agent.ts");

/** Line-level driver for the fixture: every stdout frame is kept so tests can assert on pushes, not just responses. */
class FixtureRpc {
	readonly frames: Frame[] = [];
	readonly #child: ReturnType<typeof Bun.spawn>;
	#waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
	#nextId = 0;

	constructor(cwd: string, env: Record<string, string>) {
		this.#child = Bun.spawn([process.execPath, FIXTURE], {
			cwd,
			env: { ...Bun.env, PI_CODING_AGENT_DIR: cwd, PI_NO_TITLE: "1", PI_NO_PTY: "1", ...env },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
		});
		void this.#read(this.#child.stdout as ReadableStream<Uint8Array>);
	}

	async #read(stdout: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line.startsWith("{")) continue;
				const frame = JSON.parse(line) as Frame;
				this.frames.push(frame);
				this.#waiters = this.#waiters.filter(waiter => {
					if (!waiter.match(frame)) return true;
					waiter.resolve(frame);
					return false;
				});
			}
		}
	}

	waitFor(match: (frame: Frame) => boolean, timeoutMs = 30_000): Promise<Frame> {
		const seen = this.frames.find(match);
		if (seen) return Promise.resolve(seen);
		const { promise, resolve } = Promise.withResolvers<Frame>();
		this.#waiters.push({ match, resolve });
		return withTimeout(promise, timeoutMs, "timed out waiting for an RPC frame");
	}

	async send(command: Record<string, unknown>): Promise<Frame> {
		const id = `t${this.#nextId++}`;
		const stdin = this.#child.stdin;
		if (!stdin || typeof stdin === "number") throw new Error("expected piped stdin");
		stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		await stdin.flush();
		return this.waitFor(frame => frame.type === "response" && frame.id === id);
	}

	async data<T = unknown>(command: Record<string, unknown>): Promise<T> {
		const response = await this.send(command);
		if (!response.success) throw new Error(`${String(command.type)} failed: ${response.error}`);
		return response.data as T;
	}

	stop(): void {
		this.#child.kill();
	}
}

let rpc: FixtureRpc | undefined;
const directories: string[] = [];

async function start(env: Record<string, string> = {}): Promise<FixtureRpc> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oryn-ui-parity-"));
	directories.push(directory);
	rpc = new FixtureRpc(directory, env);
	return rpc;
}

beforeAll(async () => {
	await initTheme();
});

afterEach(async () => {
	rpc?.stop();
	rpc = undefined;
	for (const directory of directories.splice(0)) await removeWithRetries(directory);
});

function userTexts(messages: AgentMessage[]): string[] {
	return messages.flatMap(message => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		return message.content.flatMap(part => (part.type === "text" ? [part.text] : []));
	});
}

/** 发给模型的消息形状：user 取正文，custom 取 customType，其余只记角色。 */
function messageShapes(messages: AgentMessage[]): string[] {
	return messages.map(message => {
		if (message.role === "user") return `user:${userTexts([message]).join("")}`;
		if (message.role === "custom") return `custom:${message.customType}`;
		return message.role;
	});
}

/** 等 loop 关闭（次数耗尽），再取当前会话的消息形状。 */
async function shapesAfterLoopOff(client: FixtureRpc): Promise<string[]> {
	await client.waitFor(
		frame => frame.type === "loop_mode_update" && (frame.state as RpcLoopModeState).state === "off",
	);
	const { messages } = await client.data<{ messages: AgentMessage[] }>({ type: "get_messages" });
	return messageShapes(messages);
}

describe("loop mode over RPC", () => {
	test("the next idle prompt after enabling becomes the loop prompt and re-runs", async () => {
		const client = await start();
		const enabled = await client.data<RpcLoopModeState>({ type: "set_loop_mode", enabled: true, args: "1" });
		expect(enabled.state).toBe("waiting");

		// A local extension command never reaches the model, so it does not arm the loop (TUI parity).
		await client.data({ type: "prompt", message: "/oryntest-noop" });
		expect((await client.data<RpcLoopModeState>({ type: "get_loop_mode" })).state).toBe("waiting");

		await client.data({ type: "prompt", message: "say hi" });
		await client.waitFor(
			frame =>
				frame.type === "loop_mode_update" &&
				(frame.state as RpcLoopModeState).state === "running" &&
				(frame.state as RpcLoopModeState).prompt === "say hi",
		);
		// "1" allows one re-run after the user's turn, then the loop turns itself off.
		await client.waitFor(
			frame => frame.type === "loop_mode_update" && (frame.state as RpcLoopModeState).state === "off",
		);
		const { messages } = await client.data<{ messages: AgentMessage[] }>({ type: "get_messages" });
		expect(userTexts(messages)).toEqual(["say hi", "say hi"]);
	}, 60_000);

	test("a skill command sent in loop mode becomes the loop prompt and every iteration re-runs the skill", async () => {
		const client = await start();
		await client.data({ type: "set_loop_mode", enabled: true, args: "1" });
		await client.data({ type: "prompt", message: "/skill:hello" });
		await client.waitFor(
			frame =>
				frame.type === "loop_mode_update" &&
				(frame.state as RpcLoopModeState).state === "running" &&
				(frame.state as RpcLoopModeState).prompt === "/skill:hello",
		);
		// 第 2 轮必须重新走 skill 派发，而不是把 `/skill:hello` 当普通文本发给模型。
		expect(await shapesAfterLoopOff(client)).toEqual([
			"custom:skill-prompt",
			"assistant",
			"custom:skill-prompt",
			"assistant",
		]);
	}, 60_000);

	test("an inline skill prompt in set_loop_mode args runs the skill on every iteration", async () => {
		const client = await start();
		await client.data({ type: "set_loop_mode", enabled: true, args: "1 /skill:hello" });
		expect(await shapesAfterLoopOff(client)).toEqual([
			"custom:skill-prompt",
			"assistant",
			"custom:skill-prompt",
			"assistant",
		]);
	}, 60_000);

	test("loop.mode=reset re-runs the skill in the fresh session", async () => {
		const client = await start({ ORYN_LOOP_MODE: "reset" });
		await client.data({ type: "set_loop_mode", enabled: true, args: "1" });
		await client.data({ type: "prompt", message: "/skill:hello" });
		// reset 后的新会话里只有这一轮：skill 指令，不是字面 `/skill:hello`。
		expect(await shapesAfterLoopOff(client)).toEqual(["custom:skill-prompt", "assistant"]);
	}, 60_000);

	test("a skill submitted while streaming becomes the loop prompt and the iteration re-runs the skill", async () => {
		const client = await start({ ORYN_RPC_HOLD_FIRST_TURN: "1" });
		await client.data({ type: "set_loop_mode", enabled: true, args: "1" });
		await client.data({ type: "prompt", message: "say hi" });
		// 首个模型回合被夹具挂住，此时提交的 skill 是流式中的引导消息。
		await client.waitFor(frame => frame.type === "agent_start");
		await client.data({ type: "prompt", message: "/skill:hello" });
		expect((await client.data<RpcLoopModeState>({ type: "get_loop_mode" })).prompt).toBe("/skill:hello");
		await client.data({ type: "prompt", message: "/oryntest-release" });
		expect(await shapesAfterLoopOff(client)).toEqual([
			"user:say hi",
			"assistant",
			"custom:skill-prompt",
			"assistant",
			"custom:skill-prompt",
			"assistant",
		]);
	}, 60_000);
});

describe("set_plan_mode exclusion", () => {
	test("refuses to arm plan mode while vibe mode is on", async () => {
		const client = await start();
		await client.data({ type: "set_vibe_mode", enabled: true });
		const refused = await client.send({ type: "set_plan_mode", enabled: true });
		expect(refused).toMatchObject({ success: false, error: "Exit vibe mode first." });
		expect((await client.data<{ planModeEnabled: boolean }>({ type: "get_state" })).planModeEnabled).toBe(false);
		// Disarming stays legal.
		expect((await client.send({ type: "set_plan_mode", enabled: false })).success).toBe(true);

		await client.data({ type: "set_vibe_mode", enabled: false });
		expect(await client.data({ type: "set_plan_mode", enabled: true })).toMatchObject({ enabled: true });
	}, 60_000);

	test("refuses to arm plan mode while a goal is active or paused", async () => {
		const client = await start();
		await client.data({ type: "set_goal", objective: "ship it" });
		expect(await client.send({ type: "set_plan_mode", enabled: true })).toMatchObject({
			success: false,
			error: "Exit goal mode first.",
		});
		await client.data({ type: "set_goal", action: "pause" });
		expect(await client.send({ type: "set_plan_mode", enabled: true })).toMatchObject({
			success: false,
			error: "Exit goal mode first.",
		});
		await client.data({ type: "set_goal", action: "drop" });
		expect(await client.data({ type: "set_plan_mode", enabled: true })).toMatchObject({ enabled: true });
	}, 60_000);
});

describe("oryn_cancel_job", () => {
	test("cancels only running jobs this session owns; get_jobs marks them cancellable", async () => {
		const client = await start({ ORYN_RPC_JOBS: "1" });
		const before = await client.data<RpcJobsResult>({ type: "get_jobs" });
		const ownRow = before.tree?.find(row => row.job?.id === "own-job");
		expect(ownRow).toMatchObject({ depth: 0, cancellable: true });
		expect(ownRow?.job).toMatchObject({ status: "running", label: "sleep forever" });
		expect(typeof ownRow?.job?.startTime).toBe("number");
		expect(before.tree?.find(row => row.job?.id === "foreign-job")?.cancellable).toBeUndefined();

		expect(await client.send({ type: "oryn_cancel_job", jobId: "" })).toMatchObject({
			success: false,
			error: "oryn_cancel_job requires a non-empty jobId",
		});
		const cancel = (jobId: string) => client.data<OrynCancelJobResult>({ type: "oryn_cancel_job", jobId });
		expect(await cancel("foreign-job")).toEqual({ cancelled: false });
		expect(await cancel("no-such-job")).toEqual({ cancelled: false });
		expect(await cancel("own-job")).toEqual({ cancelled: true });
		expect(await cancel("own-job")).toEqual({ cancelled: false });

		const after = await client.data<RpcJobsResult>({ type: "get_jobs" });
		const cancelledRow = after.tree?.find(row => row.job?.id === "own-job");
		expect(cancelledRow?.job?.status).toBe("cancelled");
		expect(cancelledRow?.cancellable).toBeUndefined();
	}, 60_000);
});

describe("get_available_commands", () => {
	test("declares textModeExecutable: false on TUI-only builtins", async () => {
		const client = await start();
		const { commands } = await client.data<{ commands: RpcAvailableSlashCommand[] }>({
			type: "get_available_commands",
		});
		expect(commands.find(command => command.name === "hotkeys")?.textModeExecutable).toBe(false);
		expect(commands.find(command => command.name === "compact")?.textModeExecutable).toBe(true);
	}, 60_000);
});

describe("get_active_tools", () => {
	test("flags xd:// mounted entries and leaves top-level tools unflagged", () => {
		const session = {
			agent: { state: { tools: [{ name: "read", description: "Read files" }] } },
			hasBuiltInTool: (name: string) => name === "read",
			getXdevToolEntries: () => [{ name: "read", summary: "Read device" }],
		} as unknown as AgentSession;
		const result: RpcActiveToolsResult = buildRpcActiveTools(session);
		expect(result.tools).toStrictEqual([
			{ name: "read", description: "Read files", source: "builtin" },
			{ name: "read", description: "Read device", source: "builtin", mounted: true },
		]);
	});
});

describe("/omfg over RPC", () => {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const RULE = {
		name: "ts-no-any",
		description: "No any in TS edits",
		condition: ": any",
		scope: ["tool:edit(*.ts)", "tool:write(*.ts)"],
		body: "Use `unknown` instead.",
	};

	function assistant(content: AssistantMessage["content"]): AssistantMessage {
		return {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage,
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	interface UiCall {
		method: string;
		args: unknown[];
	}

	async function runOmfg(options: { matching: boolean; confirm: boolean }) {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "oryn-omfg-"));
		directories.push(root);
		const calls: UiCall[] = [];
		const record =
			(method: string, answer?: unknown) =>
			(...args: unknown[]) => {
				calls.push({ method, args });
				return answer;
			};
		const ui = {
			setStatus: record("setStatus"),
			setWidget: record("setWidget"),
			confirm: record("confirm", Promise.resolve(options.confirm)),
			select: record("select", Promise.resolve("This project (.omp/rules)")),
			input: record("input", Promise.resolve(undefined)),
		} as unknown as ExtensionUIContext;
		const messages: AgentMessage[] = options.matching
			? [
					assistant([
						{
							type: "toolCall",
							id: "call-1",
							name: "edit",
							arguments: { path: "src/example.ts", content: "const value: any = input;" },
						},
					]),
				]
			: [];
		const session = {
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			runEphemeralTurn: async () => ({ replyText: JSON.stringify(RULE), assistantMessage: assistant([]) }),
			messages,
			agent: { state: { tools: [] } },
			ruleJudge: () => undefined,
			ttsrManager: { addRule: () => true },
			sessionManager: { getCwd: () => root },
			settings: { getAgentDir: () => path.join(root, "agent") },
		} as unknown as AgentSession;
		const result = await runRpcOmfg(session, ui, "stop using any");
		return { result, calls };
	}

	function widgets(calls: UiCall[]): Array<string[] | undefined> {
		return calls
			.filter(call => call.method === "setWidget" && call.args[0] === RPC_OMFG_UI_KEY)
			.map(call => call.args[1] as string[] | undefined);
	}

	test("previews the validated rule and reports progress before asking where to save", async () => {
		const { result, calls } = await runOmfg({ matching: true, confirm: true });
		expect(result.state).toBe("saved");

		const selectAt = calls.findIndex(call => call.method === "select");
		const shownBeforeSelect = widgets(calls.slice(0, selectAt)).at(-1);
		expect(shownBeforeSelect?.[0]).toBe("TTSR rule — matches this conversation");
		expect(shownBeforeSelect?.join("\n")).toContain("Use `unknown` instead.");
		expect(shownBeforeSelect?.join("\n")).toContain("condition:");

		const statuses = calls
			.filter(call => call.method === "setStatus" && call.args[0] === RPC_OMFG_UI_KEY)
			.map(call => call.args[1]);
		expect(statuses).toContain("/omfg · Attempt 1/3 · generating…");
		// Both host surfaces are cleared once the workflow ends.
		expect(statuses.at(-1)).toBeUndefined();
		expect(widgets(calls).at(-1)).toBeUndefined();
	});

	test("an unconfirmed rule carries its text into the save-anyway confirmation", async () => {
		const { result, calls } = await runOmfg({ matching: false, confirm: false });
		expect(result.state).toBe("rejected");

		const confirm = calls.find(call => call.method === "confirm");
		expect(confirm?.args[0]).toBe("Validation");
		expect(String(confirm?.args[1])).toStartWith("Couldn't confirm this rule matches the conversation. Save anyway?");
		expect(String(confirm?.args[1])).toContain("Use `unknown` instead.");
		const confirmAt = calls.indexOf(confirm as UiCall);
		expect(widgets(calls.slice(0, confirmAt)).at(-1)?.[0]).toBe(
			"TTSR rule — could not confirm a match in this conversation",
		);
	});
});
