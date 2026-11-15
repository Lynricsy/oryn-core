/**
 * Oryn 项目层配置（provider `oryn-project`）。
 *
 * Oryn 控制面按项目保存一份布局与仓库 `.omp/` 相同的配置，orbd 把它镜像到
 * `$ORYN_PROJECT_CONFIG_ROOT/.omp/`（仓库之外，不进 `git status`）。本 provider 以该根目录
 * 作为合成的 cwd 调用 native provider 自己的 loader，只保留项目级条目，所以布局与能力范围
 * 与 `.omp/` 完全一致，且与进程 cwd 无关。优先级 110 高于 native（100）：
 * Oryn 项目层 > 仓库 `.omp/` > 全局。settings 不在此注册，`config.yml` 经 `--config` 覆盖层下发。
 *
 * 条目的 `_source.provider` 保持 `"native"`：下游按 `provider === "native" && level === "project"`
 * 判定开关（如 extensibility/skills.ts），改掉会让项目层技能被当成未知来源。
 */
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { extensionCapability } from "../capability/extension";
import { extensionModuleCapability } from "../capability/extension-module";
import { hookCapability } from "../capability/hook";
import { instructionCapability } from "../capability/instruction";
import { mcpCapability } from "../capability/mcp";
import { promptCapability } from "../capability/prompt";
import { ruleCapability } from "../capability/rule";
import { skillCapability } from "../capability/skill";
import { slashCommandCapability } from "../capability/slash-command";
import { systemPromptCapability } from "../capability/system-prompt";
import { toolCapability } from "../capability/tool";
import type { Capability, LoadContext, LoadResult, SourceMeta } from "../capability/types";

export const ORYN_PROJECT_PROVIDER_ID = "oryn-project";

const NATIVE_PROVIDER_ID = "native";
const PRIORITY = 110;

/** orb 由 Oryn 中央配置管理（`ORYN_CENTRAL_CONFIG=1`）。每次调用时读取环境变量。 */
export function orynCentralConfigEnabled(): boolean {
	return process.env.ORYN_CENTRAL_CONFIG === "1";
}

/** 项目层根目录（`ORYN_PROJECT_CONFIG_ROOT`）；须为非空绝对路径，否则 undefined。每次调用时读取。 */
export function orynProjectConfigRoot(): string | undefined {
	const root = process.env.ORYN_PROJECT_CONFIG_ROOT;
	if (!root || !path.isAbsolute(root)) return undefined;
	return root;
}

/** 项目层的子 agent 目录 `<root>/.omp/agents`。 */
export function orynProjectAgentsDir(): string | undefined {
	const root = orynProjectConfigRoot();
	return root ? path.join(root, CONFIG_DIR_NAME, "agents") : undefined;
}

/** `/omfg` 选「本项目」时的保存位置 `<root>/.omp/rules/<ruleName>.md`；无项目层时 undefined。 */
export function orynOmfgProjectRulePath(ruleName: string): string | undefined {
	const root = orynProjectConfigRoot();
	return root ? path.join(root, CONFIG_DIR_NAME, "rules", `${ruleName}.md`) : undefined;
}

type SourcedItem = { _source: SourceMeta };

function registerOrynProjectProvider<T extends SourcedItem>(
	capability: Capability<T>,
	mapItem: (item: T) => T = item => item,
): void {
	registerProvider<T>(capability.id, {
		id: ORYN_PROJECT_PROVIDER_ID,
		displayName: "Oryn project",
		description: "Project config stored centrally by Oryn",
		priority: PRIORITY,
		async load(ctx: LoadContext): Promise<LoadResult<T>> {
			const root = orynProjectConfigRoot();
			if (!root) return { items: [] };
			// load 时再找 native：不依赖模块导入顺序。
			const native = capability.providers.find(provider => provider.id === NATIVE_PROVIDER_ID);
			if (!native) return { items: [] };
			const result = await native.load({ ...ctx, cwd: root, repoRoot: root });
			return {
				items: result.items.filter(item => item._source.level === "project").map(mapItem),
				warnings: result.warnings?.filter(warning => warning.includes(root)),
			};
		},
	});
}

registerOrynProjectProvider(mcpCapability);
registerOrynProjectProvider(systemPromptCapability);
registerOrynProjectProvider(skillCapability);
registerOrynProjectProvider(slashCommandCapability);
registerOrynProjectProvider(ruleCapability);
registerOrynProjectProvider(promptCapability);
registerOrynProjectProvider(extensionModuleCapability);
registerOrynProjectProvider(extensionCapability);
registerOrynProjectProvider(instructionCapability);
registerOrynProjectProvider(hookCapability);
registerOrynProjectProvider(toolCapability);
// additive：key 改为按路径唯一，与仓库自带的 AGENTS.md 并存而不是互相替换。
registerOrynProjectProvider<ContextFile>(contextFileCapability, item => ({ ...item, additive: true }));
