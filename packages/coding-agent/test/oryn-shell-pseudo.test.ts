/**
 * Oryn：bash 运行帧的 Pseudo 视图（`oryn-shell-pseudo.ts`，见 ORYN.md「例外清单」）。
 * 用真实原生 Shell 跑命令得到执行轨迹，再交给投影器。
 */
import { describe, expect, it } from "bun:test";
import { RunTrace, Shell } from "@oh-my-pi/pi-natives";
import { attachShellTrace } from "../src/tools/shell-viz";
import { isShellTrace, type ShellTrace } from "@oh-my-pi/pi-wire";
import { type OrynPseudo, OrynShellPseudoProjector } from "../src/modes/rpc/oryn-shell-pseudo";
import type { AgentSessionEvent } from "../src/session/agent-session";

function snapshot(trace: RunTrace): ShellTrace {
	const value: unknown = JSON.parse(trace.snapshot());
	if (!isShellTrace(value)) throw new Error("Expected native execution trace");
	attachShellTrace(value, trace);
	return value;
}

function update(trace: ShellTrace, toolCallId = "call-1", toolName = "bash"): AgentSessionEvent {
	return {
		type: "tool_execution_update",
		toolCallId,
		toolName,
		args: {},
		partialResult: { content: [{ type: "text", text: "" }], details: { trace } },
	};
}

function pseudoOf(event: AgentSessionEvent): OrynPseudo | undefined {
	if (event.type !== "tool_execution_update") return undefined;
	return event.partialResult?.details?.orynPseudo;
}

describe("OrynShellPseudoProjector", () => {
	it("运行中的帧带 pseudo：正在执行的行标 active，整体标 running", async () => {
		const command = "x=1\nsleep 1\necho done";
		const trace = new RunTrace(command);
		const run = new Shell().run({ command, trace });
		// 真实子进程运行中的状态只能等原生轨迹推进到那一步；按条件轮询轨迹版本，不猜固定时长
		let pseudo: OrynPseudo | undefined;
		let seen = -1;
		for (let i = 0; i < 400 && !pseudo?.rows.some(row => row.active); i++) {
			if (trace.version() !== seen) {
				seen = trace.version();
				pseudo = pseudoOf(new OrynShellPseudoProjector().project(update(snapshot(trace))));
			}
			await Bun.sleep(5);
		}
		await run;
		expect(pseudo?.v).toBe(1);
		expect(pseudo?.running).toBe(true);
		expect(pseudo?.rows.some(row => row.active && row.segments.some(s => s.text.includes("sleep")))).toBe(true);
	});

	it("失败命令只标一次 ×，不改会话里的原事件", async () => {
		const command = "false first second\n:";
		const trace = new RunTrace(command);
		await new Shell().run({ command, trace });
		const event = update(snapshot(trace));
		const projected = new OrynShellPseudoProjector().project(event);
		const pseudo = pseudoOf(projected);
		const marks = (pseudo?.rows ?? []).flatMap(row => [
			...(row.failMark ? [row] : []),
			...row.segments.filter(s => s.failMark),
		]);
		expect(marks).toHaveLength(1);
		expect(pseudo?.running).toBeUndefined();
		expect(pseudoOf(event)).toBeUndefined();
	});

	it("紧接着的下一条无输出命令立刻标成正在执行，不沿用上一份（执行器只在轨迹变化时发帧）", async () => {
		const command = "sleep 0.12\nsleep 0.6";
		const trace = new RunTrace(command);
		let done = false;
		const run = new Shell().run({ command, trace }).finally(() => {
			done = true;
		});
		const projector = new OrynShellPseudoProjector();
		const activeText = (p: OrynPseudo | undefined) =>
			p?.rows
				.find(row => row.active)
				?.segments.map(s => s.text)
				.join("") ?? "";
		// 像执行器一样只在轨迹版本变化时投一帧；子进程推进只能按条件轮询
		let seen = -1;
		let current = "";
		while (!done && !current.includes("0.6")) {
			if (trace.version() !== seen) {
				seen = trace.version();
				current = activeText(pseudoOf(projector.project(update(snapshot(trace)))));
			}
			await Bun.sleep(5);
		}
		await run;
		expect(current).toContain("sleep 0.6");
	});

	it("非 bash 工具与不带轨迹的帧原样转发", () => {
		const projector = new OrynShellPseudoProjector();
		const other = update({} as ShellTrace, "call-2", "read");
		expect(projector.project(other)).toBe(other);
		const noTrace: AgentSessionEvent = {
			type: "tool_execution_update",
			toolCallId: "call-3",
			toolName: "bash",
			args: {},
			partialResult: { content: [], details: {} },
		};
		expect(projector.project(noTrace)).toBe(noTrace);
	});
});
