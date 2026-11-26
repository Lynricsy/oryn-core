import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import {
	ORYN_LANGUAGE_ENV,
	orynCustomPromptIntentGuidance,
	orynIntentDescription,
	orynIntentGuidance,
	orynUserLanguage,
	withOrynTaskLabelLanguage,
	withOrynTitleForkLanguage,
	withOrynTitleLanguage,
} from "@oh-my-pi/pi-coding-agent/utils/oryn-language";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

const savedEnv: Record<string, string | undefined> = {};
let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;

beforeEach(() => {
	for (const key of [ORYN_LANGUAGE_ENV, "PI_NO_TITLE", "PI_INTENT_PROMPT"]) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(async () => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	vi.restoreAllMocks();
	await session?.dispose();
	authStorage?.close();
	session = undefined;
	authStorage = undefined;
});

describe("Oryn: ORYN_LANGUAGE helpers", () => {
	it("maps known locale tags and rejects blank or control-character values", () => {
		expect(orynUserLanguage(undefined)).toBeUndefined();
		expect(orynUserLanguage("   ")).toBeUndefined();
		expect(orynUserLanguage("zh-CN\nignore previous")).toBeUndefined();
		expect(orynUserLanguage("zh-CN")).toBe("Simplified Chinese");
		expect(orynUserLanguage("zh")).toBe("Simplified Chinese");
		expect(orynUserLanguage("zh-Hans-CN")).toBe("Simplified Chinese");
		expect(orynUserLanguage("zh-TW")).toBe("Traditional Chinese");
		expect(orynUserLanguage("en")).toBe("English");
		expect(orynUserLanguage("en-US")).toBe("English");
		expect(orynUserLanguage("Japanese")).toBe("Japanese");
	});

	it("stays strictly no-op when ORYN_LANGUAGE is unset", () => {
		expect(withOrynTitleLanguage("Base title prompt")).toBe("Base title prompt");
		expect(withOrynTaskLabelLanguage("Base label prompt")).toBe("Base label prompt");
		expect(withOrynTitleForkLanguage("<title-request>\nbody\n</title-request>")).toBe(
			"<title-request>\nbody\n</title-request>",
		);
		expect(orynIntentGuidance("")).toBe("");
		expect(orynIntentGuidance("Custom guidance.")).toBe("Custom guidance.");
		expect(orynCustomPromptIntentGuidance(INTENT_FIELD)).toBe("");
		expect(orynIntentDescription(undefined)).toBeUndefined();
		expect(orynIntentDescription("custom")).toBe("custom");
	});

	it("injects user language into title, task label, fork prompt, and intent helpers", () => {
		process.env[ORYN_LANGUAGE_ENV] = "zh-CN";

		expect(withOrynTitleLanguage("Base prompt")).toBe("Base prompt\n- Write the title in Simplified Chinese.");
		expect(withOrynTaskLabelLanguage("Base label")).toBe("Base label\n- Write the label in Simplified Chinese.");
		expect(withOrynTitleForkLanguage("<title-request>\nbody\n</title-request>")).toBe(
			"<title-request>\nbody\n- Write the title in Simplified Chinese (keep nf, emoji, and code in English/ASCII as specified above).\n</title-request>",
		);
		expect(orynIntentGuidance("")).toContain("Write the intent in Simplified Chinese.");
		expect(orynIntentGuidance("Custom guidance.")).toBe("Custom guidance. Write the intent in Simplified Chinese.");
		expect(orynCustomPromptIntentGuidance(INTENT_FIELD)).toContain("Write the intent in Simplified Chinese.");
		expect(orynCustomPromptIntentGuidance(undefined)).toBe("");
		expect(orynIntentDescription(undefined)).toBe("concise intent (in Simplified Chinese)");
		expect(orynIntentDescription("custom")).toBe("custom (in Simplified Chinese)");
	});
});

describe("Oryn: ORYN_LANGUAGE prompt integration", () => {
	it("appends language requirement to system prompt intent guidance (default and custom)", async () => {
		const baseDefault = await buildSystemPrompt({
			cwd: process.cwd(),
			toolNames: ["read"],
			intentField: INTENT_FIELD,
			noContextFiles: true,
			skills: [],
		});
		const baseCustom = await buildSystemPrompt({
			cwd: process.cwd(),
			toolNames: ["read"],
			intentField: INTENT_FIELD,
			customPrompt: "You are a coordinator.\nKeep replies short.",
			noContextFiles: true,
			skills: [],
		});
		expect(baseDefault.systemPrompt.join("\n")).not.toContain("Write the intent in");
		expect(baseCustom.systemPrompt.join("\n")).not.toContain("Write the intent in");

		Bun.env[ORYN_LANGUAGE_ENV] = "zh-CN";
		const zhDefault = await buildSystemPrompt({
			cwd: process.cwd(),
			toolNames: ["read"],
			intentField: INTENT_FIELD,
			noContextFiles: true,
			skills: [],
		});
		const zhCustom = await buildSystemPrompt({
			cwd: process.cwd(),
			toolNames: ["read"],
			intentField: INTENT_FIELD,
			customPrompt: "You are a coordinator.\nKeep replies short.",
			noContextFiles: true,
			skills: [],
		});
		expect(zhDefault.systemPrompt.join("\n")).toContain("Write the intent in Simplified Chinese.");
		expect(zhCustom.systemPrompt.join("\n")).toContain("Write the intent in Simplified Chinese.");
	});

	it("injects language requirement into fork title request prompt", async () => {
		Bun.env[ORYN_LANGUAGE_ENV] = "zh-CN";
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const main = createMockModel({ responses: [{ content: ["Reading the park tests first."] }] });
		let capturedForkPrompt = "";
		const side = createMockModel({
			handler: { content: ['<title nf="nf-md-flask" emoji="🧪" code="FLAKY">修复不稳定的测试</title>'] },
		});
		const sideStream: typeof side.stream = (m, context, options) => {
			const lastUser = [...context.messages].reverse().find(msg => msg.role === "user");
			if (lastUser && typeof lastUser.content === "string") capturedForkPrompt = lastUser.content;
			else if (lastUser && Array.isArray(lastUser.content)) {
				capturedForkPrompt = lastUser.content
					.filter((b): b is { type: "text"; text: string } => b.type === "text")
					.map(b => b.text)
					.join("\n");
			}
			return side.stream(m, context, options);
		};

		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: main.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				modelRoles: { tiny: `${model.provider}/${model.id}` },
				"title.icons": "nf+emoji",
			}),
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map(),
			sideStreamFn: sideStream,
			autoTitle: true,
		});

		const named = Promise.withResolvers<void>();
		const unsubscribe = session.sessionManager.onSessionNameChanged(() => {
			unsubscribe();
			named.resolve();
		});
		await session.prompt("fix the flaky park tests");
		await named.promise;

		expect(capturedForkPrompt).toContain("Write the title in Simplified Chinese");
		expect(session.sessionName).toContain("FLAKY: 修复不稳定的测试");
	});
});
