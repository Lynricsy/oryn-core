/**
 * Oryn Runner 的用户级来源隔离（`ORYN_ISOLATE_USER_SOURCES=1`）。
 *
 * Runner 跑在用户自己的机器上：omp 配置根由 `PI_CONFIG_DIR=.oryn/omp` 移到 `~/.oryn/omp`，
 * 但 HOME 下其它工具的目录（`~/.agents`、`~/.claude`、`~/.codex`、`~/.ssh` …）仍会被发现源读到，
 * 外部工具的用户级源还可被 `enabledProviders` 或旧的按能力开关打开。开关打开时只保留落在 omp
 * 配置根之内或随二进制内置的用户级来源（{@link RETAINED_USER_SOURCES}）；项目级（cwd 向上到仓库根）
 * 不受影响。未设置时每个判定都是「不拦」，行为与上游完全相同。每次调用时读取环境变量。
 *
 * 接入点（对现有文件的最少改动，见 ORYN.md 例外清单）：
 * - `capability/index.ts` `isUserSourceEnabled`：经它判定的一切来源（`getUserPath`、`config.ts`
 *   `getConfigDirs`、技能过滤、claude-plugins 的用户级根、GitHub `~/.copilot` …）。
 * - `discovery/helpers.ts` `resolveUserPath`：opencode 等旧的按能力开关绕过 `isUserSourceEnabled`
 *   直接取用户路径；Claude 插件注册表 `<claude>/plugins/installed_plugins.json` 与
 *   `<claude>/settings.json` 的 `enabledPlugins`（claude-plugins、agent-plugins、子 agent、扩展根
 *   都经它，含 Claude 注册表里 project 作用域的条目，其安装目录同样在 `~/.claude` 下）；独立
 *   `AGENTS.md` / `CLAUDE.md` 的向上扫描不把 HOME 本身当项目目录。
 * - `discovery/agents.ts` `getUserPathCandidates`：`~/.agent[s]` 默认开启，不经 `isUserSourceEnabled`。
 * - `discovery/claude.ts` `getUserClaude`、`discovery/codex.ts` `getUserCodexDir`：
 *   `skills.enableClaudeUser` / `skills.enableCodexUser` 等旧开关可绕过 `isUserSourceEnabled`。
 * - `discovery/github.ts` `copilotCustomInstructionDirs`：`COPILOT_CUSTOM_INSTRUCTIONS_DIRS` 指向的用户目录。
 * - `discovery/ssh-config.ts`：`~/.ssh/config` 与 `/etc/ssh/ssh_config`（Runner 只用控制面下发的 `ssh.json`）。
 * - `predict/foreign-history.ts`：文本预测不读 `~/.claude/history.jsonl`、`~/.codex/history.jsonl`。
 * - Core 发起的 ssh（`ssh/connection-manager.ts`、`ssh/sshfs-mount.ts`、`blob-broker/exposure.ts`）：
 *   {@link orynIsolatedSshArgs} 把 ssh 配置与 known_hosts 换到配置根下，不读 `~/.ssh/config`、
 *   不写 `~/.ssh/known_hosts`。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigRootDir } from "@oh-my-pi/pi-utils";

export const ORYN_ISOLATE_USER_SOURCES_ENV = "ORYN_ISOLATE_USER_SOURCES";

/**
 * 隔离时仍保留的用户级来源：数据都在 omp 配置根（`PI_CONFIG_DIR` 已移走）之内或随二进制内置。
 * native（`omp`）的 agent 目录、omp 插件与市场注册表、skillshare 锁、自动学习技能、
 * `contextFiles.extra`、内置规则、Oryn 项目层、`ssh.json`。
 */
const RETAINED_USER_SOURCES: Record<string, true> = {
	native: true,
	omp: true,
	"omp-plugins": true,
	"omp-managed": true,
	"agent-plugins": true,
	skillshare: true,
	"custom-context": true,
	"builtin-defaults": true,
	"oryn-project": true,
	"ssh-json": true,
};

/** 隔离开关是否打开（`ORYN_ISOLATE_USER_SOURCES=1`）。 */
export function orynUserSourcesIsolated(): boolean {
	return process.env[ORYN_ISOLATE_USER_SOURCES_ENV] === "1";
}

/** 隔离开关打开且 `source`（provider id 或 `.claude` 这类目录名）不在保留名单内时为 true。 */
export function orynBlocksUserSource(source: string): boolean {
	return orynUserSourcesIsolated() && RETAINED_USER_SOURCES[source.replace(/^\./, "")] !== true;
}

/**
 * 隔离时追加给 Core 发起的 ssh 的参数：`-F <配置根>/ssh/config`（与 orb 的干净 HOME 一致，不读用户的
 * `~/.ssh/config`，`-F` 同时让 ssh 忽略 `/etc/ssh/ssh_config`）与
 * `-o UserKnownHostsFile="<配置根>/ssh/known_hosts"`（`accept-new` 记下的主机密钥不再写进用户的
 * `~/.ssh/known_hosts`；值加双引号，因为 ssh 把未加引号的空白当作多个文件的分隔）。
 * 目录不存在则以 0700 创建，配置文件不存在则建空文件（0600）；每次都确保存在，`-F` 指向缺失的文件 ssh 会直接失败。
 * 未隔离时返回空数组。
 */
export function orynIsolatedSshArgs(): string[] {
	if (!orynUserSourcesIsolated()) return [];
	const dir = path.join(getConfigRootDir(), "ssh");
	const config = path.join(dir, "config");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.closeSync(fs.openSync(config, "a", 0o600));
	return ["-F", config, "-o", `UserKnownHostsFile="${path.join(dir, "known_hosts")}"`];
}
