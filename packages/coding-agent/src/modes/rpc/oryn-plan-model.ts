/**
 * Oryn：RPC 模式下计划模式的模型切换、恢复与跨重启基线持久化控制器。
 *
 * 与 TUI（`InteractiveMode.#applyPlanModeModel` / `#restorePlanPreviousModel` / `#reapplyPlanModeModelOnRoleChange`）
 * 保持同一套策略，并补齐跨进程重启（`open_session` / `switch_session`）的持久化契约：
 * - 进入计划模式（`set_plan_mode{enabled:true}`、`plan.defaultOnStartup`）时解析 `plan` role，
 *   保存进入前的模型、思考级别与当前生效的 `oryn-model-source` 来源记录，立即或在流式结束（`agent_end`）
 *   后切换到计划模型；同时落盘 `oryn-plan-baseline{active:true, ...}`（与 `mode_change:"plan"` 配合）；
 * - 切到计划模型时追加 `oryn-model-source{source:"role", role:"plan", alias?}`，让 Oryn 回合头显示 `plan` 角色身份；
 * - 流式回合内关闭再重入计划模式时取消挂起恢复并继承原基线，避免误把计划模型当成新基线；
 * - 计划模式期间 `set_model_role` 改动角色配置时重新应用 `plan` role，不覆盖进入前基线；
 * - 退出计划模式（`set_plan_mode{enabled:false}` 或 `plan_approval` 批准）时取消未落地的挂起计划切换，
 *   恢复进入前的模型、思考级别与来源记录，并落盘 `oryn-plan-baseline{active:false}`（`compact` 路径延后到
 *   压缩完成后恢复，`execute` / `save` 在 `newSession()` 后补写来源记录）；
 * - 重启经 `open_session` / `switch_session` 打开持久化会话时：
 *   - 若会话仍处于计划模式且传入的显式模型恰好等于持久基线（Oryn 冷重启回传线程常驻基线），不覆盖当前计划模型；
 *   - 从活动分支恢复 `planModeState`、`planApprovalController` 与 `#previousState` 基线，保证重启后继续在计划模型
 *     工作、退出或审批后仍恢复最初原模型；若会话已不在计划模式但残留 `active:true` 基线，兜底恢复原模型。
 */
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import type { ModelRoleLookup } from "@oh-my-pi/pi-tui/overlays/model-browser";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { ResolvedModelRoleValue } from "../../config/model-resolver";
import { resolvePlanModelTransition } from "../../plan-mode/model-transition";
import type { AgentSession } from "../../session/agent-session";
import {
	EPHEMERAL_MODEL_CHANGE_ROLE,
	PREWALK_MODEL_CHANGE_ROLE,
	resolveSessionLeafId,
	type SessionEntry,
} from "../../session/session-entries";
import { findMostRecentNonEmptySession, findRecentSessionContinuation } from "../../session/session-listing";
import { loadEntriesFromFile } from "../../session/session-loader";
import { ORYN_MODEL_SOURCE_ENTRY, type OrynModelSourceData, roleAliasTarget } from "./oryn-model-source";

/** 计划模式进入前基线的自定义条目 `customType`（不进 LLM 上下文，对上游透明）。 */
export const ORYN_PLAN_BASELINE_ENTRY = "oryn-plan-baseline";

export interface OrynPlanBaselineData {
	v: 1;
	active: boolean;
	/** 进入计划模式前的活动模型 `provider/id`；`active: true` 时存在。 */
	model?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	sourceRecord?: OrynModelSourceData;
}

/** 控制器用到的会话能力；`AgentSession` 结构上满足。 */
export type OrynPlanModelSession = Pick<
	AgentSession,
	| "model"
	| "isStreaming"
	| "sessionManager"
	| "configuredThinkingLevel"
	| "getPlanModeState"
	| "resolveRoleModelWithThinking"
	| "setModelTemporary"
	| "setThinkingLevel"
