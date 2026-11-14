import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import {
	handleOrynMarkSessionStart,
	handleOrynSelectModel,
	ORYN_MODEL_SOURCE_ENTRY,
	type OrynModelSourceSession,
	roleAliasTarget,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/oryn-model-source";
import type { CustomEntry, ModelChangeEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";

const SOL = { provider: "openai", id: "gpt-6.1-sol" } as Model;
const OPUS = { provider: "anthropic", id: "claude-opus-5" } as Model;
const HAIKU = { provider: "anthropic", id: "claude-haiku-5" } as Model;

interface Fixture {
	session: OrynModelSourceSession;
	/** role → `settings.getModelRole` 的原始值。 */
	roleValues: Record<string, string>;
	/** role → `resolveRoleModelWithThinking` 解析出的模型。 */
	roleModels: Record<string, Model | undefined>;
	/** 设置后 `setModel` 抛出这条消息（模拟没有凭据）。 */
	setModelError?: string;
	backgroundRefreshes: number;
}

/**
 * 真实 SessionManager + 替身会话：`setModel(model, role = "default")` 与 omp 一样只写一条
 * `model_change` 并更新活动模型；`applyRoleModel` 转调 `setModel(model, role)`。
 */
function fixture(manager: SessionManager, current: Model | null = SOL): Fixture {
	let model = current ?? undefined;
	const fx: Fixture = {
		roleValues: {},
		roleModels: { default: SOL, Mare: SOL, Cyrene: OPUS, slow: OPUS },
		backgroundRefreshes: 0,
		session: undefined as unknown as OrynModelSourceSession,
	};
	const setModel = async (next: Model, role = "default") => {
		if (fx.setModelError) throw new Error(fx.setModelError);
		manager.appendModelChange(`${next.provider}/${next.id}`, role);
		model = next;
		return { switched: true };
	};
	fx.session = {
		sessionManager: manager,
		settings: { getModelRole: role => fx.roleValues[role] },
		modelRegistry: {
			async awaitBackgroundRefresh() {
				fx.backgroundRefreshes++;
			},
		},
		get model() {
			return model;
		},
		thinkingLevel: Effort.High,
		getAvailableModels: () => [SOL, OPUS, HAIKU],
		setModel,
		applyRoleModel: entry => setModel(entry.model, entry.role).then(() => undefined),
		resolveRoleModelWithThinking: role => ({
			model: fx.roleModels[role],
			explicitThinkingLevel: false,
			warning: undefined,
		}),
	};
	return fx;
}

function sourceEntries(manager: SessionManager): CustomEntry[] {
	return manager
		.getBranch()
		.filter((e): e is CustomEntry => e.type === "custom" && e.customType === ORYN_MODEL_SOURCE_ENTRY);
}

function tail(manager: SessionManager, n: number) {
	return manager.getBranch().slice(-n);
}

describe("oryn model source", () => {
	let root: string;
	let cwd: string;
	let sessionDir: string;
	let manager: SessionManager;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-oryn-model-source-"));
		setAgentDir(path.join(root, "agent"));
		cwd = path.join(root, "project");
		sessionDir = path.join(root, "threads", "T-1");
		fs.mkdirSync(cwd, { recursive: true });
		manager = SessionManager.create(cwd, sessionDir);
		// 与 sdk 启动一致：会话第一条是不带 role 的 model_change。
		manager.appendModelChange("openai/gpt-6.1-sol");
	});

	afterEach(async () => {
		await manager.close();
		if (originalAgentDir) setAgentDir(originalAgentDir);
		else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		fs.rmSync(root, { recursive: true, force: true });
	});

	describe("oryn_select_model", () => {
		it("K1: role selection writes model_change{role} then a role source record", async () => {
			const fx = fixture(manager);
			const result = await handleOrynSelectModel(fx.session, { role: "Mare" });

			const [change, record] = tail(manager, 2);
			expect(change).toMatchObject({ type: "model_change", model: "openai/gpt-6.1-sol", role: "Mare" });
			expect(record).toMatchObject({ type: "custom", customType: "oryn-model-source" });
			expect((record as CustomEntry).data).toEqual({
				v: 1,
				source: "role",
				role: "Mare",
				model: "openai/gpt-6.1-sol",
			});
			expect(result).toEqual({ model: SOL, thinkingLevel: Effort.High, source: "role", role: "Mare" });
		});

		it("K2: manual selection of the role's model writes role default and a role-less manual record", async () => {
			const fx = fixture(manager);
			await handleOrynSelectModel(fx.session, { role: "Mare" });
			const result = await handleOrynSelectModel(fx.session, { provider: "openai", modelId: "gpt-6.1-sol" });

			const [change, record] = tail(manager, 2);
			expect(change).toMatchObject({ type: "model_change", model: "openai/gpt-6.1-sol", role: "default" });
			const data = (record as CustomEntry).data as Record<string, unknown>;
			expect(data).toEqual({ v: 1, source: "manual", model: "openai/gpt-6.1-sol" });
			expect(Object.hasOwn(data, "role")).toBe(false);
			expect(Object.hasOwn(data, "alias")).toBe(false);
			expect(result).toEqual({ model: SOL, thinkingLevel: Effort.High, source: "manual" });

			const [roleRecord, manualRecord] = sourceEntries(manager).map(e => e.data as Record<string, unknown>);
			expect(roleRecord.model).toBe(manualRecord.model);
			expect(roleRecord.source).not.toBe(manualRecord.source);
		});

		it("K3: clicking the default role and manually picking the default model record different sources", async () => {
			const fx = fixture(manager, HAIKU);
			await handleOrynSelectModel(fx.session, { role: "default" });
			await handleOrynSelectModel(fx.session, { provider: "openai", modelId: "gpt-6.1-sol" });

			const changes = manager.getBranch().filter((e): e is ModelChangeEntry => e.type === "model_change");
			expect(changes.slice(-2).map(c => c.role)).toEqual(["default", "default"]);
			expect(sourceEntries(manager).map(e => e.data)).toEqual([
				{ v: 1, source: "role", role: "default", model: "openai/gpt-6.1-sol" },
				{ v: 1, source: "manual", model: "openai/gpt-6.1-sol" },
			]);
		});

		it("K4: records the one-hop alias target of a role in the record and the response", async () => {
			const fx = fixture(manager);
			fx.roleValues = { Mare: "@Cyrene", Cyrene: "anthropic/claude-opus-5" };
			fx.roleModels.Mare = OPUS;
			const result = await handleOrynSelectModel(fx.session, { role: "Mare" });
			expect(result).toMatchObject({ source: "role", role: "Mare", alias: "Cyrene" });
			expect(sourceEntries(manager)[0]?.data).toEqual({
				v: 1,
				source: "role",
				role: "Mare",
				alias: "Cyrene",
				model: "anthropic/claude-opus-5",
			});
		});

		it("K5: rejects malformed arguments without touching the branch", async () => {
			const fx = fixture(manager);
			const before = manager.getBranch().length;
			const cases: [Record<string, unknown>, string][] = [
				[{}, "oryn_select_model requires either role or provider+modelId"],
				[{ role: "A", provider: "p", modelId: "m" }, "oryn_select_model requires either role or provider+modelId"],
				[{ provider: "p" }, "provider and modelId must be given together"],
				[{ modelId: "m" }, "provider and modelId must be given together"],
				[{ role: "" }, "oryn_select_model requires either role or provider+modelId"],
				[{ provider: "", modelId: "m" }, "oryn_select_model requires either role or provider+modelId"],
			];
			for (const [command, message] of cases) {
				await expect(handleOrynSelectModel(fx.session, command)).rejects.toThrow(message);
			}
			expect(manager.getBranch().length).toBe(before);
		});

		it("K6: a failed lookup or switch writes neither a record nor a model_change", async () => {
			const fx = fixture(manager);
			fx.roleModels.Empty = undefined;
			const before = manager.getBranch().length;

			await expect(handleOrynSelectModel(fx.session, { provider: "openai", modelId: "nope" })).rejects.toThrow(
				"Model not found: openai/nope",
			);
			// 不在目录里时先等后台发现再查一次（同 set_model）。
			expect(fx.backgroundRefreshes).toBe(1);
			await expect(handleOrynSelectModel(fx.session, { role: "Empty" })).rejects.toThrow(
				"Role has no available model: Empty",
			);

			fx.setModelError = "No API key for openai/gpt-6.1-sol";
			await expect(handleOrynSelectModel(fx.session, { role: "Mare" })).rejects.toThrow(fx.setModelError);
			await expect(
				handleOrynSelectModel(fx.session, { provider: "openai", modelId: "gpt-6.1-sol" }),
			).rejects.toThrow(fx.setModelError);

			expect(manager.getBranch().length).toBe(before);
			expect(sourceEntries(manager)).toEqual([]);
		});
	});

	describe("roleAliasTarget", () => {
		it("K4: follows exactly one single-alias hop", () => {
			const values: Record<string, string> = { Cyrene: "anthropic/claude-opus-5", Mare: "openai/gpt-6.1-sol" };
			const settings = { getModelRole: (role: string) => values[role] };
			const target = (role: string, value: string) => {
				values[role] = value;
				return roleAliasTarget(settings, role);
			};

			expect(target("default", "@Cyrene")).toBe("Cyrene");
			expect(target("default", "@Cyrene:high")).toBe("Cyrene");
			expect(target("default", "pi/slow")).toBe("slow");
			expect(target("x", "*")).toBe("default");
			expect(target("x", "*:low")).toBe("default");

			expect(target("default", "@Cyrene,@Mare")).toBeUndefined();
			expect(target("default", "openai/gpt-6.1-sol")).toBeUndefined();
			expect(target("default", "@nope")).toBeUndefined();
			expect(target("default", "@default")).toBeUndefined();
			expect(roleAliasTarget(settings, "unset")).toBeUndefined();
			// 只走一跳：Mare → Cyrene，即使 Cyrene 本身又是别名。
			values.Cyrene = "@slow";
			expect(target("Mare", "@Cyrene")).toBe("Cyrene");
		});
	});

	describe("oryn_mark_session_start", () => {
		it("K7: records a startup source for a fresh default-role session exactly once", async () => {
			const fx = fixture(manager);
			fx.roleValues = { default: "@Cyrene", Cyrene: "openai/gpt-6.1-sol" };
			const first = await handleOrynMarkSessionStart(fx.session, {});
			expect(first).toEqual({
				recorded: true,
				source: "startup",
				role: "default",
				alias: "Cyrene",
				model: "openai/gpt-6.1-sol",
			});
			expect(sourceEntries(manager).map(e => e.data)).toEqual([
				{ v: 1, source: "startup", role: "default", alias: "Cyrene", model: "openai/gpt-6.1-sol" },
			]);

			const count = manager.getBranch().length;
			expect(await handleOrynMarkSessionStart(fx.session, {})).toEqual({ recorded: false });
			expect(await handleOrynMarkSessionStart(fx.session, { explicitModel: true })).toEqual({ recorded: false });
			expect(manager.getBranch().length).toBe(count);
		});

		it("K8: an explicitly chosen startup model records a role-less manual source", async () => {
			const fx = fixture(manager);
			manager.appendModelChange("openai/gpt-6.1-sol", "default");
			// default 解析到别的模型也不影响：显式选择不做核实。
			fx.roleModels.default = HAIKU;
			const result = await handleOrynMarkSessionStart(fx.session, { explicitModel: true });
			expect(result).toEqual({ recorded: true, source: "manual", model: "openai/gpt-6.1-sol" });
			const data = sourceEntries(manager)[0]?.data as Record<string, unknown>;
			expect(data).toEqual({ v: 1, source: "manual", model: "openai/gpt-6.1-sol" });
			expect(Object.hasOwn(data, "role")).toBe(false);
		});

		it("K9: records nothing when the startup model cannot be verified as the default role", async () => {
			const startup = (m: SessionManager) => m.appendModelChange("openai/gpt-6.1-sol");
			const cases: { label: string; arrange: (m: SessionManager, fx: Fixture) => void; current?: null }[] = [
				{
					label: "a user message",
					arrange: m => {
						startup(m);
						m.appendMessage({ role: "user", content: "hi", timestamp: 1 });
					},
				},
				{
					label: "a second model_change",
					arrange: m => {
						startup(m);
						m.appendModelChange("openai/gpt-6.1-sol", "default");
					},
				},
				{
					label: "a role on the only model_change",
					arrange: m => m.appendModelChange("openai/gpt-6.1-sol", "Mare"),
				},
				{
					label: "a retry-fallback root model_change",
					arrange: m => m.appendModelChange("openai/gpt-6.1-sol", undefined, true),
				},
				{
					label: "a model_change naming another model",
					arrange: m => m.appendModelChange("anthropic/claude-haiku-5"),
				},
				{
					label: "default resolving elsewhere",
					arrange: (m, fx) => {
						startup(m);
						fx.roleModels.default = HAIKU;
					},
				},
				{
					label: "default resolving to nothing",
					arrange: (m, fx) => {
						startup(m);
						fx.roleModels.default = undefined;
					},
				},
				{ label: "no active model", arrange: startup, current: null },
			];
			for (const { label, arrange, current } of cases) {
				const local = SessionManager.create(cwd, path.join(root, "threads", label.replaceAll(" ", "-")));
				try {
					const fx = fixture(local, current);
					arrange(local, fx);
					const before = local.getBranch().length;
					const result = await handleOrynMarkSessionStart(fx.session, {});
					expect({ label, result, count: local.getBranch().length }).toEqual({
						label,
						result: { recorded: false },
						count: before,
					});
				} finally {
					await local.close();
				}
			}
		});

		it("K10: a branch without any model_change (newSession path) still records startup", async () => {
			const local = SessionManager.create(cwd, path.join(root, "threads", "T-new"));
			try {
				const fx = fixture(local);
				expect(local.getBranch().some(e => e.type === "model_change")).toBe(false);
				expect(await handleOrynMarkSessionStart(fx.session, {})).toEqual({
					recorded: true,
					source: "startup",
					role: "default",
					model: "openai/gpt-6.1-sol",
				});
			} finally {
				await local.close();
			}
		});
	});

	describe("ensureOnDisk", () => {
		it("K11: commands materialize the session file with the record before any assistant message", async () => {
			const file = manager.getSessionFile();
			expect(file).toBeString();
			// 对照：只有启动元数据时会话文件尚未落盘。
			expect(fs.existsSync(file as string)).toBe(false);

			const fx = fixture(manager);
			await handleOrynSelectModel(fx.session, { role: "Mare" });
			expect(fs.existsSync(file as string)).toBe(true);
			const lines = fs
				.readFileSync(file as string, "utf8")
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line));
			expect(lines.filter(l => l.type === "custom" && l.customType === ORYN_MODEL_SOURCE_ENTRY)).toEqual([
				expect.objectContaining({
					data: { v: 1, source: "role", role: "Mare", model: "openai/gpt-6.1-sol" },
				}),
			]);
		});

		it("K11: mark_session_start also materializes the file", async () => {
			const file = manager.getSessionFile() as string;
			expect(fs.existsSync(file)).toBe(false);
			const fx = fixture(manager);
			await handleOrynMarkSessionStart(fx.session, {});
			expect(fs.readFileSync(file, "utf8")).toContain('"customType":"oryn-model-source"');
		});
	});
});
