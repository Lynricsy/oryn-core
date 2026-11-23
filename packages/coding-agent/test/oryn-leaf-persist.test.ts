import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import { ORYN_LEAF_CUSTOM_TYPE, persistRpcLeaf } from "@oh-my-pi/pi-coding-agent/modes/rpc/oryn-leaf";
import { openRpcSession, type RpcOpenSessionSession } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { buildRpcSessionTree } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-tree";
import type { RpcSessionTreeResult } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./session-manager/helpers";

function userMsg(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

/** 模拟重启后的新进程：以全新的 SessionManager 走 openRpcSession 恢复目录里的会话文件。 */
async function reopenViaOpenSession(cwd: string, sessionDir: string): Promise<SessionManager> {
	const fresh = SessionManager.create(cwd, sessionDir);
	const standIn: RpcOpenSessionSession = {
		get sessionFile() {
			return fresh.getSessionFile();
		},
		get sessionId() {
			return fresh.getSessionId();
		},
		get messages(): AgentMessage[] {
			return fresh.buildSessionContext().messages;
		},
		model: undefined,
		async setModel() {
			return { switched: true };
		},
		async newSession(options) {
			await fresh.newSession(options);
			return true;
		},
		async switchSession(sessionPath) {
			await fresh.setSessionFile(sessionPath);
			return true;
		},
	};
	const result = await openRpcSession(standIn, sessionDir);
	expect(result.resumed).toBe(true);
	return fresh;
}

interface RpcFrame {
	type: string;
	id?: string;
	command?: string;
	success?: boolean;
	error?: string;
	data?: unknown;
}

const RPC_FIXTURE = path.join(import.meta.dir, "fixtures", "fork-rpc-agent.ts");

/** 轻量行协议驱动：直接对真实 `runRpcMode` 进程发任意命令（包括 `switch_leaf`、`get_session_tree`）。 */
class RawRpcProc {
	readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	#waiters: Array<{ match: (f: RpcFrame) => boolean; resolve: (f: RpcFrame) => void }> = [];
	#buffer: RpcFrame[] = [];
	#seq = 0;

	constructor(root: string) {
		this.#child = Bun.spawn([process.execPath, RPC_FIXTURE, root], {
			cwd: root,
			env: { ...Bun.env, PI_CODING_AGENT_DIR: root, PI_NO_TITLE: "1" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		void this.#readLoop();
	}

	async #readLoop(): Promise<void> {
		const reader = (this.#child.stdout as ReadableStream<Uint8Array>).getReader();
		const dec = new TextDecoder();
		let buf = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let nl = buf.indexOf("\n");
				while (nl !== -1) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (line) {
						try {
							const frame = JSON.parse(line) as RpcFrame;
							const at = this.#waiters.findIndex(w => w.match(frame));
							if (at >= 0) {
								const [w] = this.#waiters.splice(at, 1);
								w.resolve(frame);
							} else {
								this.#buffer.push(frame);
							}
						} catch {
							// 忽略非 JSON 输出
						}
					}
					nl = buf.indexOf("\n");
				}
			}
		} finally {
			reader.releaseLock();
		}
	}
	waitFor(match: (f: RpcFrame) => boolean): Promise<RpcFrame> {
		const at = this.#buffer.findIndex(match);
		if (at >= 0) {
			const [f] = this.#buffer.splice(at, 1);
			return Promise.resolve(f);
		}
		const { promise, resolve } = Promise.withResolvers<RpcFrame>();
		this.#waiters.push({ match, resolve });
		return promise;
	}

	async ready(): Promise<void> {
		await this.waitFor(f => f.type === "ready");
	}

	async cmd<T = unknown>(frame: Record<string, unknown>): Promise<T> {
		const id = `c${++this.#seq}`;
		const stdin = this.#child.stdin as { write(s: string): void; flush?(): void };
		const pending = this.waitFor(f => f.type === "response" && f.id === id);
		stdin.write(`${JSON.stringify({ id, ...frame })}\n`);
		stdin.flush?.();
		const res = await pending;
		if (!res.success) throw new Error(`${String(frame.type)} failed: ${res.error}`);
		return res.data as T;
	}

	async promptAndWait(message: string): Promise<void> {
		const ended = this.waitFor(f => f.type === "agent_end");
		await this.cmd({ type: "prompt", message });
		await ended;
	}

	async stop(): Promise<void> {
		this.#child.kill();
		await this.#child.exited;
	}
}

