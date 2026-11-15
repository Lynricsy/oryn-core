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
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	ORYN_OMFG_GLOBAL_OPTION,
	ORYN_OMFG_PROJECT_OPTION,
	runRpcOmfg,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-omfg";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

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
