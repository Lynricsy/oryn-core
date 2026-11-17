/**
 * Oryn：不经模型直接执行工具的 RPC（`oryn_tool_defs` / `oryn_tool_call` / `oryn_tool_cancel` 与
 * `oryn_tool_update` 帧，见 ORYN.md「例外清单」）。
 *
 * 以真实 CLI 启动 `--mode rpc --no-session`，HOME 指向空目录，不配置任何模型：Oryn「助手的电脑」里的
 * 执行器正是这样运行的。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";

interface Frame {
	type: string;
	id?: string;
	command?: string;
	success?: boolean;
	error?: string;
	data?: Record<string, unknown>;
	[key: string]: unknown;
}

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

const CLI = path.resolve(import.meta.dir, "../src/cli.ts");

class CliRpc {
	/** 每帧与到达时间（毫秒）。 */
	readonly frames: Array<{ frame: Frame; at: number }> = [];
	readonly #child: Bun.Subprocess<"pipe", "pipe", "ignore">;
	#waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
	#nextId = 0;

	constructor(root: string) {
		const home = path.join(root, "home");
		this.#child = Bun.spawn(
			[process.execPath, CLI, "--mode", "rpc", "--no-session", "--no-title", "--no-extensions", "--no-lsp"],
			{
				cwd: path.join(root, "work"),
				env: {
					PATH: process.env.PATH,
					HOME: home,
					USERPROFILE: home,
					TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
					NO_COLOR: "1",
					PI_NO_PTY: "1",
					PI_NOTIFICATIONS: "off",
					AWS_EC2_METADATA_DISABLED: "true",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "ignore",
			},
		);
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
				this.frames.push({ frame, at: Date.now() });
				this.#waiters = this.#waiters.filter(waiter => {
					if (!waiter.match(frame)) return true;
					waiter.resolve(frame);
					return false;
				});
			}
		}
	}

	waitFor(match: (frame: Frame) => boolean, timeoutMs = 30_000): Promise<Frame> {
		const seen = this.frames.find(entry => match(entry.frame));
		if (seen) return Promise.resolve(seen.frame);
		const { promise, resolve } = Promise.withResolvers<Frame>();
		this.#waiters.push({ match, resolve });
		return withTimeout(promise, timeoutMs, "timed out waiting for an RPC frame");
	}

	/** 发出命令，返回等待其应答的 promise（不等待，便于并发）。 */
	send(command: Record<string, unknown>, timeoutMs?: number): Promise<Frame> {
		const id = `t${this.#nextId++}`;
		const stdin = this.#child.stdin;
		if (!stdin || typeof stdin === "number") throw new Error("expected piped stdin");
		stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		void stdin.flush();
		return this.waitFor(frame => frame.type === "response" && frame.id === id, timeoutMs);
	}

	async call(callId: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
		const response = await this.send({ type: "oryn_tool_call", callId, toolName, arguments: args });
		if (!response.success) throw new Error(`oryn_tool_call ${toolName} failed: ${response.error}`);
		return response.data?.result as ToolResult;
	}

	stop(): void {
		this.#child.kill();
	}
}

function text(result: ToolResult): string {
	return result.content.flatMap(part => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
}

let root: string;
let work: string;
let rpc: CliRpc;

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "oryn-tool-exec-"));
	work = path.join(root, "work");
	await fs.mkdir(path.join(root, "home"), { recursive: true });
	await fs.mkdir(work, { recursive: true });
	rpc = new CliRpc(root);
	await rpc.waitFor(frame => frame.type === "ready", 90_000);
}, 120_000);

afterAll(async () => {
	rpc?.stop();
	if (root) await removeWithRetries(root);
});

