/**
 * Oryn：模型选择来源记录（`oryn_select_model` / `oryn_mark_session_start`）。
 *
 * omp 把「点 role」「手动选模型」「启动时按 default role 解析」都写成 `model_change`，
 * 其中 role 字段只服务于 omp 自己的恢复语义，分不出选择是怎么发生的。这里在选择发生的
 * 那一刻追加一条 `custom` 条目 `oryn-model-source`，Oryn 客户端只凭它判定回合的 role。
 * `model_change` 与 `setModel` 的行为保持 omp 原样；custom 条目不进 LLM 上下文，
 * fork / 分支 / 压缩都保留在路径上。
 */
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRoleLookup } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { normalizeModelPatternList, resolveExplicitModelRole } from "../../config/model-resolver";
import type { AgentSession } from "../../session/agent-session";

/** 来源条目的 `customType`。 */
export const ORYN_MODEL_SOURCE_ENTRY = "oryn-model-source";

/** 来源条目的 `data`（版本 1）。 */
export interface OrynModelSourceData {
	v: 1;
	source: "role" | "manual" | "startup";
	/** 写入时的活动模型，格式同 `model_change.model`（`provider/modelId`）。 */
	model: string;
	/** `role`：被点的 role id；`startup`：恒为 `"default"`；`manual`：没有。 */
	role?: string;
	/** role 的配置值是指向另一个 role 的单一别名时，那个 role（只跟一跳）。 */
	alias?: string;
}

export type OrynRpcCommand =
	| {
			id?: string;
			type: "oryn_select_model";
			role?: string;
			provider?: string;
			modelId?: string;
			/** 新线程按创建时选的 role 开场（控制面首批命令）；手动选 role 不带。 */
			startup?: boolean;
			/** 选完后再设的思考级别（压过 role 自带的）。 */
			thinkingLevel?: ThinkingLevel | "auto";
	  }
	| { id?: string; type: "oryn_mark_session_start"; explicitModel?: boolean };

export interface OrynSelectModelResult {
	model: Model;
	thinkingLevel?: ThinkingLevel;
	source: "role" | "manual";
	role?: string;
	alias?: string;
	/** 会话已在计划模式：启动 role 只记作进入前基线，活动模型保持计划模型，退出计划模式时切到它。 */
	baseline?: boolean;
}

export interface OrynMarkSessionStartResult {
	recorded: boolean;
	source?: "startup" | "manual";
	role?: string;
	alias?: string;
	model?: string;
}

export type OrynRpcResponse =
	| { id?: string; type: "response"; command: "oryn_select_model"; success: true; data: OrynSelectModelResult }
	| {
			id?: string;
			type: "response";
			command: "oryn_mark_session_start";
			success: true;
			data: OrynMarkSessionStartResult;
	  };

/** 两条命令用到的会话能力；`AgentSession` 结构上满足。 */
export type OrynModelSourceSession = Pick<
	AgentSession,
	| "sessionManager"
	| "model"
	| "thinkingLevel"
	| "getAvailableModels"
	| "setModel"
	| "applyRoleModel"
	| "resolveRoleModelWithThinking"
> & {
	readonly settings: ModelRoleLookup;
	readonly modelRegistry: Pick<AgentSession["modelRegistry"], "awaitBackgroundRefresh">;
	setThinkingLevel?: AgentSession["setThinkingLevel"];
};

export interface OrynSelectModelHooks {
	/**
	 * `startup` 选 role 时先问计划模式控制器：返回 `true` 表示该 role 已改作计划模式的进入前基线，不再切模型。
	 */
	adoptStartupRole?: (role: string, thinkingLevel: ThinkingLevel | "auto" | undefined) => Promise<boolean>;
}

/**
 * `role` 的配置值恰好是一个指向别的 role 的别名（`@x`、`@x:high`、`pi/x`、`*`）时返回那个 role。
 * 回退链 / 多个值、具体模型、未知 role、指向自己都返回 `undefined`；只走一跳。
 * 别名识别直接用 omp 的 `resolveExplicitModelRole`，与 omp 解析 role 时的判定一致。
 */
