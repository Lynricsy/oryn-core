/**
 * Contract (Oryn): the session artifacts dir also holds Core's own sidecars — the selective-commit
 * change journal `changes.jsonl`, and `local/`, `url-search/`, `blobs/`, … directories. `history://`
 * must not list them as agent transcripts, must still serve a real subagent transcript that happens
 * to live at `changes.jsonl` (a subagent named `changes` before the stem was reserved), and new
 * subagents must not be allocated a sidecar's name.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { AgentOutputManager } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { resourceText } from "./helpers/resource-text";

/** Header + one user/assistant exchange, as Core writes a subagent transcript. */
function transcript(userText: string): string {
	const timestamp = new Date().toISOString();
	const lines = [
		{ type: "session", version: CURRENT_SESSION_VERSION, id: `s-${userText}`, timestamp, cwd: "/tmp" },
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp,
			message: { role: "user", content: userText, timestamp: 1 },
		},
		{
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test-model",
				usage: {},
				stopReason: "stop",
				timestamp: 2,
			},
		},
	];
	return lines.map(line => `${JSON.stringify(line)}\n`).join("");
}

/** One change-journal record (`commit/selective/journal.ts` `ChangeRecord`). */
const JOURNAL_RECORD = `${JSON.stringify({
	type: "change",
	at: 1,
	agent: "Main",
	tool: "edit",
	path: "/repo/a.ts",
	before: "a",
	after: "b",
})}\n`;

function registerMain(artifactsDir: string): void {
	AgentRegistry.global().register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: {
			messages: [],
			sessionManager: { getArtifactsDir: () => artifactsDir },
		} as unknown as AgentSession,
		sessionFile: `${artifactsDir}.jsonl`,
		status: "idle",
	});
}

async function historyIndex(): Promise<string> {
	return resourceText(await InternalUrlRouter.instance().resolve("history://"));
}

describe("Oryn artifact sidecars", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
		resetRegisteredArtifactDirsForTests();
	});
	afterEach(() => {
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
	});

	it("history:// lists subagents only: not the change journal, advisor transcripts or sidecar dirs", async () => {
		using tmp = TempDir.createSync("@oryn-sidecars-");
		const artifacts = path.join(tmp.path(), "session");
		await Bun.write(path.join(artifacts, "Worker.jsonl"), transcript("worker task"));
		// A subagent bumped off the reserved advisor stem is a real transcript.
		await Bun.write(path.join(artifacts, "__advisor-2.jsonl"), transcript("bumped task"));
		await Bun.write(path.join(artifacts, "__advisor.jsonl"), transcript("advice"));
		await Bun.write(path.join(artifacts, "changes.jsonl"), JOURNAL_RECORD + JOURNAL_RECORD);
		// Session-shaped data under sidecar dirs is still not a transcript.
		await Bun.write(path.join(artifacts, "local", "LocalData.jsonl"), transcript("local data"));
		await Bun.write(path.join(artifacts, "url-search", "Fetched.jsonl"), transcript("fetched"));
		registerMain(artifacts);

		const index = await historyIndex();

		expect(index).toContain("| Worker | on disk |");
		expect(index).toContain("| __advisor-2 | on disk |");
		expect(index).not.toContain("| changes |");
		expect(index).not.toContain("| __advisor |");
		expect(index).not.toContain("LocalData");
		expect(index).not.toContain("Fetched");
	});

	it("history:// still serves a subagent transcript stored at changes.jsonl", async () => {
		using tmp = TempDir.createSync("@oryn-sidecars-");
		const artifacts = path.join(tmp.path(), "session");
		// A subagent named `changes` before the stem was reserved: title slot, then the session header.
		const slot = serializeTitleSlot({ title: "audit", updatedAt: new Date().toISOString() });
		await Bun.write(path.join(artifacts, "changes.jsonl"), slot + transcript("legacy changes task"));
		registerMain(artifacts);

		expect(await historyIndex()).toContain("| changes | on disk |");
		const resource = await InternalUrlRouter.instance().resolve("history://changes");
		expect(resourceText(resource)).toContain("legacy changes task");
	});

	it("never allocates a sidecar name to a subagent, in any letter case", async () => {
		const mgr = new AgentOutputManager(() => null);

		expect(await mgr.allocate("changes")).toBe("changes-2");
		// On a case-folding filesystem `Local/` is the `local://` root.
		expect(await mgr.allocate("Local")).toBe("Local-2");
		expect(await mgr.allocate("changes-log")).toBe("changes-log");
	});

	it("never hands out two ids that differ only in letter case, keeping the requested spelling", async () => {
		using tmp = TempDir.createSync("@oryn-sidecars-");
		await Bun.write(path.join(tmp.path(), "Worker.jsonl"), transcript("prior"));
		const mgr = new AgentOutputManager(() => tmp.path());
		await mgr.reserve(["Gone"]);

		// Each pair would share `<id>.jsonl` on a case-folding filesystem.
		expect(await mgr.allocate("Local")).toBe("Local-2");
		expect(await mgr.allocate("local")).toBe("local-3");
		expect(await mgr.allocate("Anna")).toBe("Anna");
		expect(await mgr.allocate("anna")).toBe("anna-2");
		expect(await mgr.allocate("worker")).toBe("worker-2");
		expect(await mgr.allocate("gone")).toBe("gone-2");
	});
});
