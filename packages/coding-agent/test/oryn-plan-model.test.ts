/**
 * Oryn：RPC 计划模式模型切换与恢复回归测试。
 *
 * 覆盖：
 * - `set_plan_mode` 进入切到 `plan` role 对应模型与思考级别、退出恢复进入前状态
 * - 重复 `set_plan_mode{enabled:true}` 幂等，不覆盖进入前模型
 * - 未配置 `plan` role 时保持原模型、思考级别与来源记录不变
 * - 同模型不同思考级别：不写 `model_change`，仅切换并在退出时恢复思考级别
 * - 流式输出期间进入 / 退出计划模式：延后到 `agent_end` 切换；未落地前退出取消挂起切换（#816）
 * - 计划模式期间 `set_model_role` 重配 `plan` role：立即更新活动模型，退出仍恢复进计划前原始模型
 * - `plan_approval`（keep_context / execute / save / refine）的模型恢复与保持语义
 * - `oryn-model-source` 轨迹联动（进入写 `role: "plan"` + `alias`，退出恢复进入前记录）
 * - `plan.defaultOnStartup` 启动自动进入计划模式时切换到 `plan` 模型
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	OrynPlanModelController,
	type OrynPlanModelSession,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/oryn-plan-model";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ORYN_MODEL_SOURCE_ENTRY } from "@oh-my-pi/pi-coding-agent/modes/rpc/oryn-model-source";
import type { RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
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

const FIXTURE = path.join(import.meta.dir, "fixtures", "oryn-plan-model-rpc-agent.ts");

class FixtureRpc {
	readonly frames: Frame[] = [];
	readonly dir: string;
	readonly #child: Bun.Subprocess;
	#waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
	#nextId = 0;

	constructor(cwd: string, env: Record<string, string>) {
		this.dir = cwd;
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

	waitFor(match: (frame: Frame) => boolean, timeoutMs = 20_000): Promise<Frame> {
		const seen = this.frames.find(match);
		if (seen) return Promise.resolve(seen);
		const { promise, resolve } = Promise.withResolvers<Frame>();
		this.#waiters.push({ match, resolve });
		return withTimeout(promise, timeoutMs, "timed out waiting for an RPC frame");
	}

	waitForNew(match: (frame: Frame) => boolean, fromIndex: number, timeoutMs = 20_000): Promise<Frame> {
		for (let i = fromIndex; i < this.frames.length; i++) {
			const frame = this.frames[i];
			if (frame && match(frame)) return Promise.resolve(frame);
		}
		const { promise, resolve } = Promise.withResolvers<Frame>();
		this.#waiters.push({ match, resolve });
		return withTimeout(promise, timeoutMs, "timed out waiting for a new RPC frame");
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

	async state(): Promise<RpcSessionState> {
		return this.data<RpcSessionState>({ type: "get_state" });
	}

	async readSessionEntries(sessionFile: string): Promise<Array<Record<string, unknown>>> {
		const raw = await fs.readFile(sessionFile, "utf8");
		return raw
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);
	}

	stop(): void {
		this.#child.kill();
	}
}

const active: FixtureRpc[] = [];
const directories: string[] = [];

async function start(env: Record<string, string> = {}): Promise<FixtureRpc> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oryn-plan-model-"));
	directories.push(directory);
	const rpc = new FixtureRpc(directory, env);
	active.push(rpc);
	return rpc;
}

function startIn(directory: string, env: Record<string, string> = {}): FixtureRpc {
	const rpc = new FixtureRpc(directory, env);
	active.push(rpc);
	return rpc;
}

afterEach(async () => {
	for (const rpc of active.splice(0)) rpc.stop();
	for (const directory of directories.splice(0)) await removeWithRetries(directory);
});

describe("RPC plan mode model switching", () => {
	test("switches to plan role model and thinking level on enter, restores on exit, and preserves oryn-model-source", async () => {
		const rpc = await start({
			ORYN_SLOW_ROLE: "anthropic/claude-opus-4-6:high",
			ORYN_PLAN_ROLE: "@slow",
		});

		// 先按 default role 建立来源记录
		await rpc.data({ type: "oryn_select_model", role: "default" });
		const before = await rpc.state();
		expect(before.model?.id).toBe("claude-sonnet-4-5");
		expect(before.thinkingLevel).toBe(ThinkingLevel.Medium);

		const frameMark = rpc.frames.length;
		await rpc.data({ type: "set_plan_mode", enabled: true });

		const inPlan = await rpc.state();
		expect(inPlan.planModeEnabled).toBe(true);
		expect(inPlan.model?.id).toBe("claude-opus-4-6");
		expect(inPlan.thinkingLevel).toBe(ThinkingLevel.High);
		expect(rpc.frames.slice(frameMark).some(f => f.type === "model_changed")).toBe(true);

		// 重复开启幂等，不得覆盖进入前记录的模型
		await rpc.data({ type: "set_plan_mode", enabled: true });
		expect((await rpc.state()).model?.id).toBe("claude-opus-4-6");

		// 会话日志应写入 role: "plan", alias: "slow"
		const entriesInPlan = await rpc.readSessionEntries(inPlan.sessionFile!);
		const sourcesInPlan = entriesInPlan.filter(e => e.type === "custom" && e.customType === ORYN_MODEL_SOURCE_ENTRY);
		expect(sourcesInPlan.at(-1)?.data).toEqual({
			v: 1,
			source: "role",
			model: "anthropic/claude-opus-4-6",
			role: "plan",
			alias: "slow",
		});

		// 退出计划模式：恢复进入前的模型、思考级别与来源记录
		await rpc.data({ type: "set_plan_mode", enabled: false });
		const after = await rpc.state();
		expect(after.planModeEnabled).toBe(false);
		expect(after.model?.id).toBe("claude-sonnet-4-5");
		expect(after.thinkingLevel).toBe(ThinkingLevel.Medium);

		const entriesAfter = await rpc.readSessionEntries(after.sessionFile!);
		const sourcesAfter = entriesAfter.filter(e => e.type === "custom" && e.customType === ORYN_MODEL_SOURCE_ENTRY);
		expect(sourcesAfter.at(-1)?.data).toEqual({
			v: 1,
			source: "role",
			model: "anthropic/claude-sonnet-4-5",
			role: "default",
		});
	});

	test("no-ops cleanly when plan role is unconfigured", async () => {
		const rpc = await start({});
		const before = await rpc.state();
		expect(before.model?.id).toBe("claude-sonnet-4-5");
		expect(before.thinkingLevel).toBe(ThinkingLevel.Medium);

		await rpc.data({ type: "set_plan_mode", enabled: true });
		const inPlan = await rpc.state();
		expect(inPlan.planModeEnabled).toBe(true);
		expect(inPlan.model?.id).toBe("claude-sonnet-4-5");
		expect(inPlan.thinkingLevel).toBe(ThinkingLevel.Medium);

		await rpc.data({ type: "set_plan_mode", enabled: false });
		const after = await rpc.state();
		expect(after.planModeEnabled).toBe(false);
		expect(after.model?.id).toBe("claude-sonnet-4-5");
		expect(after.thinkingLevel).toBe(ThinkingLevel.Medium);
	});

	test("same model with explicit thinking level updates and restores thinking level without model_changed", async () => {
		const rpc = await start({
			ORYN_PLAN_ROLE: "anthropic/claude-sonnet-4-5:xhigh",
		});

		const mark = rpc.frames.length;
		await rpc.data({ type: "set_plan_mode", enabled: true });
		const inPlan = await rpc.state();
		expect(inPlan.model?.id).toBe("claude-sonnet-4-5");
		expect(inPlan.thinkingLevel).toBe(ThinkingLevel.XHigh);
		expect(rpc.frames.slice(mark).some(f => f.type === "model_changed")).toBe(false);

		await rpc.data({ type: "set_plan_mode", enabled: false });
		const after = await rpc.state();
		expect(after.model?.id).toBe("claude-sonnet-4-5");
		expect(after.thinkingLevel).toBe(ThinkingLevel.Medium);
	});

	test("reapplies plan model when plan role is updated mid-planning and still restores pre-plan model", async () => {
		const rpc = await start({
			ORYN_PLAN_ROLE: "anthropic/claude-opus-4-6:high",
		});

		await rpc.data({ type: "set_plan_mode", enabled: true });
		expect((await rpc.state()).model?.id).toBe("claude-opus-4-6");

		// 计划模式期间改配 plan role 为另一个模型
		await rpc.data({
			type: "set_model_role",
			role: "plan",
			modelId: "anthropic/claude-haiku-4-5",
		});
		const updated = await rpc.state();
		expect(updated.model?.id).toBe("claude-haiku-4-5");

		// 退出计划模式应恢复进计划模式前的 claude-sonnet-4-5，而非旧的 claude-opus-4-6
		await rpc.data({ type: "set_plan_mode", enabled: false });
		const after = await rpc.state();
		expect(after.model?.id).toBe("claude-sonnet-4-5");
		expect(after.thinkingLevel).toBe(ThinkingLevel.Medium);
	});

	test("defers plan model switch while streaming and applies after agent_end", async () => {
		const rpc = await start({
			ORYN_PLAN_ROLE: "anthropic/claude-opus-4-6:high",
			ORYN_HOLD_TURN: "1",
		});

		const promptPromise = rpc.data({ type: "prompt", message: "hold turn" });
		await rpc.waitFor(f => f.type === "agent_start");

		// 流式期间进入计划模式：此时不切模型
		await rpc.data({ type: "set_plan_mode", enabled: true });
		expect((await rpc.state()).model?.id).toBe("claude-sonnet-4-5");

		// 放行回合，等 agent_end 与 model_changed
		const mark = rpc.frames.length;
		await rpc.data({ type: "prompt", message: "/oryntest-release" });
		await promptPromise;
		await rpc.waitForNew(f => f.type === "model_changed", mark);

		const afterTurn = await rpc.state();
		expect(afterTurn.planModeEnabled).toBe(true);
		expect(afterTurn.model?.id).toBe("claude-opus-4-6");
		expect(afterTurn.thinkingLevel).toBe(ThinkingLevel.High);
	});

	test("cancels deferred plan model switch if exited before streaming ends (#816)", async () => {
		const rpc = await start({
			ORYN_PLAN_ROLE: "anthropic/claude-opus-4-6:high",
			ORYN_HOLD_TURN: "1",
		});

		const promptPromise = rpc.data({ type: "prompt", message: "hold turn" });
		await rpc.waitFor(f => f.type === "agent_start");

		await rpc.data({ type: "set_plan_mode", enabled: true });
		await rpc.data({ type: "set_plan_mode", enabled: false });

		const mark = rpc.frames.length;
		await rpc.data({ type: "prompt", message: "/oryntest-release" });
		await promptPromise;
		await rpc.waitForNew(f => f.type === "agent_end", mark);

		const after = await rpc.state();
		expect(after.planModeEnabled).toBe(false);
		expect(after.model?.id).toBe("claude-sonnet-4-5");
		expect(after.thinkingLevel).toBe(ThinkingLevel.Medium);
	});

	test("re-entering plan mode while a restore is pending cancels the restore and preserves the original baseline", async () => {
		const rpc = await start({
			ORYN_PLAN_ROLE: "anthropic/claude-opus-4-6:high",
			ORYN_HOLD_TURN: "1",
		});

		await rpc.data({ type: "oryn_select_model", role: "default" });
		await rpc.data({ type: "set_plan_mode", enabled: true });
		expect((await rpc.state()).model?.id).toBe("claude-opus-4-6");

		// 在计划模型 B 上启动流式回合
		const promptPromise = rpc.data({ type: "prompt", message: "hold turn on plan model" });
		await rpc.waitFor(f => f.type === "agent_start");

		// 流式期间关计划再重开：不得在 agent_end 切回 A，也不得把 B 当新基线
		await rpc.data({ type: "set_plan_mode", enabled: false });
		await rpc.data({ type: "set_plan_mode", enabled: true });

		const mark = rpc.frames.length;
		await rpc.data({ type: "prompt", message: "/oryntest-release" });
		await promptPromise;
		await rpc.waitForNew(f => f.type === "session_settled", mark);

		const stillPlan = await rpc.state();
		expect(stillPlan.planModeEnabled).toBe(true);
		expect(stillPlan.model?.id).toBe("claude-opus-4-6");
		expect(stillPlan.thinkingLevel).toBe(ThinkingLevel.High);

		// 再次退出计划模式时应恢复最初进入前的原基线 A（sonnet:medium + default 来源），而不是 B
		await rpc.data({ type: "set_plan_mode", enabled: false });
		const after = await rpc.state();
		expect(after.planModeEnabled).toBe(false);
		expect(after.model?.id).toBe("claude-sonnet-4-5");
		expect(after.thinkingLevel).toBe(ThinkingLevel.Medium);

		const entries = await rpc.readSessionEntries(after.sessionFile!);
		const sources = entries.filter(e => e.type === "custom" && e.customType === ORYN_MODEL_SOURCE_ENTRY);
		expect(sources.at(-1)?.data).toEqual({
			v: 1,
			source: "role",
			model: "anthropic/claude-sonnet-4-5",
			role: "default",
		});
	});

	test("restores pre-plan model on plan_approval execute (across newSession)", async () => {
		const rpc = await start({
			ORYN_PLAN_ROLE: "anthropic/claude-opus-4-6:high",
			ORYN_PROPOSE_ON_TURN: "1",
		});

		await rpc.data({ type: "oryn_select_model", role: "default" });
		await rpc.data({ type: "set_plan_mode", enabled: true });
		expect((await rpc.state()).model?.id).toBe("claude-opus-4-6");

		const proposalPromise = rpc.waitFor(f => f.type === "plan_proposal");
		await rpc.data({ type: "prompt", message: "make a plan" });
		await proposalPromise;

		await rpc.data({ type: "plan_approval", approved: true, option: "execute" });
		const after = await rpc.state();
		expect(after.planModeEnabled).toBe(false);
		expect(after.model?.id).toBe("claude-sonnet-4-5");
		expect(after.thinkingLevel).toBe(ThinkingLevel.Medium);

		const entries = await rpc.readSessionEntries(after.sessionFile!);
		const sources = entries.filter(e => e.type === "custom" && e.customType === ORYN_MODEL_SOURCE_ENTRY);
		expect(sources.at(-1)?.data).toEqual({
			v: 1,
			source: "role",
			model: "anthropic/claude-sonnet-4-5",
			role: "default",
		});
	});

	test("keeps plan model on plan_approval reject/refine and restores on keep_context and save", async () => {
		const rpc = await start({
			ORYN_PLAN_ROLE: "anthropic/claude-opus-4-6:high",
			ORYN_PROPOSE_ON_TURN: "1",
		});

		await rpc.data({ type: "set_plan_mode", enabled: true });
		const proposal1 = rpc.waitFor(f => f.type === "plan_proposal");
		await rpc.data({ type: "prompt", message: "make a plan" });
		await proposal1;

		// 驳回不退出计划模式，保持 plan 模型
		await rpc.data({ type: "plan_approval", approved: false });
		const stillPlan = await rpc.state();
		expect(stillPlan.planModeEnabled).toBe(true);
		expect(stillPlan.model?.id).toBe("claude-opus-4-6");

		// keep_context 路径退出计划模式并恢复进入前模型（不新建会话）
		const rpcKeep = await start({
			ORYN_PLAN_ROLE: "anthropic/claude-opus-4-6:high",
			ORYN_PROPOSE_ON_TURN: "1",
		});
		await rpcKeep.data({ type: "set_plan_mode", enabled: true });
		const proposalKeep = rpcKeep.waitFor(f => f.type === "plan_proposal");
		await rpcKeep.data({ type: "prompt", message: "make a plan" });
		await proposalKeep;
		await rpcKeep.data({ type: "plan_approval", approved: true, option: "keep_context" });
		const afterKeep = await rpcKeep.state();
		expect(afterKeep.planModeEnabled).toBe(false);
		expect(afterKeep.model?.id).toBe("claude-sonnet-4-5");
		expect(afterKeep.thinkingLevel).toBe(ThinkingLevel.Medium);
		// save 路径退出计划模式并恢复进入前模型
		const rpcSave = await start({
			ORYN_PLAN_ROLE: "anthropic/claude-opus-4-6:high",
			ORYN_PROPOSE_ON_TURN: "1",
		});
		await rpcSave.data({ type: "set_plan_mode", enabled: true });
		const proposalSave = rpcSave.waitFor(f => f.type === "plan_proposal");
		await rpcSave.data({ type: "prompt", message: "make a plan" });
		await proposalSave;
		await rpcSave.data({
			type: "plan_approval",
			approved: true,
			option: "save",
			savePath: path.join(rpcSave.dir, "saved-plan.md"),
		});
		const afterSave = await rpcSave.state();
		expect(afterSave.planModeEnabled).toBe(false);
		expect(afterSave.model?.id).toBe("claude-sonnet-4-5");
		expect(afterSave.thinkingLevel).toBe(ThinkingLevel.Medium);
	});

	test("manual model switch during streaming cancels deferred plan model switch", async () => {
		const rpc = await start({
			ORYN_PLAN_ROLE: "anthropic/claude-opus-4-6:high",
			ORYN_HOLD_TURN: "1",
		});

		const promptPromise = rpc.data({ type: "prompt", message: "hold turn" });
		await rpc.waitFor(f => f.type === "agent_start");

		await rpc.data({ type: "set_plan_mode", enabled: true });
		await rpc.data({ type: "set_model", provider: "anthropic", modelId: "claude-haiku-4-5" });

		const mark = rpc.frames.length;
		await rpc.data({ type: "prompt", message: "/oryntest-release" });
		await promptPromise;
		await rpc.waitForNew(f => f.type === "agent_end", mark);

		const after = await rpc.state();
		expect(after.model?.id).toBe("claude-haiku-4-5");
	});

	test("applies plan model when plan.defaultOnStartup enters plan mode automatically", async () => {
		const rpc = await start({
			ORYN_PLAN_ROLE: "anthropic/claude-opus-4-6:high",
			ORYN_PLAN_DEFAULT_ON_STARTUP: "1",
		});

		const st = await rpc.state();
		expect(st.planModeEnabled).toBe(true);
		expect(st.model?.id).toBe("claude-opus-4-6");
		expect(st.thinkingLevel).toBe(ThinkingLevel.High);
	});

	test("surfaces warning and leaves pre-plan state clean when setModelTemporary fails", async () => {
		const warnings: string[] = [];
		const sonnet = { provider: "anthropic", id: "claude-sonnet-4-5" } as Model;
		const opus = { provider: "anthropic", id: "claude-opus-4-6" } as Model;
		const activeModel: Model = sonnet;
		const session: OrynPlanModelSession = {
			get model() {
				return activeModel;
			},
			isStreaming: false,
			sessionManager: SessionManager.inMemory(),
			settings: { getModelRole: () => "anthropic/claude-opus-4-6" },
			configuredThinkingLevel: () => ThinkingLevel.Medium,
			getPlanModeState: () => ({ enabled: true, planFilePath: "local://PLAN.md" }),
			resolveRoleModelWithThinking: () => ({ model: opus, explicitThinkingLevel: false, warning: undefined }),
			setModelTemporary: async () => {
				throw new Error("No API key for anthropic/claude-opus-4-6");
			},
			setThinkingLevel: () => {},
		};
		const controller = new OrynPlanModelController({ session, onWarning: msg => warnings.push(msg) });
		await controller.onEnterPlanMode();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("No API key");
		expect(activeModel).toBe(sonnet);

		// 退出时不应再尝试恢复不存在的切换
		await controller.onExitPlanMode();
		expect(warnings).toHaveLength(1);
	});

	test("persists plan mode and baseline across restart: continue in plan mode, then exit restores original model A", async () => {
		const env = {
			ORYN_SLOW_ROLE: "anthropic/claude-opus-4-6:high",
			ORYN_PLAN_ROLE: "@slow",
		};
		const rpc1 = await start(env);
		const sessionDir = path.join(rpc1.dir, "sessions");

		// 在常驻模型 A 上建立来源记录并跑一轮，确保会话文件非空可被 open_session 恢复
		await rpc1.data({ type: "oryn_select_model", role: "default" });
		const firstDone = rpc1.waitFor(f => f.type === "agent_end");
		await rpc1.data({ type: "prompt", message: "hello before plan" });
		await firstDone;

		// 进入计划模式 → 切到计划模型 B（opus:high）
		await rpc1.data({ type: "set_plan_mode", enabled: true });
		const inPlan1 = await rpc1.state();
		expect(inPlan1.planModeEnabled).toBe(true);
		expect(inPlan1.model?.id).toBe("claude-opus-4-6");
		expect(inPlan1.thinkingLevel).toBe(ThinkingLevel.High);
		rpc1.stop();

		// 重启进程 2：无显式模型 open_session → 恢复计划模式与模型 B，继续对话仍在 B
		const rpc2 = startIn(rpc1.dir, env);
		await rpc2.data({ type: "open_session", sessionDir });
		const afterRestart = await rpc2.state();
		expect(afterRestart.planModeEnabled).toBe(true);
		expect(afterRestart.model?.id).toBe("claude-opus-4-6");
		expect(afterRestart.thinkingLevel).toBe(ThinkingLevel.High);

		// 在重启后的进程里继续一轮计划对话，模型仍保持 B
		const secondDone = rpc2.waitFor(f => f.type === "agent_end");
		await rpc2.data({ type: "prompt", message: "continue planning after restart" });
		await secondDone;
		expect((await rpc2.state()).model?.id).toBe("claude-opus-4-6");

		// 退出计划模式 → 恢复最初的原基线 A（sonnet:medium + role:default），而非留在 B
		await rpc2.data({ type: "set_plan_mode", enabled: false });
		const afterExit = await rpc2.state();
		expect(afterExit.planModeEnabled).toBe(false);
		expect(afterExit.model?.id).toBe("claude-sonnet-4-5");
		expect(afterExit.thinkingLevel).toBe(ThinkingLevel.Medium);

		const entries = await rpc2.readSessionEntries(afterExit.sessionFile!);
		const sources = entries.filter(e => e.type === "custom" && e.customType === ORYN_MODEL_SOURCE_ENTRY);
		expect(sources.at(-1)?.data).toEqual({
			v: 1,
			source: "role",
			model: "anthropic/claude-sonnet-4-5",
			role: "default",
		});
	});

	test("open_session with Oryn persistent baseline model A keeps active plan model B and still restores A on exit", async () => {
		const env = {
			ORYN_PLAN_ROLE: "anthropic/claude-opus-4-6:high",
		};
		const rpc1 = await start(env);
		const sessionDir = path.join(rpc1.dir, "sessions");

		await rpc1.data({ type: "oryn_select_model", role: "default" });
		const firstDone = rpc1.waitFor(f => f.type === "agent_end");
		await rpc1.data({ type: "prompt", message: "hello before plan" });
		await firstDone;

		await rpc1.data({ type: "set_plan_mode", enabled: true });
		expect((await rpc1.state()).model?.id).toBe("claude-opus-4-6");
		rpc1.stop();

		// 模拟 Oryn 控制面冷重启后带常驻基线 A 调用 open_session
		const rpc2 = startIn(rpc1.dir, env);
		await rpc2.data({
			type: "open_session",
			sessionDir,
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		});
		const resumed = await rpc2.state();
		expect(resumed.planModeEnabled).toBe(true);
		expect(resumed.model?.id).toBe("claude-opus-4-6");
		expect(resumed.thinkingLevel).toBe(ThinkingLevel.High);

		// 退出计划模式仍准确恢复 A
		await rpc2.data({ type: "set_plan_mode", enabled: false });
		const afterExit = await rpc2.state();
		expect(afterExit.planModeEnabled).toBe(false);
		expect(afterExit.model?.id).toBe("claude-sonnet-4-5");
		expect(afterExit.thinkingLevel).toBe(ThinkingLevel.Medium);
	});
});
