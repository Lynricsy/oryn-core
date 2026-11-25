import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { cfgPlanDefaultOnStartup } from "@oh-my-pi/pi-coding-agent/plan-mode/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// 真实 SDK 会话 + RPC 调度夹具，用来端到端验证计划模式的模型切换、恢复、流式延后与来源记录。
// 环境变量：
// - ORYN_PLAN_ROLE: modelRoles.plan
// - ORYN_SLOW_ROLE: modelRoles.slow
// - ORYN_DEFAULT_ROLE: modelRoles.default（默认 anthropic/claude-sonnet-4-5）
// - ORYN_PLAN_DEFAULT_ON_STARTUP="1": 开启 plan.defaultOnStartup
// - ORYN_HOLD_TURN="1": 挂起首个模型回合，直到扩展命令 `/oryntest-release` 放行
// - ORYN_PROPOSE_ON_TURN="1": 模型回合内写 local://PLAN.md 并经 write(xd://propose) 提交计划提案
const cwd = process.cwd();
const sessionDir = path.join(cwd, "sessions");
await fs.mkdir(sessionDir, { recursive: true });

const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const settings = await Settings.init({ inMemory: true, cwd });

const roles: Record<string, string> = {
	default: Bun.env.ORYN_DEFAULT_ROLE ?? "anthropic/claude-sonnet-4-5",
};
if (Bun.env.ORYN_PLAN_ROLE) roles.plan = Bun.env.ORYN_PLAN_ROLE;
if (Bun.env.ORYN_SLOW_ROLE) roles.slow = Bun.env.ORYN_SLOW_ROLE;
cfgModelRoles.override(settings, roles);

if (Bun.env.ORYN_PLAN_DEFAULT_ON_STARTUP === "1") {
	cfgPlanDefaultOnStartup.override(settings, true);
}

const firstTurnGate = Promise.withResolvers<void>();
if (Bun.env.ORYN_HOLD_TURN !== "1") firstTurnGate.resolve();

let turnCount = 0;
const mock = createMockModel({
	provider: "anthropic",
	handler: async () => {
		turnCount++;
		if (turnCount === 1) await firstTurnGate.promise;
		if (Bun.env.ORYN_PROPOSE_ON_TURN === "1" && turnCount === 1) {
			return {
				content: [
					{
						type: "toolCall",
						id: "call_write_plan",
						name: "write",
						arguments: { path: "local://PLAN.md", content: "# Test Plan\n\n- Step 1\n" },
					},
					{
						type: "toolCall",
						id: "call_propose",
						name: "bash",
						arguments: { command: "propose test-plan" },
					},
				],
			};
		}
		return { content: ["ok"] };
	},
});

const { session } = await createAgentSession({
	cwd,
	agentDir: cwd,
	sessionManager: SessionManager.create(cwd, sessionDir),
	authStorage,
	modelRegistry,
	settings,
	model: getBundledModel("anthropic", "claude-sonnet-4-5"),
	thinkingLevel: ThinkingLevel.Medium,
	disableExtensionDiscovery: true,
	skills: [],
	contextFiles: [],
	workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	promptTemplates: [],
	slashCommands: [],
	enableMCP: false,
	enableLsp: false,
	extensions: [
		pi => {
			pi.registerCommand("oryntest-release", {
				description: "releases the held first model turn",
				handler: async () => firstTurnGate.resolve(),
			});
		},
	],
});
session.agent.streamFn = mock.stream;

await runRpcMode(session);