> & {
	readonly settings: ModelRoleLookup;
	readonly restrictToolNames?: boolean;
	setPlanModeState?: AgentSession["setPlanModeState"];
	getAvailableModels?: AgentSession["getAvailableModels"];
	readonly modelRegistry?: Pick<AgentSession["modelRegistry"], "awaitBackgroundRefresh">;
};

interface PreviousPlanModelState {
	model: Model;
	thinkingLevel: ConfiguredThinkingLevel | undefined;
	sourceRecord?: OrynModelSourceData;
}

type PendingPlanModelSwitch =
	| {
			kind: "plan";
			model: Model;
			thinkingLevel: ConfiguredThinkingLevel | undefined;
	  }
	| {
			kind: "restore";
			model: Model;
			thinkingLevel: ConfiguredThinkingLevel | undefined;
			sourceRecord?: OrynModelSourceData;
	  };

const VALID_SOURCES: Record<OrynModelSourceData["source"], true> = {
	role: true,
	manual: true,
	startup: true,
};

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseSourceData(data: unknown): OrynModelSourceData | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const d = data as Record<string, unknown>;
	const source =
		typeof d.source === "string" && Object.hasOwn(VALID_SOURCES, d.source)
			? (d.source as OrynModelSourceData["source"])
			: undefined;
	const model = nonEmpty(d.model);
	if (d.v !== 1 || !source || !model) return undefined;
	const role = nonEmpty(d.role);
	const alias = nonEmpty(d.alias);
	return {
		v: 1,
		source,
		model,
		...(role ? { role } : {}),
		...(alias ? { alias } : {}),
	};
}

function parseBaselineData(data: unknown): OrynPlanBaselineData | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const d = data as Record<string, unknown>;
	if (d.v !== 1 || typeof d.active !== "boolean") return undefined;
	if (!d.active) return { v: 1, active: false };
	const model = nonEmpty(d.model);
	if (!model) return undefined;
	const thinkingLevel = nonEmpty(d.thinkingLevel) as ConfiguredThinkingLevel | undefined;
	const sourceRecord = parseSourceData(d.sourceRecord);
	return {
		v: 1,
		active: true,
		model,
		...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
		...(sourceRecord ? { sourceRecord } : {}),
	};
}

/**
 * 沿当前活动分支扫描当前生效的 `oryn-model-source` 记录（规则同 Oryn `web/src/lib/turn-role.ts` `advanceTrail`）：
 * `fallback` / `prewalk` 临时覆盖不清除记录，其它未记录来源的 `model_change` 让记录失效；
 * 最终记录的 `model` 必须与 `activeModel` 匹配。
 */
function readCurrentModelSource(
	sessionManager: OrynPlanModelSession["sessionManager"],
	activeModel: Model,
): OrynModelSourceData | undefined {
	let current: OrynModelSourceData | undefined;
	for (const entry of sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === ORYN_MODEL_SOURCE_ENTRY) {
			const parsed = parseSourceData(entry.data);
			if (parsed) current = parsed;
			continue;
		}
		if (entry.type === "model_change") {
			if (entry.role === EPHEMERAL_MODEL_CHANGE_ROLE || entry.role === PREWALK_MODEL_CHANGE_ROLE) continue;
			current = undefined;
		}
	}
	if (!current) return undefined;
	const activeKey = `${activeModel.provider}/${activeModel.id}`.toLowerCase();
	return current.model.toLowerCase() === activeKey ? current : undefined;
}

interface BranchPlanState {
	mode: string;
	planFilePath?: string;
	baseline?: OrynPlanBaselineData;
}

function readBranchPlanState(branch: readonly SessionEntry[]): BranchPlanState {
	let mode = "none";
	let planFilePath: string | undefined;
	let baseline: OrynPlanBaselineData | undefined;
	for (const entry of branch) {
		if (entry.type === "mode_change") {
			mode = entry.mode;
			planFilePath = typeof entry.data?.planFilePath === "string" ? entry.data.planFilePath : undefined;
		} else if (entry.type === "custom" && entry.customType === ORYN_PLAN_BASELINE_ENTRY) {
			const parsed = parseBaselineData(entry.data);
			if (parsed) baseline = parsed;
		}
	}
	return { mode, planFilePath, baseline };
}

