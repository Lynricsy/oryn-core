/**
 * Oryn：计划审批的执行档位——TUI 计划审阅「continue with」模型滑条的 RPC 版。
 *
 * 与 TUI（`InteractiveMode` 计划审阅）同一套规则：
 * - 档位是 `cycleOrder` 里解析得到模型的 role（`getRoleModelCycle`），少于两个时不给选择；
 * - 起始档位是 `default`（没有时为当前模型所在档位），执行默认落在默认模型上，与规划用的模型无关；
 * - 所选档位在退出计划模式、恢复进入前模型之后应用（先应用会被恢复覆盖）；与恢复结果同模型、
 *   同思考级别时不切换；切换失败只告警，计划照常执行。
 * 另外追加 `oryn-model-source{source:"role"}`，让 Oryn 回合头显示执行所用的 role。
 */
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { cfgCycleOrder } from "../../config/model-settings";
import type { AgentSession } from "../../session/agent-session";
import type { ConfiguredThinkingLevel } from "../../utils/render-utils";
import type { ResolvedRoleModel } from "../view-model/overlays/model-picker";
import { ORYN_MODEL_SOURCE_ENTRY, type OrynModelSourceData, roleAliasTarget } from "./oryn-model-source";

/** `plan_proposal.tiers` 的一项。 */
export interface RpcPlanExecutionTier {
	role: string;
	provider: string;
	/** 模型 id。 */
	model: string;
	/** 模型显示名（没有时同 id）。 */
	name: string;
	/** role 显式配置的思考级别。 */
	thinkingLevel?: ConfiguredThinkingLevel;
}

/** `plan_proposal` 上的档位字段；少于两个档位时整体省略。 */
export interface RpcPlanExecutionTiers {
	tiers: RpcPlanExecutionTier[];
	/** 宿主的初始选择（TUI 滑条的起始位置）。 */
	defaultTier: string;
}

/** 计划审批控制器用到的档位能力。 */
export interface OrynPlanExecutionTiers {
	/** 当前可选的档位；少于两个时为 `undefined`。 */
	list(): RpcPlanExecutionTiers | undefined;
	/** 按 role 取档位；不在当前档位里时抛错（在任何状态变更之前调用）。 */
	resolve(role: string): ResolvedRoleModel;
	/** 在恢复进入前模型之后应用档位；失败只告警，不抛错。 */
	apply(entry: ResolvedRoleModel): Promise<void>;
}

export type OrynPlanTierSession = Pick<
	AgentSession,
	"getRoleModelCycle" | "applyRoleModel" | "model" | "configuredThinkingLevel" | "sessionManager" | "settings"
>;

export function createOrynPlanExecutionTiers(
	session: OrynPlanTierSession,
	onWarning: (message: string) => void,
): OrynPlanExecutionTiers {
	return {
		list() {
			const c = session.getRoleModelCycle(cfgCycleOrder.get(session.settings));
			if (!c || c.models.length < 2) return undefined;
			const start = c.models.find(entry => entry.role === "default") ?? c.models[c.currentIndex] ?? c.models[0];
			return {
				tiers: c.models.map(entry => ({
					role: entry.role,
					provider: entry.model.provider,
					model: entry.model.id,
					name: entry.model.name || entry.model.id,
					...(entry.explicitThinkingLevel && entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
				})),
				defaultTier: start.role,
			};
		},
		resolve(role) {
			const entry = session
				.getRoleModelCycle(cfgCycleOrder.get(session.settings))
				?.models.find(candidate => candidate.role === role);
			if (!entry) throw new Error(`Unknown plan execution role: ${role}`);
			return entry;
		},
		async apply(entry) {
			const sameModel = modelsAreEqual(session.model, entry.model);
			if (sameModel && (!entry.explicitThinkingLevel || entry.thinkingLevel === session.configuredThinkingLevel())) {
				return;
			}
			try {
				await session.applyRoleModel(entry);
				const model = session.model;
				if (!model || !modelsAreEqual(model, entry.model)) return;
				const alias = roleAliasTarget(session.settings, entry.role);
				const data: OrynModelSourceData = {
					v: 1,
					source: "role",
					model: `${model.provider}/${model.id}`,
					role: entry.role,
					...(alias ? { alias } : {}),
				};
				session.sessionManager.appendCustomEntry(ORYN_MODEL_SOURCE_ENTRY, data);
				await session.sessionManager.ensureOnDisk();
			} catch (error) {
				onWarning(
					`Could not switch to the ${entry.role} model: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
	};
}
