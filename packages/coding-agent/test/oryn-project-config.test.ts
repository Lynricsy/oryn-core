/**
 * Oryn 项目层中央配置（见 ORYN.md「例外清单」）：provider `oryn-project` 以
 * `ORYN_PROJECT_CONFIG_ROOT` 为根发现 `.omp/` 布局的配置并压过仓库 `.omp/`；子 agent 目录；
 * `/omfg` 在 `ORYN_CENTRAL_CONFIG=1` 时的保存选项文案与项目保存位置。
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { loadCapability, reset as resetCapabilityCache } from "@oh-my-pi/pi-coding-agent/discovery";
import type { ContextFile, MCPServer, Rule, Skill, SlashCommand } from "@oh-my-pi/pi-coding-agent/discovery";
import { ORYN_PROJECT_PROVIDER_ID } from "@oh-my-pi/pi-coding-agent/discovery/oryn-project-config";
import { contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { skillCapability } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { slashCommandCapability } from "@oh-my-pi/pi-coding-agent/capability/slash-command";
import { type SSHHost, sshCapability } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { expandPromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { loadCustomCommands } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/loader";
import { discoverExtensionPaths, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { discoverPromptTemplates } from "@oh-my-pi/pi-coding-agent/sdk";
import {
	ORYN_OMFG_GLOBAL_OPTION,
	ORYN_OMFG_PROJECT_OPTION,
	runRpcOmfg,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-omfg";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { initTheme } from "@oh-my-pi/pi-coding-agent/ui/theme/service";
import { getAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const ENV_KEYS = ["ORYN_CENTRAL_CONFIG", "ORYN_PROJECT_CONFIG_ROOT"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const directories: string[] = [];

async function tempDir(prefix: string): Promise<string> {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
	directories.push(directory);
	return directory;
}

async function put(file: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, content);
}

function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
	for (const key of ENV_KEYS) {
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}
}

beforeAll(async () => {
	await initTheme();
});

afterEach(async () => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	resetCapabilityCache();
	for (const directory of directories.splice(0)) await removeWithRetries(directory);
});

describe("oryn-project provider", () => {
	async function layout() {
		const base = await tempDir("oryn-project-config-");
		const root = path.join(base, "root");
		const repo = path.join(base, "repo");
		await put(path.join(root, ".omp", "rules", "dup.md"), "---\ndescription: dup from oryn\n---\nOryn rule.\n");
		await put(
			path.join(root, ".omp", "skills", "layer", "SKILL.md"),
			"---\nname: layer\ndescription: Oryn layer skill\n---\nSkill body.\n",
		);
		await put(
			path.join(root, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { "oryn-layer": { command: "echo", args: ["hi"] } } }),
		);
		await put(path.join(root, ".omp", "commands", "layer.md"), "---\ndescription: Oryn layer command\n---\nDo it.\n");
		await put(path.join(root, ".omp", "AGENTS.md"), "Oryn project instructions.\n");
		await fs.mkdir(path.join(repo, ".git"), { recursive: true });
		await put(path.join(repo, ".omp", "rules", "dup.md"), "---\ndescription: dup from repo\n---\nRepo rule.\n");
		await put(path.join(repo, "AGENTS.md"), "Repo instructions.\n");
		return { root, repo };
	}

	async function load<T>(id: string, cwd: string): Promise<T[]> {
		resetCapabilityCache();
		const result = await loadCapability<T>(id, { cwd });
		return result.items;
	}

	test("project layer is discovered, shadows the repo .omp, and leaves with the env var", async () => {
		const { root, repo } = await layout();
		setEnv({ ORYN_PROJECT_CONFIG_ROOT: root });

		const rules = await load<Rule>(ruleCapability.id, repo);
		const dup = rules.find(rule => rule.name === "dup");
		expect(dup?.path).toBe(path.join(root, ".omp", "rules", "dup.md"));
		// _source.provider 保持 native，供下游按 native/project 判定开关。
		expect(dup?._source.provider).toBe("native");
		expect(dup?._source.level).toBe("project");

		const skills = await load<Skill>(skillCapability.id, repo);
		expect(skills.find(skill => skill.name === "layer")?.path).toStartWith(root);

		const commands = await load<SlashCommand>(slashCommandCapability.id, repo);
		expect(commands.find(command => command.name === "layer")?.path).toStartWith(root);

		const servers = await load<MCPServer>(mcpCapability.id, repo);
		expect(servers.map(server => server.name)).toContain("oryn-layer");

		const contextFiles = await load<ContextFile>(contextFileCapability.id, repo);
		const contextPaths = contextFiles.map(file => file.path);
		expect(contextPaths).toContain(path.join(root, ".omp", "AGENTS.md"));
		expect(contextPaths).toContain(path.join(repo, "AGENTS.md"));

		setEnv({});
		const rulesAfter = await load<Rule>(ruleCapability.id, repo);
		expect(rulesAfter.find(rule => rule.name === "dup")?.path).toBe(path.join(repo, ".omp", "rules", "dup.md"));
		expect(rulesAfter.some(rule => rule.path.startsWith(root))).toBe(false);
		expect((await load<Skill>(skillCapability.id, repo)).some(skill => skill.name === "layer")).toBe(false);
		expect((await load<SlashCommand>(slashCommandCapability.id, repo)).some(c => c.name === "layer")).toBe(false);
		expect((await load<MCPServer>(mcpCapability.id, repo)).some(s => s.name === "oryn-layer")).toBe(false);
		const contextAfter = (await load<ContextFile>(contextFileCapability.id, repo)).map(file => file.path);
		expect(contextAfter).not.toContain(path.join(root, ".omp", "AGENTS.md"));
		expect(contextAfter).toContain(path.join(repo, "AGENTS.md"));
	});

	test("a relative root is ignored", async () => {
		const { repo } = await layout();
		setEnv({ ORYN_PROJECT_CONFIG_ROOT: "root" });
		const result = await loadCapability<Rule>(ruleCapability.id, { cwd: repo });
		expect(result.items.find(rule => rule.name === "dup")?.path).toBe(path.join(repo, ".omp", "rules", "dup.md"));
		expect(result.providers).not.toContain(ORYN_PROJECT_PROVIDER_ID);
	});

	test("project-layer subagents win over the repo .omp/agents", async () => {
		const base = await tempDir("oryn-project-agents-");
		const root = path.join(base, "root");
		const repo = path.join(base, "repo");
		const agent = (description: string) => `---\nname: layer-agent\ndescription: ${description}\n---\nBody.\n`;
		await put(path.join(root, ".omp", "agents", "a.md"), agent("from oryn"));
		await put(path.join(repo, ".omp", "agents", "a.md"), agent("from repo"));
		await fs.mkdir(path.join(repo, ".git"), { recursive: true });

		setEnv({ ORYN_PROJECT_CONFIG_ROOT: root });
		const withLayer = await discoverAgents(repo);
		const found = withLayer.agents.filter(a => a.name === "layer-agent");
		expect(found).toHaveLength(1);
		expect(found[0]?.filePath).toBe(path.join(root, ".omp", "agents", "a.md"));
		expect(found[0]?.source).toBe("project");

		setEnv({});
		const without = await discoverAgents(repo);
		expect(without.agents.find(a => a.name === "layer-agent")?.filePath).toBe(
			path.join(repo, ".omp", "agents", "a.md"),
		);
	});

	test("project-layer ssh.json hosts are proxied from ssh-json and win over the agent-dir ssh.json", async () => {
		const base = await tempDir("oryn-project-ssh-");
		const root = path.join(base, "root");
		const repo = path.join(base, "repo");
		const agentDir = path.join(base, "agent");
		const sshJson = (hosts: Record<string, object>) => JSON.stringify({ hosts });
		await put(
			path.join(root, ".omp", "ssh.json"),
			sshJson({
				"oryn-runner": {
					host: "127.0.0.1",
					port: 2201,
					username: "oryn-runner",
					description: "Runner",
					compat: true,
				},
				"oryn-shared": { host: "127.0.0.1", port: 2202, username: "oryn-shared" },
			}),
		);
		// ssh-json loader 的遗留项目级路径：以 root 为 cwd 时同样被读到（root 由 Oryn 控制，无害）。
		await put(path.join(root, "ssh.json"), sshJson({ "oryn-legacy": { host: "legacy.example" } }));
		await put(
			path.join(agentDir, "ssh.json"),
			sshJson({ "oryn-shared": { host: "user.example" }, "oryn-user": { host: "user-only.example" } }),
		);
		await fs.mkdir(path.join(repo, ".git"), { recursive: true });

		const previousAgentDir = getAgentDir();
		setAgentDir(agentDir);
		try {
			setEnv({ ORYN_PROJECT_CONFIG_ROOT: root });
			resetCapabilityCache();
			const withLayer = await loadCapability<SSHHost>(sshCapability.id, { cwd: repo });
			expect(withLayer.providers).toContain(ORYN_PROJECT_PROVIDER_ID);
			const hosts = new Map(withLayer.items.map(host => [host.name, host]));
			const runner = hosts.get("oryn-runner");
			expect(runner).toMatchObject({
				host: "127.0.0.1",
				port: 2201,
				username: "oryn-runner",
				description: "Runner",
				compat: true,
			});
			// provider 改为 oryn-project：RPC 不把控制面下发的主机标为可编辑。
			expect(runner?._source).toMatchObject({
				provider: ORYN_PROJECT_PROVIDER_ID,
				level: "project",
				path: path.join(root, ".omp", "ssh.json"),
			});
			// 同名时项目层（优先级 110）压过 agent 目录的 ssh.json（ssh-json，优先级 5），去重先到先得。
			expect(withLayer.items.filter(host => host.name === "oryn-shared")).toHaveLength(1);
			expect(hosts.get("oryn-shared")).toMatchObject({ host: "127.0.0.1", port: 2202 });
			expect(hosts.get("oryn-shared")?._source.provider).toBe(ORYN_PROJECT_PROVIDER_ID);
			// 用户级条目只经 ssh-json 自己出现，不会被 oryn-project 重复代理。
			expect(hosts.get("oryn-user")?._source).toMatchObject({ provider: "ssh-json", level: "user" });
			expect(hosts.get("oryn-legacy")?._source).toMatchObject({
				provider: ORYN_PROJECT_PROVIDER_ID,
				path: path.join(root, "ssh.json"),
			});

			setEnv({});
			resetCapabilityCache();
			const without = await loadCapability<SSHHost>(sshCapability.id, { cwd: repo });
			expect(without.items.some(host => host._source.provider === ORYN_PROJECT_PROVIDER_ID)).toBe(false);
			const names = without.items.map(host => host.name);
			expect(names).not.toContain("oryn-runner");
			expect(names).not.toContain("oryn-legacy");
			expect(without.items.find(host => host.name === "oryn-shared")?.host).toBe("user.example");
		} finally {
			setAgentDir(previousAgentDir);
		}
	});
});

describe("/omfg with Oryn central config", () => {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const RULE = {
		name: "ts-no-any",
		description: "No any in TS edits",
		condition: ": any",
		scope: ["tool:edit(*.ts)", "tool:write(*.ts)"],
		body: "Use `unknown` instead.",
	};

	function assistant(content: AssistantMessage["content"]): AssistantMessage {
		return {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage,
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	/** 线束同 oryn-ui-parity.test.ts 的 runOmfg；`answer` 收到展示的选项，返回用户的选择。 */
	async function runOmfg(answer: (options: string[]) => string | undefined) {
		const cwd = await tempDir("oryn-omfg-cwd-");
		const selects: Array<{ title: string; options: string[] }> = [];
		const ui = {
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async (title: string, options: string[]) => {
				selects.push({ title, options });
				return answer(options);
			},
			input: async () => undefined,
		} as unknown as ExtensionUIContext;
		const messages: AgentMessage[] = [
			assistant([
				{
					type: "toolCall",
					id: "call-1",
					name: "edit",
					arguments: { path: "src/example.ts", content: "const value: any = input;" },
				},
			]),
		];
		const agentDir = path.join(cwd, "agent");
		const session = {
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			runEphemeralTurn: async () => ({ replyText: JSON.stringify(RULE), assistantMessage: assistant([]) }),
			messages,
			agent: { state: { tools: [] } },
			ruleJudge: () => undefined,
			ttsrManager: { addRule: () => true },
			sessionManager: { getCwd: () => cwd },
			settings: { getAgentDir: () => agentDir },
		} as unknown as AgentSession;
		const result = await runRpcOmfg(session, ui, "stop using any");
		return { result, selects, cwd, agentDir };
	}

	async function exists(file: string): Promise<boolean> {
		return Bun.file(file).exists();
	}

	test("project option saves into the Oryn project layer", async () => {
		const root = await tempDir("oryn-omfg-root-");
		setEnv({ ORYN_CENTRAL_CONFIG: "1", ORYN_PROJECT_CONFIG_ROOT: root });
		const { result, selects, cwd } = await runOmfg(() => "This project (Oryn project config)");

		expect(selects).toHaveLength(1);
		expect(selects[0]?.title).toBe("Save TTSR rule where?");
		expect(selects[0]?.options).toStrictEqual([
			"This project (Oryn project config)",
			"Global — all projects (Oryn central config)",
			"Amend with feedback…",
		]);
		expect(ORYN_OMFG_PROJECT_OPTION).toBe("This project (Oryn project config)");
		expect(ORYN_OMFG_GLOBAL_OPTION).toBe("Global — all projects (Oryn central config)");
		expect(result.state).toBe("saved");
		expect(await exists(path.join(root, ".omp", "rules", "ts-no-any.md"))).toBe(true);
		expect(await exists(path.join(cwd, ".omp", "rules", "ts-no-any.md"))).toBe(false);
	});

	test("without a project layer only global and amend are offered", async () => {
		setEnv({ ORYN_CENTRAL_CONFIG: "1" });
		const { result, selects, cwd, agentDir } = await runOmfg(() => "Global — all projects (Oryn central config)");

		expect(selects[0]?.options).toStrictEqual([
			"Global — all projects (Oryn central config)",
			"Amend with feedback…",
		]);
		expect(result.state).toBe("saved");
		expect(await exists(path.join(agentDir, "rules", "ts-no-any.md"))).toBe(true);
		expect(await exists(path.join(cwd, ".omp", "rules", "ts-no-any.md"))).toBe(false);
	});

	test("without Oryn env the upstream options pass through", async () => {
		setEnv({});
		const { result, selects, cwd } = await runOmfg(options => options[0]);

		expect(selects[0]?.options).toStrictEqual([
			"This project (.omp/rules)",
			"Global — all projects (~/.omp/agent/rules)",
			"Amend with feedback…",
		]);
		expect(result.state).toBe("saved");
		expect(await exists(path.join(cwd, ".omp", "rules", "ts-no-any.md"))).toBe(true);
	});
});

