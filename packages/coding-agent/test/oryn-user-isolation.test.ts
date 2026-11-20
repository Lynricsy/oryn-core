/**
 * Oryn Runner 的用户级来源隔离（`ORYN_ISOLATE_USER_SOURCES=1`，见 ORYN.md「例外清单」）：
 * 开关打开时不读 HOME 下的 `.agents`、`.claude`（即使已用 `enabledProviders` 打开）、Claude 插件注册表、
 * `~/AGENTS.md`、`~/.ssh/config`、Claude / Codex 的 history.jsonl，Core 发起的 ssh 改用配置根下的
 * ssh 配置与 known_hosts；项目级照常。
 * 开关关闭时与上游相同。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disableUserSource, enableUserSource } from "@oh-my-pi/pi-coding-agent/capability";
import { type ContextFile, contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import {
	ORYN_ISOLATE_USER_SOURCES_ENV,
	orynIsolatedSshArgs,
} from "@oh-my-pi/pi-coding-agent/capability/oryn-user-isolation";
import { type Skill, skillCapability } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { type SSHHost, sshCapability } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import { loadCapability, reset as resetCapabilityCache } from "@oh-my-pi/pi-coding-agent/discovery";
import { clearClaudePluginRootsCache, listClaudePluginRoots } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { readForeignPrompts } from "@oh-my-pi/pi-coding-agent/predict/foreign-history";
import { __resetDirsFromEnvForTests, getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "./helpers/settings-test-state";

// 与 test/skills.test.ts 相同：Bun 在进程启动时固定 os.homedir()，只改 HOME 不够，还要 spy。
const ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"CLAUDE_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"PI_CONFIG_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
	ORYN_ISOLATE_USER_SOURCES_ENV,
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

let base = "";
let home = "";
let repo = "";
const isolateHomedir = () => spyOn(os, "homedir").mockReturnValue(home);

async function put(file: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, content);
}

function skill(name: string): string {
	return `---\nname: ${name}\ndescription: ${name} skill\n---\nBody of ${name}.\n`;
}

function setIsolated(on: boolean): void {
	if (on) process.env[ORYN_ISOLATE_USER_SOURCES_ENV] = "1";
	else delete process.env[ORYN_ISOLATE_USER_SOURCES_ENV];
}

function clearCaches(): void {
	resetCapabilityCache();
	clearFsCache();
	clearClaudePluginRootsCache();
}

async function skillNames(): Promise<string[]> {
	const { items } = await loadCapability<Skill>(skillCapability.id, { cwd: repo });
	return items.map(item => item.name).sort();
}

beforeAll(async () => {
	base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oryn-user-isolation-")));
	home = path.join(base, "home");
	repo = path.join(base, "repo");

	await put(path.join(home, ".agents", "skills", "u1", "SKILL.md"), skill("u1"));
	await put(path.join(home, ".claude", "skills", "u2", "SKILL.md"), skill("u2"));
	await put(path.join(home, "AGENTS.md"), "Home-level AGENTS.md.\n");
	await put(path.join(home, ".ssh", "config"), "Host oryn-user-isolation-host\n  HostName 192.0.2.1\n");
	await put(path.join(home, ".claude", "history.jsonl"), `${JSON.stringify({ display: "claude prompt" })}\n`);
	await put(path.join(home, ".codex", "history.jsonl"), `${JSON.stringify({ text: "codex prompt" })}\n`);
	// Claude 插件注册表里的用户级插件（安装目录同在 ~/.claude 下）
	const pluginPath = path.join(home, ".claude", "plugins", "cache", "u-plugin");
	await put(path.join(pluginPath, "skills", "u3", "SKILL.md"), skill("u3"));
	await put(
		path.join(home, ".claude", "plugins", "installed_plugins.json"),
		JSON.stringify({
			version: 2,
			plugins: { "u-plugin@market": [{ installPath: pluginPath, version: "1.0.0", scope: "user" }] },
		}),
	);

	await fs.mkdir(path.join(repo, ".git"), { recursive: true });
	await put(path.join(repo, ".claude", "skills", "p1", "SKILL.md"), skill("p1"));
	await put(path.join(repo, ".agents", "skills", "p2", "SKILL.md"), skill("p2"));

	isolateHomedir();
	for (const key of ["HOME", "USERPROFILE"] as const) {
		process.env[key] = home;
		Bun.env[key] = home;
	}
	delete process.env.CLAUDE_CONFIG_DIR;
	delete Bun.env.CLAUDE_CONFIG_DIR;
	delete process.env.PI_CONFIG_DIR;
	delete process.env.OMP_PROFILE;
	delete process.env.PI_PROFILE;
	setAgentDir(path.join(home, ".omp", "agent"));
});

beforeEach(() => {
	isolateHomedir();
	// 让 Claude 的用户级源处于打开状态：开关关时它应生效，开关开时应被兜住。
	enableUserSource("claude");
	clearCaches();
});

afterEach(() => {
	disableUserSource("claude");
	setIsolated(false);
	clearCaches();
});

afterAll(async () => {
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	isolateHomedir().mockRestore();
	__resetDirsFromEnvForTests();
	await removeWithRetries(base);
});

describe("ORYN_ISOLATE_USER_SOURCES", () => {
	test("关：用户级 .agents 与已打开的 .claude 照常加载", async () => {
		setIsolated(false);
		expect(await skillNames()).toEqual(["p1", "p2", "u1", "u2", "u3"]);
	});

	test("开：只加载仓库内的技能", async () => {
		setIsolated(true);
		expect(await skillNames()).toEqual(["p1", "p2"]);
	});

	test("开：不读 Claude 插件注册表", async () => {
		setIsolated(false);
		expect((await listClaudePluginRoots(home, repo)).roots.map(root => root.id)).toEqual(["u-plugin@market"]);
		clearCaches();
		setIsolated(true);
		expect((await listClaudePluginRoots(home, repo)).roots).toEqual([]);
	});

	test("开：HOME 本身的 AGENTS.md 不再当作项目上下文", async () => {
		const work = path.join(home, "scratch");
		await fs.mkdir(work, { recursive: true });
		const homeAgents = path.join(home, "AGENTS.md");
		const paths = async () =>
			(await loadCapability<ContextFile>(contextFileCapability.id, { cwd: work })).items.map(item => item.path);

		setIsolated(false);
		expect(await paths()).toContain(homeAgents);
		clearCaches();
		setIsolated(true);
		expect(await paths()).not.toContain(homeAgents);
	});

	test("开：不读 ~/.ssh/config", async () => {
		const names = async () =>
			(await loadCapability<SSHHost>(sshCapability.id, { cwd: repo })).items.map(item => item.name);

		setIsolated(false);
		expect(await names()).toContain("oryn-user-isolation-host");
		clearCaches();
		setIsolated(true);
		expect(await names()).not.toContain("oryn-user-isolation-host");
	});

	test("开：文本预测不读 Claude / Codex 的 history.jsonl", async () => {
		setIsolated(false);
		expect(await readForeignPrompts()).toEqual(["claude prompt", "codex prompt"]);
		setIsolated(true);
		expect(await readForeignPrompts()).toEqual([]);
	});

	test("ssh 参数：关时为空，开时 ssh 配置与 known_hosts 在配置根下", async () => {
		setIsolated(false);
		expect(orynIsolatedSshArgs()).toEqual([]);

		setIsolated(true);
		const dir = path.join(getConfigRootDir(), "ssh");
		const config = path.join(dir, "config");
		expect(dir.startsWith(home)).toBe(true);
		expect(orynIsolatedSshArgs()).toEqual([
			"-F",
			config,
			"-o",
			`UserKnownHostsFile="${path.join(dir, "known_hosts")}"`,
		]);
		expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
		const stat = await fs.stat(config);
		expect(stat.mode & 0o777).toBe(0o600);
		expect(stat.size).toBe(0);

		// 已有内容不被截断
		await fs.writeFile(config, "# kept\n");
		orynIsolatedSshArgs();
		expect(await fs.readFile(config, "utf8")).toBe("# kept\n");
	});
});