async function readActiveBranchFromFile(sessionFile: string): Promise<SessionEntry[]> {
	try {
		const raw = await loadEntriesFromFile(sessionFile);
		const entries = raw.filter((e): e is SessionEntry => e.type !== "session");
		const leafId = resolveSessionLeafId(entries);
		if (!leafId) return [];
		const byId = new Map<string, SessionEntry>();
		for (const e of entries) byId.set(e.id, e);
		const branch: SessionEntry[] = [];
		for (let cur = byId.get(leafId); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
			branch.push(cur);
		}
		branch.reverse();
		return branch;
	} catch {
		return [];
	}
}

function modelMatchesRecord(model: Model | undefined, record: OrynModelSourceData): boolean {
	if (!model) return false;
	return `${model.provider}/${model.id}`.toLowerCase() === record.model.toLowerCase();
}

async function findModelByKey(session: OrynPlanModelSession, key: string): Promise<Model | undefined> {
	const slash = key.indexOf("/");
	if (slash <= 0 || slash === key.length - 1 || !session.getAvailableModels) return undefined;
	const provider = key.slice(0, slash);
	const id = key.slice(slash + 1);
	const find = () =>
		session
			.getAvailableModels?.()
			.find(m => m.provider.toLowerCase() === provider.toLowerCase() && m.id.toLowerCase() === id.toLowerCase());
	const found = find();
	if (found) return found;
	await session.modelRegistry?.awaitBackgroundRefresh();
	return find();
}

export interface OrynPlanModelControllerDeps {
	session: OrynPlanModelSession;
	isPlanEnabled?: () => boolean;
	onWarning?: (message: string) => void;
}

export class OrynPlanModelController {
	readonly #session: OrynPlanModelSession;
	readonly #isPlanEnabled: () => boolean;
	readonly #onWarning?: (message: string) => void;
	#previousState: PreviousPlanModelState | undefined;
	#pendingSwitch: PendingPlanModelSwitch | undefined;
	#baselinePersisted = false;
	/** 每次状态迁移递增，防止并发异步切换落地后写入过时的来源记录。 */
	#generation = 0;

	constructor(deps: OrynPlanModelControllerDeps) {
		this.#session = deps.session;
		this.#isPlanEnabled = deps.isPlanEnabled ?? (() => true);
		this.#onWarning = deps.onWarning;
	}

	/** 是否有待在 `agent_end` 落地的挂起模型切换。 */
	get hasPendingSwitch(): boolean {
		return this.#pendingSwitch !== undefined;
	}