describe("Oryn RPC leaf persistence across restart", () => {
	let root: string;
	let cwd: string;
	let sessionDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-oryn-leaf-"));
		setAgentDir(path.join(root, "agent"));
		cwd = path.join(root, "project");
		sessionDir = path.join(root, "sessions");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(sessionDir, { recursive: true });
	});

	afterEach(async () => {
		if (originalAgentDir) setAgentDir(originalAgentDir);
		else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await removeWithRetries(root);
	});

	it("切回旧分支后经 open_session 重启，叶子与上下文留在旧分支且不污染会话树", async () => {
		const sm = SessionManager.create(cwd, sessionDir);
		const u1 = sm.appendMessage(userMsg("first"));
		const a1 = sm.appendMessage(makeAssistantMessage());
		const u2 = sm.appendMessage(userMsg("second"));
		const a2 = sm.appendMessage(makeAssistantMessage());
		await sm.flush();

		sm.branch(a1);
		await persistRpcLeaf({ sessionManager: sm });

		// 离分支标记不在活动分支、也不进 get_session_tree
		expect(sm.getLeafId()).toBe(a1);
		expect(sm.getBranch().map(e => e.id)).toEqual([u1, a1]);
		const last = sm.getEntries().at(-1);
		expect(last?.type).toBe("custom");
		expect(last?.type === "custom" ? last.customType : undefined).toBe(ORYN_LEAF_CUSTOM_TYPE);
		expect(last?.activeLeafId).toBe(a1);
		await sm.close();

		const reloaded = await reopenViaOpenSession(cwd, sessionDir);
		expect(reloaded.getLeafId()).toBe(a1);
		expect(reloaded.buildSessionContext().messages).toHaveLength(2);

		const tree = buildRpcSessionTree({ sessionManager: reloaded } as unknown as AgentSession);
		expect(tree.tree.map(n => n.entryId)).toEqual([u1, a1, u2, a2]);
		expect(tree.activeLeafId).toBe(a1);
		expect(tree.tree.filter(n => n.onActiveBranch).map(n => n.entryId)).toEqual([u1, a1]);

		// 重启后发新消息挂在 a1 下，旧分支仍可切回
		const u3 = reloaded.appendMessage(userMsg("retry-second"));
		expect(reloaded.getEntry(u3)?.parentId).toBe(a1);
		reloaded.branch(a2);
		expect(reloaded.getBranch().map(e => e.id)).toEqual([u1, a1, u2, a2]);
		await reloaded.close();
	});

	it("回退到根消息之前（leaf=null）重启后仍是空分支，新消息从根分叉且旧分支仍在", async () => {
		const sm = SessionManager.create(cwd, sessionDir);
		const u1 = sm.appendMessage(userMsg("root-1"));
		const a1 = sm.appendMessage(makeAssistantMessage());
		await sm.flush();

		sm.resetLeaf();
		await persistRpcLeaf({ sessionManager: sm });
		expect(sm.getLeafId()).toBeNull();
		await sm.close();

		const reloaded = await reopenViaOpenSession(cwd, sessionDir);
		expect(reloaded.getLeafId()).toBeNull();
		expect(reloaded.buildSessionContext().messages).toEqual([]);

		// 新消息成为新根（parentId = null），旧分支 u1->a1 仍在会话树里可找回
		const u2 = reloaded.appendMessage(userMsg("root-2"));
		expect(reloaded.getEntry(u2)?.parentId).toBeNull();
		expect(reloaded.getBranch().map(e => e.id)).toEqual([u2]);
		reloaded.branch(a1);
		expect(reloaded.getBranch().map(e => e.id)).toEqual([u1, a1]);
		await reloaded.close();
	});

	it("叶子停在用户消息本身（连续两条用户消息回退第二条）时，重启后精准回到第一条用户消息", async () => {
		const sm = SessionManager.create(cwd, sessionDir);
		const u1 = sm.appendMessage(userMsg("u1"));
		sm.appendMessage(userMsg("u2"));
		sm.appendMessage(makeAssistantMessage());
		await sm.flush();

		sm.branch(u1);
		await persistRpcLeaf({ sessionManager: sm });
		await sm.close();

		const reloaded = await reopenViaOpenSession(cwd, sessionDir);
		expect(reloaded.getLeafId()).toBe(u1);
		expect(reloaded.buildSessionContext().messages).toHaveLength(1);
		await reloaded.close();
	});

	it("带摘要跳转或文件尾部已对应当前叶子时不多写 oryn-leaf", async () => {
		const sm = SessionManager.create(cwd, sessionDir);
		const u1 = sm.appendMessage(userMsg("first"));
		const a1 = sm.appendMessage(makeAssistantMessage());
		sm.appendMessage(userMsg("second"));
		sm.appendMessage(makeAssistantMessage());
		await sm.flush();

		// 已经在末尾：no-op
		expect(sm.persistLeaf()).toBeUndefined();

		// 带摘要：branch_summary 本身在文件末尾且是新叶子，no-op
		const bs = sm.branchWithSummary(a1, "summary");
		expect(sm.getLeafId()).toBe(bs);
		expect(sm.persistLeaf()).toBeUndefined();

		// 切回 u1 写一次，再调一次是幂等 no-op
		sm.branch(u1);
		const marker = sm.persistLeaf();
		expect(marker).toBeDefined();
		expect(sm.persistLeaf()).toBeUndefined();
		await sm.close();
	});

	it("真实 RPC 进程：switch_leaf 与 navigate_tree 重启后保持回退位置（含根前空分支）", async () => {
		const rpcRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-oryn-leaf-rpc-"));
		const rpcSessions = path.join(rpcRoot, "sessions");
		let p1: RawRpcProc | undefined;
		let p2: RawRpcProc | undefined;
		let p3: RawRpcProc | undefined;
		try {
			p1 = new RawRpcProc(rpcRoot);
			await p1.ready();
			await p1.promptAndWait("first");
			await p1.promptAndWait("second");
			const { entries } = await p1.cmd<{
				entries: Array<{ id: string; parentId: string | null; type: string }>;
			}>({ type: "get_entries" });
			const msgEntries = entries.filter(e => e.type === "message");
			expect(msgEntries).toHaveLength(4);
			const [u1, a1, u2] = msgEntries;

			// switch_leaf 回退到 u2 → 叶子到 u2.parentId（会话树里对应的最近消息节点是 a1），立即杀掉进程
			const sw = await p1.cmd<{ cancelled: boolean; activeLeafId?: string }>({
				type: "switch_leaf",
				entryId: u2!.id,
			});
			expect(sw.cancelled).toBe(false);
			expect(sw.activeLeafId).toBe(u2!.parentId ?? undefined);
			await p1.stop();
			p1 = undefined;

			// 新进程 open_session 重载：叶子和消息都在 a1，不是 a2
			p2 = new RawRpcProc(rpcRoot);
			await p2.ready();
			await p2.cmd({
				type: "open_session",
				sessionDir: rpcSessions,
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
			const tree2 = await p2.cmd<RpcSessionTreeResult>({ type: "get_session_tree" });
			expect(tree2.activeLeafId).toBe(a1!.id);
			expect(tree2.tree.filter(n => n.onActiveBranch).map(n => n.entryId)).toEqual([u1!.id, a1!.id]);
			const msgs2 = await p2.cmd<{ messages: AgentMessage[] }>({ type: "get_messages" });
			expect(msgs2.messages).toHaveLength(2);

			// 再用 navigate_tree 回退到第一条用户消息 u1 之前 → 活动分支上没有消息，杀掉进程
			const nav = await p2.cmd<{ cancelled: boolean }>({ type: "navigate_tree", entryId: u1!.id });
			expect(nav.cancelled).toBe(false);
			await p2.stop();
			p2 = undefined;

			// 第三个进程 open_session 重载：活动分支依然没有消息，旧分支仍在会话树里
			p3 = new RawRpcProc(rpcRoot);
			await p3.ready();
			await p3.cmd({
				type: "open_session",
				sessionDir: rpcSessions,
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
			const tree3 = await p3.cmd<RpcSessionTreeResult>({ type: "get_session_tree" });
			expect(tree3.activeLeafId).toBeNull();
			expect(tree3.tree.filter(n => n.onActiveBranch)).toEqual([]);
			expect(tree3.tree).toHaveLength(4);
			const msgs3 = await p3.cmd<{ messages: AgentMessage[] }>({ type: "get_messages" });
			expect(msgs3.messages).toHaveLength(0);

			// 重启后从空分支发送新消息：成为独立的根分支，旧分支（u1/a1）仍在会话树里
			await p3.promptAndWait("rewritten");
			const tree4 = await p3.cmd<RpcSessionTreeResult>({ type: "get_session_tree" });
			const active4 = tree4.tree.filter(n => n.onActiveBranch);
			expect(active4).toHaveLength(2);
			expect(active4[0]!.parentId).toBeNull();
			expect(active4[0]!.textPreview).toContain("rewritten");
			expect(tree4.tree).toHaveLength(6);
		} finally {
			await p1?.stop();
			await p2?.stop();
			await p3?.stop();
			await removeWithRetries(rpcRoot);
		}
	}, 30_000);
});