export function roleAliasTarget(settings: ModelRoleLookup, role: string): string | undefined {
	const patterns = normalizeModelPatternList(settings.getModelRole(role));
	if (patterns.length !== 1) return undefined;
	const target = resolveExplicitModelRole(patterns[0], settings);
	return target === role ? undefined : target;
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

async function findModel(session: OrynModelSourceSession, provider: string, modelId: string) {
	const find = () => session.getAvailableModels().find(m => m.provider === provider && m.id === modelId);
	const model = find();
	if (model) return model;
	await session.modelRegistry.awaitBackgroundRefresh();
	return find();
}

async function recordSource(session: OrynModelSourceSession, data: OrynModelSourceData): Promise<void> {
	session.sessionManager.appendCustomEntry(ORYN_MODEL_SOURCE_ENTRY, data);
	// 会话文件默认要到第一条助手消息才落盘；提前落盘让记录在首条回复流式期间就可读。
	await session.sessionManager.ensureOnDisk();
}

/**
 * `oryn_select_model`：按 role 或 provider + modelId 切换模型，并记下来源。切换失败时不写记录。
 * `startup` + role 且会话已在计划模式时，role 只记作进入前基线（见 {@link OrynSelectModelHooks.adoptStartupRole}）。
 */
export async function handleOrynSelectModel(
	session: OrynModelSourceSession,
	command: { role?: unknown; provider?: unknown; modelId?: unknown; startup?: unknown; thinkingLevel?: unknown },
	hooks: OrynSelectModelHooks = {},
): Promise<OrynSelectModelResult> {
	const { role, provider, modelId } = command;
	const thinkingLevel = nonEmpty(command.thinkingLevel)
		? (command.thinkingLevel as ThinkingLevel | "auto")
		: undefined;
	if (thinkingLevel !== undefined && !session.setThinkingLevel) throw new Error("thinkingLevel is not supported");
	let selectedRole: string | undefined;
	if (
		command.startup === true &&
		nonEmpty(role) &&
		provider === undefined &&
		modelId === undefined &&
		(await hooks.adoptStartupRole?.(role, thinkingLevel))
	) {
		const model = session.model;
		if (!model) throw new Error("No active model");
		const alias = roleAliasTarget(session.settings, role);
		return {
			model,
			thinkingLevel: session.thinkingLevel,
			source: "role",
			role,
			...(alias ? { alias } : {}),
			baseline: true,
		};
	}
	if (nonEmpty(role) && provider === undefined && modelId === undefined) {
		let resolved = session.resolveRoleModelWithThinking(role);
		// 会话刚启动时只有内置目录与 models.yml 静态模型，靠远端发现的模型（如 google/gemini-4-neon）还没到：
		// 解析不到或只落到回退 pattern 时先等后台发现，再按完整目录重新解析，避免误用回退链或报错后沿用 default。
		if (!resolved.model || (resolved.matchedPatternIndex ?? 0) > 0) {
			await session.modelRegistry.awaitBackgroundRefresh();
			resolved = session.resolveRoleModelWithThinking(role);
		}
		if (!resolved.model) throw new Error(`Role has no available model: ${role}`);
		// 内部 `setModel(model, role)` 写 `model_change{role}`，并应用 role 显式配置的思考级别。
		await session.applyRoleModel({
			role,
			model: resolved.model,
			thinkingLevel: resolved.thinkingLevel,
			explicitThinkingLevel: resolved.explicitThinkingLevel,
		});
		selectedRole = role;
	} else if (nonEmpty(provider) && nonEmpty(modelId) && role === undefined) {
		const model = await findModel(session, provider, modelId);
		if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
		// 与 `set_model` 相同：写 `model_change{role:"default"}`。
		await session.setModel(model);
	} else if (role === undefined && (provider === undefined) !== (modelId === undefined)) {
		throw new Error("provider and modelId must be given together");
	} else {
		throw new Error("oryn_select_model requires either role or provider+modelId");
	}

	const model = session.model;
	if (!model) throw new Error("No active model after selection");
	if (thinkingLevel !== undefined) session.setThinkingLevel?.(thinkingLevel);
	const source = selectedRole === undefined ? "manual" : "role";
	const data: OrynModelSourceData = { v: 1, source, model: `${model.provider}/${model.id}` };
	const alias = selectedRole === undefined ? undefined : roleAliasTarget(session.settings, selectedRole);
	if (selectedRole !== undefined) data.role = selectedRole;
	if (alias) data.alias = alias;
	await recordSource(session, data);
	return {
		model,
		thinkingLevel: session.thinkingLevel,
		source,
		...(selectedRole === undefined ? {} : { role: selectedRole }),
		...(alias ? { alias } : {}),
	};
}

/**
 * `oryn_mark_session_start`：记下全新会话的模型是怎么来的。分支上已有消息或已有来源记录时不写。
 * `explicitModel` 为真（建线程时显式选了模型）记 `manual`；否则只在核实「当前模型就是启动时按
 * default role 解析出来的」后记 `startup`，任何一条不满足都不写。写下记录后调用 `onRecorded`（计划模式据此补全进入前基线）。
 */
export async function handleOrynMarkSessionStart(
	session: OrynModelSourceSession,
	command: { explicitModel?: unknown },
	onRecorded?: (record: OrynModelSourceData) => Promise<void>,
): Promise<OrynMarkSessionStartResult> {
	const branch = session.sessionManager.getBranch();
	for (const entry of branch) {
		if (entry.type === "message") return { recorded: false };
		if (entry.type === "custom" && entry.customType === ORYN_MODEL_SOURCE_ENTRY) return { recorded: false };
	}
	const model = session.model;
	if (!model) return { recorded: false };
	const key = `${model.provider}/${model.id}`;

	if (command.explicitModel === true) {
		const data: OrynModelSourceData = { v: 1, source: "manual", model: key };
		await recordSource(session, data);
		await onRecorded?.(data);
		return { recorded: true, source: "manual", model: key };
	}

	const changes = branch.filter(entry => entry.type === "model_change");
	if (changes.length > 1) return { recorded: false };
	const change = changes[0];
	if (change && (change.role !== undefined || change.resolvedModelIsFallback === true || change.model !== key)) {
		return { recorded: false };
	}
	const resolved = session.resolveRoleModelWithThinking("default").model;
	if (!resolved || resolved.provider !== model.provider || resolved.id !== model.id) return { recorded: false };

	const alias = roleAliasTarget(session.settings, "default");
	const data: OrynModelSourceData = { v: 1, source: "startup", model: key, role: "default" };
	if (alias) data.alias = alias;
	await recordSource(session, data);
	await onRecorded?.(data);
	return { recorded: true, source: "startup", role: "default", model: key, ...(alias ? { alias } : {}) };
}