	/**
	 * `open_session` 前置过滤：若目标会话目录里最新会话仍处于计划模式，且传入的 `requestedModel`
	 * 恰好等于持久化的进入前基线（如 Oryn 控制面冷重启时回传的线程常驻模型），返回 `undefined`，
	 * 让 `openRpcSession` 保留磁盘上的计划模型，不把临时计划态冲回基线也不写多余的 `model_change`。
	 */
	async filterRequestedModelForOpenSession(
		sessionDir: string,
		requestedModel: Model | undefined,
	): Promise<Model | undefined> {
		if (!requestedModel || this.#session.restrictToolNames || !this.#isPlanEnabled()) return requestedModel;
		const dir = path.resolve(sessionDir);
		const recent = await findMostRecentNonEmptySession(dir);
		const latest = recent ? ((await findRecentSessionContinuation(recent))?.session.path ?? recent) : null;
		if (!latest) return requestedModel;
		return this.filterRequestedModelForSessionFile(latest, requestedModel);
	}

	/** `switch_session` 与 `open_session` 共用的单文件基线比对。 */
	async filterRequestedModelForSessionFile(
		sessionFile: string,
		requestedModel: Model | undefined,
	): Promise<Model | undefined> {
		if (!requestedModel || this.#session.restrictToolNames || !this.#isPlanEnabled()) return requestedModel;
		const branch = await readActiveBranchFromFile(sessionFile);
		const { mode, baseline } = readBranchPlanState(branch);
		if (mode !== "plan" || !baseline?.active || !baseline.model) return requestedModel;
		const reqKey = `${requestedModel.provider}/${requestedModel.id}`.toLowerCase();
		return baseline.model.toLowerCase() === reqKey ? undefined : requestedModel;
	}

	/**
	 * 会话启动恢复或 `open_session` / `switch_session` 切换文件后对账计划模式与基线：
	 * - 活动分支停在 `mode_change:"plan"`：恢复 `planModeState`、`planApprovalController` 与持久化的原基线；
	 *   若上次流式期间进入计划模式尚未切到计划模型就中断重启，顺带补齐切换。
	 * - 活动分支不在计划模式但残留 `oryn-plan-baseline{active:true}`：兜底恢复原基线并标记结束，
	 *   防止临时计划模型变成常驻模型。
	 */
	async reconcileAfterSessionOpen(syncApproval: () => void): Promise<void> {
		this.reset();
		const { mode, planFilePath, baseline } = readBranchPlanState(this.#session.sessionManager.getBranch());
		if (mode === "plan" && !this.#session.restrictToolNames && this.#isPlanEnabled()) {
			this.#session.setPlanModeState?.({
				enabled: true,
				planFilePath: planFilePath ?? "local://PLAN.md",
			});
			syncApproval();
			if (baseline?.active && baseline.model) {
				const model = await findModelByKey(this.#session, baseline.model);
				if (model) {
					this.#previousState = {
						model,
						thinkingLevel: baseline.thinkingLevel,
						sourceRecord: baseline.sourceRecord,
					};
					this.#baselinePersisted = true;
				}
			}
			const resolved = this.#session.resolveRoleModelWithThinking("plan");
			if (
				resolved.model &&
				this.#previousState &&
				modelsAreEqual(this.#session.model, this.#previousState.model) &&
				!modelsAreEqual(this.#session.model, resolved.model)
			) {
				await this.#applyPlanTransition(this.#session.model, resolved);
			}
			return;
		}

		this.#session.setPlanModeState?.(undefined);
		syncApproval();
		if (baseline?.active && baseline.model) {
			const model = await findModelByKey(this.#session, baseline.model);
			if (model) {
				this.#baselinePersisted = true;
				await this.#restorePrevious({
					model,
					thinkingLevel: baseline.thinkingLevel,
					sourceRecord: baseline.sourceRecord,
				});
			}
		}
	}

	/** 进入计划模式时解析 `plan` role，保存进入前模型并应用计划模型。 */
	async onEnterPlanMode(): Promise<void> {
		const resolved = this.#session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) return;

		const currentModel = this.#session.model;
		// 上一次退出在流式期间留下的挂起恢复：重入计划模式时取消它并继承其中的原始基线，
		// 避免回合结束在计划模式里误切回原模型，也避免把当前计划模型当成新的恢复基线。
		let inheritedRestore = false;
		if (this.#pendingSwitch?.kind === "restore") {
			const pending = this.#pendingSwitch;
			this.#pendingSwitch = undefined;
			this.#generation++;
			this.#previousState = {
				model: pending.model,
				thinkingLevel: pending.thinkingLevel,
				sourceRecord: pending.sourceRecord,
			};
			inheritedRestore = true;
		}

		const capturedHere = !inheritedRestore && this.#previousState === undefined;
		if (capturedHere && currentModel) {
			this.#previousState = {
				model: currentModel,
				thinkingLevel: this.#session.configuredThinkingLevel(),
				sourceRecord: readCurrentModelSource(this.#session.sessionManager, currentModel),
			};
		}

		const applied = await this.#applyPlanTransition(currentModel, resolved);
		if (!applied && capturedHere) {
			this.#previousState = undefined;
			return;
		}
		if (applied && this.#previousState && !this.#baselinePersisted) {
			await this.#persistBaselineActive(this.#previousState);
		}
	}

	/** 计划模式激活期间角色配置变更时重新应用 `plan` role，不覆盖进入前保存的模型。 */
	async onRoleConfigChanged(): Promise<void> {
		if (!this.#session.getPlanModeState()?.enabled) return;
		const resolved = this.#session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) {
			this.#clearPendingPlanSwitch();
			return;
		}
		const currentModel = this.#session.model;
		const capturedHere = this.#previousState === undefined;
		if (capturedHere && currentModel) {
			this.#previousState = {
				model: currentModel,
				thinkingLevel: this.#session.configuredThinkingLevel(),
				sourceRecord: readCurrentModelSource(this.#session.sessionManager, currentModel),
			};
		}
		const applied = await this.#applyPlanTransition(currentModel, resolved);
		if (!applied && capturedHere) {
			this.#previousState = undefined;
			return;
		}
		if (applied && this.#previousState && !this.#baselinePersisted) {
			await this.#persistBaselineActive(this.#previousState);
		}
	}

	/**
	 * 退出计划模式：清除未落地的计划模型挂起切换，并立即恢复进入前模型（除非 `deferModelRestore` 为真）。
	 * 返回进入前保存的来源记录（供 `plan_approval` 的 `execute` / `save` 在 `newSession()` 后补写）。
	 */
	async onExitPlanMode(options?: { deferModelRestore?: boolean }): Promise<OrynModelSourceData | undefined> {
		this.#clearPendingPlanSwitch();
		if (options?.deferModelRestore) return undefined;
		const prev = this.#previousState;
		this.#previousState = undefined;
		if (!prev) {
			if (this.#baselinePersisted) await this.#persistBaselineInactive();
			return undefined;
		}
		await this.#restorePrevious(prev);
		return prev.sourceRecord;
	}

	/** `plan_approval` 的 `compact` 路径在压缩结束后恢复进入前模型（幂等）。 */
	async applyDeferredRestore(): Promise<void> {
		const prev = this.#previousState;
		if (!prev) {
			if (this.#baselinePersisted) await this.#persistBaselineInactive();
			return;
		}
		this.#previousState = undefined;
		await this.#restorePrevious(prev);
	}

	/** `plan_approval` 的 `execute` / `save` 在 `newSession()` 后把进入前的来源记录补写到新会话。 */
	async recordRestoredSourceAfterNewSession(sourceRecord: OrynModelSourceData | undefined): Promise<void> {
		if (!sourceRecord || !modelMatchesRecord(this.#session.model, sourceRecord)) return;
		await this.#appendSourceRecord(sourceRecord);
	}

	/** 流式回合结束（`agent_end`）时落地挂起的模型切换。 */
	async flushPendingSwitch(): Promise<void> {
		const pending = this.#pendingSwitch;
		if (!pending) return;
		this.#pendingSwitch = undefined;
		const gen = ++this.#generation;
		try {
			await this.#session.setModelTemporary(pending.model, pending.thinkingLevel);
			const landed = modelsAreEqual(this.#session.model, pending.model);
			if (!landed || gen !== this.#generation) return;
			if (pending.kind === "plan") {
				await this.#recordPlanSource();
			} else {
				if (pending.sourceRecord && modelMatchesRecord(this.#session.model, pending.sourceRecord)) {
					await this.#appendSourceRecord(pending.sourceRecord);
				}
				if (this.#baselinePersisted) await this.#persistBaselineInactive();
			}
		} catch (error) {
			this.#onWarning?.(
				`Failed to switch model after streaming: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** 用户手动切换模型后丢弃挂起的切换，避免回合结束时覆盖手动选择。 */
	clearPendingSwitch(): void {
		if (!this.#pendingSwitch) return;
		this.#pendingSwitch = undefined;
		this.#generation++;
	}

	/** 切换会话文件（`new_session` / `switch_session` / `open_session` 等）时清空上一会话的计划模式模型状态。 */
	reset(): void {
		this.#previousState = undefined;
		this.#pendingSwitch = undefined;
		this.#baselinePersisted = false;
		this.#generation++;
	}

	#clearPendingPlanSwitch(): void {
		if (this.#pendingSwitch?.kind !== "plan") return;
		this.#pendingSwitch = undefined;
		this.#generation++;
	}

	async #applyPlanTransition(currentModel: Model | undefined, resolved: ResolvedModelRoleValue): Promise<boolean> {
		const transition = resolvePlanModelTransition(currentModel, resolved, this.#session.isStreaming);
		if (transition.kind !== "apply" || !transition.deferred) {
			this.#clearPendingPlanSwitch();
		}
		switch (transition.kind) {
			case "none":
				return true;
			case "thinking":
				this.#session.setThinkingLevel(transition.thinkingLevel);
				return true;
			case "apply": {
				if (transition.deferred) {
					this.#pendingSwitch = {
						kind: "plan",
						model: transition.model,
						thinkingLevel: transition.thinkingLevel,
					};
					return true;
				}
				const gen = ++this.#generation;
				try {
					await this.#session.setModelTemporary(transition.model, transition.thinkingLevel);
					const landed = modelsAreEqual(this.#session.model, transition.model);
					if (landed && gen === this.#generation) {
						await this.#recordPlanSource();
					}
					return landed;
				} catch (error) {
					this.#onWarning?.(
						`Failed to switch to plan model for plan mode: ${error instanceof Error ? error.message : String(error)}`,
					);
					return false;
				}
			}
		}
	}

	async #restorePrevious(prev: PreviousPlanModelState): Promise<void> {
		if (modelsAreEqual(this.#session.model, prev.model)) {
			this.#session.setThinkingLevel(prev.thinkingLevel);
			if (this.#baselinePersisted) await this.#persistBaselineInactive();
			return;
		}
		if (this.#session.isStreaming) {
			this.#pendingSwitch = {
				kind: "restore",
				model: prev.model,
				thinkingLevel: prev.thinkingLevel,
				sourceRecord: prev.sourceRecord,
			};
			return;
		}
		const gen = ++this.#generation;
		try {
			await this.#session.setModelTemporary(prev.model, prev.thinkingLevel);
			const landed = modelsAreEqual(this.#session.model, prev.model);
			if (landed && gen === this.#generation) {
				if (prev.sourceRecord && modelMatchesRecord(this.#session.model, prev.sourceRecord)) {
					await this.#appendSourceRecord(prev.sourceRecord);
				}
				if (this.#baselinePersisted) await this.#persistBaselineInactive();
			}
		} catch (error) {
			this.#onWarning?.(
				`Failed to restore previous model after plan mode: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #recordPlanSource(): Promise<void> {
		const model = this.#session.model;
		if (!model) return;
		const alias = roleAliasTarget(this.#session.settings, "plan");
		const data: OrynModelSourceData = {
			v: 1,
			source: "role",
			model: `${model.provider}/${model.id}`,
			role: "plan",
			...(alias ? { alias } : {}),
		};
		await this.#appendSourceRecord(data);
	}

	async #persistBaselineActive(prev: PreviousPlanModelState): Promise<void> {
		const data: OrynPlanBaselineData = {
			v: 1,
			active: true,
			model: `${prev.model.provider}/${prev.model.id}`,
			...(prev.thinkingLevel !== undefined ? { thinkingLevel: prev.thinkingLevel } : {}),
			...(prev.sourceRecord ? { sourceRecord: prev.sourceRecord } : {}),
		};
		this.#session.sessionManager.appendCustomEntry(ORYN_PLAN_BASELINE_ENTRY, data);
		await this.#session.sessionManager.ensureOnDisk();
		this.#baselinePersisted = true;
	}

	async #persistBaselineInactive(): Promise<void> {
		const data: OrynPlanBaselineData = { v: 1, active: false };
		this.#session.sessionManager.appendCustomEntry(ORYN_PLAN_BASELINE_ENTRY, data);
		await this.#session.sessionManager.ensureOnDisk();
		this.#baselinePersisted = false;
	}

	async #appendSourceRecord(data: OrynModelSourceData): Promise<void> {
		this.#session.sessionManager.appendCustomEntry(ORYN_MODEL_SOURCE_ENTRY, data);
		await this.#session.sessionManager.ensureOnDisk();
	}
}
