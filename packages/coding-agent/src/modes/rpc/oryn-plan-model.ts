/**
 * Oryn：RPC 模式下计划模式的模型切换与恢复控制器。
 *
 * 与 TUI（`InteractiveMode.#applyPlanModeModel` / `#restorePlanPreviousModel` / `#reapplyPlanModeModelOnRoleChange`）
 * 保持同一套策略：
 * - 进入计划模式（`set_plan_mode{enabled:true}`、`plan.defaultOnStartup`）时解析 `plan` role，
 *   记录进入前的模型、思考级别与当前生效的 `oryn-model-source` 来源记录，再按 `resolvePlanModelTransition`
 *   立即或在当前流式回合结束（`agent_end`）后切换到计划模型；
 * - 切到计划模型时追加 `oryn-model-source{source:"role", role:"plan", alias?}`，让 Oryn 回合头显示 `plan` 角色身份；
 * - 计划模式期间 `set_model_role` 改动角色配置时重新解析 `plan` role，不覆盖进入前的保存状态；
 * - 退出计划模式（`set_plan_mode{enabled:false}` 或 `plan_approval` 批准）时取消未落地的挂起计划切换，
 *   并恢复进入前的模型、思考级别与来源记录（`plan_approval` 的 `compact` 路径延后到压缩完成后恢复，
 *   `execute` / `save` 的新会话补写恢复后的来源记录）。
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import type { ModelRoleLookup } from "@oh-my-pi/pi-tui/overlays/model-browser";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { ResolvedModelRoleValue } from "../../config/model-resolver";
import { resolvePlanModelTransition } from "../../plan-mode/model-transition";
import type { AgentSession } from "../../session/agent-session";
import { EPHEMERAL_MODEL_CHANGE_ROLE, PREWALK_MODEL_CHANGE_ROLE } from "../../session/session-entries";
import { ORYN_MODEL_SOURCE_ENTRY, type OrynModelSourceData, roleAliasTarget } from "./oryn-model-source";

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

function modelMatchesRecord(model: Model | undefined, record: OrynModelSourceData): boolean {
	if (!model) return false;
	return `${model.provider}/${model.id}`.toLowerCase() === record.model.toLowerCase();
}

export interface OrynPlanModelControllerDeps {
	session: OrynPlanModelSession;
	onWarning?: (message: string) => void;
}

export class OrynPlanModelController {
	readonly #session: OrynPlanModelSession;
	readonly #onWarning?: (message: string) => void;
	#previousState: PreviousPlanModelState | undefined;
	#pendingSwitch: PendingPlanModelSwitch | undefined;
	/** 每次状态迁移递增，防止并发异步切换落地后写入过时的来源记录。 */
	#generation = 0;

	constructor(deps: OrynPlanModelControllerDeps) {
		this.#session = deps.session;
		this.#onWarning = deps.onWarning;
	}

	/** 是否有待在 `agent_end` 落地的挂起模型切换。 */
	get hasPendingSwitch(): boolean {
		return this.#pendingSwitch !== undefined;
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
		if (!prev) return undefined;
		await this.#restorePrevious(prev);
		return prev.sourceRecord;
	}

	/** `plan_approval` 的 `compact` 路径在压缩结束后恢复进入前模型（幂等）。 */
	async applyDeferredRestore(): Promise<void> {
		const prev = this.#previousState;
		if (!prev) return;
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
			} else if (pending.sourceRecord && modelMatchesRecord(this.#session.model, pending.sourceRecord)) {
				await this.#appendSourceRecord(pending.sourceRecord);
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
			if (
				landed &&
				gen === this.#generation &&
				prev.sourceRecord &&
				modelMatchesRecord(this.#session.model, prev.sourceRecord)
			) {
				await this.#appendSourceRecord(prev.sourceRecord);
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

	async #appendSourceRecord(data: OrynModelSourceData): Promise<void> {
		this.#session.sessionManager.appendCustomEntry(ORYN_MODEL_SOURCE_ENTRY, data);
		await this.#session.sessionManager.ensureOnDisk();
	}
}
