/**
 * Oryn：bash 运行中的 Pseudo 视图（`details.orynPseudo`）。
 *
 * 开着 `display.shellVisualization` 时，bash 每一帧 `tool_execution_update` 的 `partialResult.details.trace`
 * 都带着这次运行最新的执行轨迹；终端用原生 `ShellVisualization` 把它画成 Python 风格的 Pseudo 视图，
 * 浏览器跑不了原生模块。这里在 RPC 转发前用同一个原生实现渲染一次，把压缩后的行写进该帧的
 * `partialResult.details.orynPseudo`，Oryn Web 的 bash 卡片边跑边显示。
 *
 * 轨迹快照已由 bash 执行器绑到活的 `RunTrace` 上（`attachShellTrace`），渲染直接读原生状态，不重新解析。
 * 同一快照只渲染一次（只有输出变了的帧会重复带同一快照）。不另做时间节流：执行器只在轨迹变化时发帧、
 * 且至多每 80 毫秒一次，若沿用旧结果，紧接着的一条无输出长命令会在整段运行里都显示成上一条。
 * 只改转发出去的帧，不碰会话里的事件对象（TUI、扩展与持久化看到的仍是原样）。
 *
 * 最终结果的 Pseudo 由 Oryn 的 orb 扩展在 `tool_result` 里写入（Runner 用的是用户自己的 omp，只能靠扩展），
 * 两处的数据格式必须一致：`{ v: 1, rows, omittedRows?, message?, running? }`。
 */
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import {
	defaultShellVizPreferences,
	readShellPresentation,
	shellVisualization,
} from "@oh-my-pi/pi-tui/tools/shell-viz";
import { isShellTrace, type ShellTrace, type ShellVizPresentation } from "@oh-my-pi/pi-wire";
import type { AgentSessionEvent } from "../../session/agent-session";

/** 超出的行只计数，不发送。 */
export const ORYN_PSEUDO_MAX_ROWS = 400;

/** pseudo 的一个片段：文本 + 样式类（`kw` / `var def` / `str` / `cmd` / `op` / `badge` …，空格分隔）+ 执行状态。 */
export interface OrynPseudoSegment {
	text: string;
	style?: string;
	state?: string;
	/** 同一执行节点第一个失败片段：前面画一个 ×。 */
	failMark?: true;
}

export interface OrynPseudoRow {
	depth: number;
	state?: string;
	/** 整行失败但没有哪个片段失败（且不是控制结构的头 / 中 / 尾行）：行首画 ×。 */
	failMark?: true;
	/** 这一行含正在执行的命令。 */
	active?: true;
	segments: OrynPseudoSegment[];
	/** 行尾读数：耗时、循环次数、分支。 */
	meta?: string;
	/** 这一行设置的变量最新值；truncated 表示值被截断。 */
	annotations?: { name: string; value: string; truncated?: true }[];
	/** 副作用字形（写文件、网络……），排在行首。 */
	effects?: string[];
}

export interface OrynPseudo {
	v: 1;
	rows: OrynPseudoRow[];
	omittedRows?: number;
	message?: string;
	/** 有命令正在执行：除 active 外的内容应弱化。 */
	running?: true;
}

/** 把原生 presentation 压缩成 Web 需要的字段（去掉节点 id、字节范围、执行序号等回放用的数据）。 */
export function compactOrynPseudo(presentation: ShellVizPresentation): OrynPseudo | undefined {
	const rows: OrynPseudoRow[] = [];
	for (const raw of presentation.rows.slice(0, ORYN_PSEUDO_MAX_ROWS)) {
		const failedNodes = new Set<string>();
		let anySegmentFailed = false;
		const segments = raw.segments.map(seg => {
			const out: OrynPseudoSegment = { text: seg.text };
			if (seg.style) out.style = seg.style;
			if (seg.state) out.state = seg.state;
			if (seg.state === "fail") {
				anySegmentFailed = true;
				const node = seg.executionNode ?? seg.node ?? raw.node;
				if (node !== undefined && !failedNodes.has(node)) {
					failedNodes.add(node);
					out.failMark = true;
				}
			}
			return out;
		});
		const row: OrynPseudoRow = { depth: raw.depth, segments };
		if (raw.state) row.state = raw.state;
		if (raw.active) row.active = true;
		if (raw.state === "fail" && !anySegmentFailed && raw.role !== "head" && raw.role !== "mid" && raw.role !== "tail")
			row.failMark = true;
		if (raw.meta) row.meta = raw.meta;
		const annotations = (raw.annotations ?? []).map(a =>
			a.fullLength !== undefined && a.fullLength > Buffer.byteLength(a.value, "utf8")
				? { name: a.name, value: a.value, truncated: true as const }
				: { name: a.name, value: a.value },
		);
		if (annotations.length > 0) row.annotations = annotations;
		const effects = raw.effects.map(e => e.glyph);
		if (effects.length > 0) row.effects = effects;
		rows.push(row);
	}
	if (rows.length === 0) return undefined;
	const pseudo: OrynPseudo = { v: 1, rows };
	if (presentation.rows.length > ORYN_PSEUDO_MAX_ROWS)
		pseudo.omittedRows = presentation.rows.length - ORYN_PSEUDO_MAX_ROWS;
	if (presentation.message) pseudo.message = presentation.message;
	if (presentation.running) pseudo.running = true;
	return pseudo;
}

/** 给转发出去的 bash 运行帧补上 `details.orynPseudo`；其它事件原样返回。 */
export class OrynShellPseudoProjector {
	/** 每个快照的渲染结果；`null` 表示原生拒绝了这份快照，不再重试。 */
	readonly #byTrace = new WeakMap<ShellTrace, OrynPseudo | null>();

	project(event: AgentSessionEvent): AgentSessionEvent {
		if (event.type !== "tool_execution_update" || event.toolName !== "bash") return event;
		const partial: unknown = event.partialResult;
		if (!isRecord(partial) || !isRecord(partial.details) || !isShellTrace(partial.details.trace)) return event;
		const pseudo = this.#pseudoFor(partial.details.trace);
		if (!pseudo) return event;
		return { ...event, partialResult: { ...partial, details: { ...partial.details, orynPseudo: pseudo } } };
	}

	#pseudoFor(trace: ShellTrace): OrynPseudo | undefined {
		const cached = this.#byTrace.get(trace);
		if (cached !== undefined) return cached ?? undefined;
		let pseudo: OrynPseudo | undefined;
		try {
			const source = shellVisualization(trace);
			pseudo = source ? compactOrynPseudo(readShellPresentation(source, defaultShellVizPreferences())) : undefined;
		} catch (error) {
			logger.warn("Live shell pseudo view failed; forwarding the frame without it", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		this.#byTrace.set(trace, pseudo ?? null);
		return pseudo;
	}
}
