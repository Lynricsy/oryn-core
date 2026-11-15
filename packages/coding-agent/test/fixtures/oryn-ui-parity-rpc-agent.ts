import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgGoalContinuationModes } from "@oh-my-pi/pi-coding-agent/goals/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { cfgLoopMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Real SDK session and RPC dispatch for the Oryn UI-parity tests; only the model is scripted
// (every turn answers "ok"). `/oryntest-noop` is a local extension command; `/skill:hello` a skill.
// ORYN_RPC_JOBS="1": registers a running background job this session owns ("own-job") and one
// another agent owns ("foreign-job"); both run until cancelled.
// ORYN_LOOP_MODE：写入 `loop.mode`（prompt / compact / reset）。
// ORYN_RPC_HOLD_FIRST_TURN="1"：首个模型回合挂起，直到扩展命令 `/oryntest-release` 放行
// （扩展命令流式中也立即执行），用来在流式期间确定性地提交输入。
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const settings = await Settings.init({ inMemory: true, cwd });
cfgGoalContinuationModes.set(settings, ["interactive"]);
const loopMode = Bun.env.ORYN_LOOP_MODE;
if (loopMode === "prompt" || loopMode === "compact" || loopMode === "reset") cfgLoopMode.set(settings, loopMode);
const firstTurnGate = Promise.withResolvers<void>();
if (Bun.env.ORYN_RPC_HOLD_FIRST_TURN !== "1") firstTurnGate.resolve();
const skillPath = path.join(cwd, "hello", "SKILL.md");
await Bun.write(skillPath, "---\nname: hello\ndescription: Say hello\n---\n\nSay hello.\n");
const { session } = await createAgentSession({
	cwd,
	agentDir: cwd,
	sessionManager: SessionManager.inMemory(cwd),
	authStorage,
	modelRegistry,
	settings,
	model: getBundledModel("anthropic", "claude-sonnet-4-5"),
	disableExtensionDiscovery: true,
	skills: [
		{
			name: "hello",
			description: "Say hello",
			filePath: skillPath,
			baseDir: path.dirname(skillPath),
			source: "project",
		},
	],
	contextFiles: [],
	workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	promptTemplates: [],
	slashCommands: [],
	enableMCP: false,
	enableLsp: false,
	extensions: [
		pi => {
			pi.registerCommand("oryntest-noop", {
				description: "a local command that never reaches the model",
				handler: async () => {},
			});
			pi.registerCommand("oryntest-release", {
				description: "releases the held first model turn",
				handler: async () => firstTurnGate.resolve(),
			});
		},
	],
});
session.agent.streamFn = createMockModel({
	handler: async () => {
		await firstTurnGate.promise;
		return { content: ["ok"] };
	},
}).stream;

if (Bun.env.ORYN_RPC_JOBS === "1") {
	const manager = session.asyncJobManager;
	if (!manager) throw new Error("fixture session has no async job manager");
	const untilCancelled = async ({ signal }: { signal: AbortSignal }) => {
		const { promise, resolve } = Promise.withResolvers<void>();
		signal.addEventListener("abort", () => resolve(), { once: true });
		await promise;
		return "cancelled";
	};
	manager.register("bash", "sleep forever", untilCancelled, { id: "own-job", ownerId: session.getAgentId() });
	manager.register("bash", "someone else's job", untilCancelled, { id: "foreign-job", ownerId: "0-Other" });
}

await runRpcMode(session);
