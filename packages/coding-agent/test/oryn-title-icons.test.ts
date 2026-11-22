import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { nerdFontGlyph } from "@oh-my-pi/pi-coding-agent/utils/nerd-font-glyphs";
import { ORYN_NERD_GLYPHS_ENV } from "@oh-my-pi/pi-coding-agent/utils/oryn-nerd-glyphs";
import * as titleGenerator from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { setInteractiveHost } from "@oh-my-pi/pi-utils/env";

const FIRST_MESSAGE = "fix the flaky park tests";
const CARD_REPLY = '<title nf="nf-md-flask" emoji="🧪" code="FLAKY">Fix flaky park tests</title>';
const EMOJI_TITLE = "🧪 FLAKY: Fix flaky park tests";
const NERD_TITLE = `${nerdFontGlyph("nf-md-flask")} FLAKY: Fix flaky park tests`;

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	// Full-suite files that boot main() in ACP/RPC mode leave PI_NO_TITLE=1 behind.
	for (const key of ["PI_NO_TITLE", ORYN_NERD_GLYPHS_ENV]) {
		saved[key] = Bun.env[key];
		delete Bun.env[key];
	}
});

afterEach(async () => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	vi.restoreAllMocks();
	await session?.dispose();
	authStorage?.close();
	session = undefined;
	authStorage = undefined;
});

async function createSession(main: MockModel, side: MockModel): Promise<AgentSession> {
	// One test titles several sessions in turn; only the newest stays open.
	await session?.dispose();
	authStorage?.close();
	authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
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
		sideStreamFn: side.stream,
		autoTitle: true,
	});
	return session;
}

/** The auto title a session gets on `interactive` host, with the TUI's symbol preset at `nerdPreset`. */
async function autoTitle(interactive: boolean, nerdPreset: boolean): Promise<string | undefined> {
	vi.spyOn(titleGenerator, "nerdGlyphsActive").mockReturnValue(nerdPreset);
	const previous = setInteractiveHost(interactive);
	try {
		const main = createMockModel({ responses: [{ content: ["Reading the park tests first."] }] });
		const side = createMockModel({ handler: { content: [CARD_REPLY] } });
		const target = await createSession(main, side);
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = target.sessionManager.onSessionNameChanged(() => {
			unsubscribe();
			resolve();
		});
		await target.prompt(FIRST_MESSAGE);
		await promise;
		return target.sessionName;
	} finally {
		setInteractiveHost(previous);
	}
}

describe("Oryn: RPC host Nerd Fonts title icons", () => {
	it("gives an RPC host the Nerd Fonts glyph once it sets ORYN_NERD_GLYPHS", async () => {
		expect(nerdFontGlyph("nf-md-flask")).toBeTruthy();
		expect(await autoTitle(false, false)).toBe(EMOJI_TITLE);
		Bun.env[ORYN_NERD_GLYPHS_ENV] = "1";
		expect(await autoTitle(false, false)).toBe(NERD_TITLE);
	});

	it("leaves the TUI on its symbol preset whatever the flag says", async () => {
		Bun.env[ORYN_NERD_GLYPHS_ENV] = "1";
		expect(await autoTitle(true, false)).toBe(EMOJI_TITLE);
		expect(await autoTitle(true, true)).toBe(NERD_TITLE);
	});
});
