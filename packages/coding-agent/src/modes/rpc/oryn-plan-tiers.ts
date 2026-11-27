/**
 * Oryn：计划审批的执行档位——TUI 计划审阅「continue with」模型滑条的 RPC 版。
 *
 * 与 TUI（`InteractiveMode` 计划审阅）同一套规则：
 * - 档位是 `cycleOrder` 里解析得到模型的 role（`getRoleModelCycle`），少于两个时不给选择；
 * - 起始档位是 `default`（没有时为当前模型所在档位），执行默认落在默认模型上，与规划用的模型无关；
 * - 审批只认提案发出时的档位快照（TUI 用打开审阅时取的 cycle），审阅期间改了 role 配置也不会换成没展示过的模型；
 * - 所选档位作为退出计划模式时的恢复目标（`OrynPlanModelController.setExecutionTarget`），
 *   流式延后、compact 延后、新会话补写来源记录与基线落盘都沿用恢复路径；
 * - `keep_context` 在目标模型窗口已用超过 95% 时拒绝（TUI 同阈值禁用该选项），让宿主改选 compact / execute。
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { cfgCycleOrder } from "../../config/model-settings";
import type { AgentSession } from "../../session/agent-session";
import type { ConfiguredThinkingLevel } from "../../utils/render-utils";
import type { ResolvedRoleModel } from "../view-model/overlays/model-picker";
import { type OrynModelSourceData, roleAliasTarget } from "./oryn-model-source";

/** TUI `PLAN_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT`：上下文超过目标窗口的这个比例时不能保留上下文执行。 */
const KEEP_CONTEXT_MAX_PERCENT = 95;

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

/** 退出计划模式时的恢复目标（见 `OrynPlanModelController.setExecutionTarget`）。 */
export interface OrynPlanExecutionTarget {
	model: Model;
	/** role 显式配置的思考级别；没有时沿用进入前基线的级别。 */
	thinkingLevel: ConfiguredThinkingLevel | undefined;
	sourceRecord: OrynModelSourceData;
}

/** 档位快照的一项：解析结果加发帧时的 role 别名（审阅期间改别名不影响记录）。 */
export interface OrynPlanTierEntry extends ResolvedRoleModel {
	alias?: string;
}

/** 计划审批控制器用到的档位能力。 */
export interface OrynPlanExecutionTiers {
	/** 发提案时取档位快照：`wire` 进帧，`entries` 留给审批校验；少于两个档位时为 `undefined`。 */
	snapshot(): { wire: RpcPlanExecutionTiers; entries: OrynPlanTierEntry[] } | undefined;
	/** 把退出计划模式时的恢复目标换成该档位（在退出计划模式之前调用）。 */
	select(entry: OrynPlanTierEntry): void;
	/** `keep_context` 前检查：上下文装不进 `model` 的窗口（超过 95%）时抛错。 */
	assertKeepContextFits(model: Model): void;
}

export type OrynPlanTierSession = Pick<AgentSession, "getRoleModelCycle" | "getContextUsage" | "settings">;

export function createOrynPlanExecutionTiers(
	session: OrynPlanTierSession,
	setExecutionTarget: (target: OrynPlanExecutionTarget) => void,
): OrynPlanExecutionTiers {
	return {
		snapshot() {
			const cycle = session.getRoleModelCycle(cfgCycleOrder.get(session.settings));
			if (!cycle || cycle.models.length < 2) return undefined;
			const start =
				cycle.models.find(entry => entry.role === "default") ?? cycle.models[cycle.currentIndex] ?? cycle.models[0];
			return {
				wire: {
					tiers: cycle.models.map(entry => ({
						role: entry.role,
						provider: entry.model.provider,
						model: entry.model.id,
						name: entry.model.name || entry.model.id,
						...(entry.explicitThinkingLevel && entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
					})),
					defaultTier: start.role,
				},
				entries: cycle.models.map(entry => {
					const alias = roleAliasTarget(session.settings, entry.role);
					return alias ? { ...entry, alias } : entry;
				}),
			};
		},
		select(entry) {
			setExecutionTarget({
				model: entry.model,
				thinkingLevel: entry.explicitThinkingLevel ? entry.thinkingLevel : undefined,
				sourceRecord: {
					v: 1,
					source: "role",
					model: `${entry.model.provider}/${entry.model.id}`,
					role: entry.role,
					...(entry.alias ? { alias: entry.alias } : {}),
				},
			});
		},
		assertKeepContextFits(model) {
			const usage = session.getContextUsage(
				typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : undefined,
			);
			if (usage && usage.percent > KEEP_CONTEXT_MAX_PERCENT) {
				throw new Error(
					`Context is over ${KEEP_CONTEXT_MAX_PERCENT}% full for ${model.name || model.id}; approve with compact or execute instead`,
				);
			}
		},
	};
}