describe("oryn tool exec over RPC without a model", () => {
	test("the session has no model", async () => {
		const state = await rpc.send({ type: "get_state" });
		expect(state.success).toBe(true);
		expect(state.data?.model ?? null).toBeNull();
	});

	test("oryn_tool_defs returns schemas and skips unknown and denied names", async () => {
		const response = await rpc.send({ type: "oryn_tool_defs", names: ["bash", "read", "task", "todo", "nope"] });
		expect(response.success).toBe(true);
		const tools = response.data?.tools as Array<{ name: string; description: string; parameters: unknown }>;
		expect(tools.map(tool => tool.name)).toEqual(["bash", "read"]);
		for (const tool of tools) {
			expect(typeof tool.description).toBe("string");
			expect(tool.parameters).toMatchObject({ type: "object" });
		}
	});

	test("bash runs and returns its output", async () => {
		const result = await rpc.call("bash-echo", "bash", { command: "echo hello-oryn" });
		expect(result.isError).toBeUndefined();
		expect(text(result)).toContain("hello-oryn");
	});

	test("write, read and edit a file", async () => {
		const file = path.join(work, "notes.txt");
		const written = await rpc.call("write-1", "write", { path: file, content: "alpha\nbeta\n" });
		expect(written.isError).toBeUndefined();
		expect(await Bun.file(file).text()).toBe("alpha\nbeta\n");

		const read = await rpc.call("read-1", "read", { path: file });
		expect(read.isError).toBeUndefined();
		const shown = text(read);
		expect(shown).toContain("alpha");
		expect(shown).toContain("beta");

		const tag = /#([0-9A-F]{4})\]/.exec(shown)?.[1];
		expect(tag).toBeDefined();
		const edited = await rpc.call("edit-1", "edit", { input: `[${file}#${tag}]\nPUT 2.=2:\n+gamma\n` });
		expect(edited.isError).toBeUndefined();
		expect(await Bun.file(file).text()).toBe("alpha\ngamma\n");
	});

	test("a running bash streams throttled oryn_tool_update frames", async () => {
		const result = await rpc.call("bash-stream", "bash", {
			command: "for i in 1 2 3 4 5 6; do echo tick$i; sleep 0.3; done",
		});
		expect(text(result)).toContain("tick6");
		const updates = rpc.frames.filter(
			entry => entry.frame.type === "oryn_tool_update" && entry.frame.callId === "bash-stream",
		);
		expect(updates.length).toBeGreaterThan(0);
		expect(updates.at(-1)?.frame.partialResult).toMatchObject({ content: expect.any(Array) });
		for (let i = 1; i < updates.length; i++) {
			// 帧在 250 毫秒的窗口上发出；管道传输的抖动留出余量。
			expect(updates[i].at - updates[i - 1].at).toBeGreaterThanOrEqual(150);
		}
	});

	test("oryn_tool_cancel aborts a running call", async () => {
		const started = Date.now();
		const pending = rpc.send({
			type: "oryn_tool_call",
			callId: "bash-sleep",
			toolName: "bash",
			arguments: { command: "echo started; sleep 30" },
		});
		// 等第一帧部分输出，确认调用已经在运行。
		await rpc.waitFor(frame => frame.type === "oryn_tool_update" && frame.callId === "bash-sleep");
		const cancel = await rpc.send({ type: "oryn_tool_cancel", callId: "bash-sleep" });
		expect(cancel.success).toBe(true);
		expect(cancel.data?.cancelled).toBe(true);
		const response = await pending;
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(response.success).toBe(true);

		const again = await rpc.send({ type: "oryn_tool_cancel", callId: "bash-sleep" });
		expect(again.data?.cancelled).toBe(false);
	});

	test("unknown tools and invalid arguments are RPC errors", async () => {
		const unknown = await rpc.send({ type: "oryn_tool_call", callId: "u1", toolName: "no_such_tool", arguments: {} });
		expect(unknown.success).toBe(false);
		expect(unknown.error).toContain("Unknown tool");

		// 缺少必填的 `command`（类型不符的值会被校验按 schema 强制转换，不能用来构造非法参数）。
		const invalid = await rpc.send({ type: "oryn_tool_call", callId: "u2", toolName: "bash", arguments: {} });
		expect(invalid.success).toBe(false);
		expect(invalid.error).toBeTruthy();
	});

	test("denied tools are refused", async () => {
		for (const toolName of ["todo", "task"]) {
			const denied = await rpc.send({ type: "oryn_tool_call", callId: `d-${toolName}`, toolName, arguments: {} });
			expect(denied.success).toBe(false);
			expect(denied.error).toContain("cannot run through oryn_tool_call");
		}
	});

	test("a failing tool is a successful response with isError", async () => {
		const result = await rpc.call("read-missing", "read", { path: path.join(work, "missing.txt") });
		expect(result.isError).toBe(true);
		expect(text(result).length).toBeGreaterThan(0);
	});
});