// 消费侧：真正的运行路径（扩展导入、会话模板、TS 自定义命令）要吃到中央项目层。
describe("oryn-project consumers", () => {
	async function layout(prefix: string) {
		const base = await tempDir(prefix);
		const root = path.join(base, "root");
		const repo = path.join(base, "repo");
		const agentDir = path.join(base, "agent");
		await fs.mkdir(path.join(repo, ".git"), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		return { base, root, repo, agentDir };
	}

	const within = (dir: string, file: string) => file.startsWith(dir + path.sep);
	const extensionSource = (command: string) =>
		`export default function (pi) {\n\tpi.registerCommand(${JSON.stringify(command)}, { handler: async () => {} });\n}\n`;

	test("ambient extension discovery imports central extensions and shadows the repo copy", async () => {
		const { base, root, repo } = await layout("oryn-project-ext-");
		await put(path.join(root, ".omp", "extensions", "central-only.ts"), extensionSource("central-only"));
		await put(path.join(root, ".omp", "extensions", "dup.ts"), extensionSource("dup-central"));
		await put(path.join(repo, ".omp", "extensions", "dup.ts"), extensionSource("dup-repo"));
		await put(path.join(repo, ".omp", "extensions", "repo-only.ts"), extensionSource("repo-only"));

		const load = async () => {
			resetCapabilityCache();
			const paths = (await discoverExtensionPaths([], repo)).filter(file => within(base, file));
			const result = await loadExtensions(paths, repo);
			expect(result.errors).toHaveLength(0);
			return result.extensions.flatMap(extension => [...extension.commands.keys()]).sort();
		};

		setEnv({ ORYN_PROJECT_CONFIG_ROOT: root });
		expect(await load()).toStrictEqual(["central-only", "dup-central", "repo-only"]);

		setEnv({});
		expect(await load()).toStrictEqual(["dup-repo", "repo-only"]);
	});

	test("session prompt templates include central prompts, which win on name clashes", async () => {
		const { root, repo, agentDir } = await layout("oryn-project-prompts-");
		await put(path.join(agentDir, "prompts", "dup.md"), "Global dup $1\n");
		await put(path.join(repo, ".omp", "prompts", "dup.md"), "Repo dup $1\n");
		await put(path.join(repo, ".omp", "prompts", "repo-only.md"), "Repo only\n");
		await put(path.join(root, ".omp", "prompts", "dup.md"), "---\ndescription: Central dup\n---\nCentral dup $1\n");
		await put(path.join(root, ".omp", "prompts", "nested", "central-only.md"), "Central only\n");

		setEnv({ ORYN_PROJECT_CONFIG_ROOT: root });
		const templates = await discoverPromptTemplates(repo, agentDir);
		expect(templates.filter(template => template.name === "dup")).toHaveLength(1);
		expect(expandPromptTemplate("/dup x", templates)).toBe("Central dup x");
		expect(templates.find(template => template.name === "dup")?.description).toBe("Central dup (project)");
		expect(templates.find(template => template.name === "central-only")?.source).toBe("(project:nested)");
		expect(expandPromptTemplate("/repo-only", templates)).toBe("Repo only");

		setEnv({});
		const without = await discoverPromptTemplates(repo, agentDir);
		expect(without.some(template => template.name === "central-only")).toBe(false);
		expect(without.filter(template => template.name === "dup").map(template => template.content.trim())).toEqual([
			"Global dup $1",
			"Repo dup $1",
		]);
	});

	test("TypeScript custom commands load from the central layer and shadow the repo copy", async () => {
		const { base, root, repo, agentDir } = await layout("oryn-project-cmds-");
		await put(
			path.join(root, ".omp", "commands", "dup", "index.ts"),
			'export default () => ({ name: "dup", description: "central", execute: async () => {} });\n',
		);
		// 仓库同名版本被导入就会报错：用错误为空证明它没有运行。
		await put(path.join(repo, ".omp", "commands", "dup", "index.ts"), 'throw new Error("repo dup imported");\n');

		setEnv({ ORYN_PROJECT_CONFIG_ROOT: root });
		const withLayer = await loadCustomCommands({ cwd: repo, agentDir });
		expect(withLayer.errors.filter(error => within(base, error.path))).toHaveLength(0);
		const dup = withLayer.commands.find(command => command.command.name === "dup");
		expect(dup?.path).toBe(path.join(root, ".omp", "commands", "dup", "index.ts"));
		expect(dup?.command.description).toBe("central");

		setEnv({});
		const without = await loadCustomCommands({ cwd: repo, agentDir });
		expect(without.commands.some(command => within(root, command.path))).toBe(false);
		expect(without.errors.map(error => error.path)).toContain(path.join(repo, ".omp", "commands", "dup", "index.ts"));
	});
});
