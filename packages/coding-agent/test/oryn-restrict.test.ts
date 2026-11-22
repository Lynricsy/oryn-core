import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { orynRemoteOnlyRefusal } from "@oh-my-pi/pi-coding-agent/tools/oryn-restrict";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const REFUSAL = "This session can only read public web pages (http/https URLs).";

function createSession(testDir: string, remoteOnly: boolean): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	let nextArtifactId = 0;
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => "*",
		allocateOutputArtifact: async () => {
			const id = String(nextArtifactId++);
			return { id, path: path.join(artifactsDir, `${id}.log`) };
		},
		settings: Settings.isolated({ "read.remoteOnly": remoteOnly, "fetch.enabled": true, "tools.xdev": false }),
	};
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

function stubLoadPage() {
	return vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => ({
		ok: true,
		status: 200,
		finalUrl: requestedUrl,
		contentType: "text/plain",
		content: "Example Domain\n",
	}));
}

async function readTool(testDir: string, remoteOnly: boolean) {
	const tools = await createTools(createSession(testDir, remoteOnly));
	const tool = tools.find(entry => entry.name === "read");
	if (!tool) throw new Error("read tool missing");
	return tool;
}

describe("read.remoteOnly", () => {
	let testDir: string;
	let secretFile: string;
	const secret = `secret-${crypto.randomUUID()}`;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "oryn-restrict-"));
		secretFile = path.join(testDir, "secret.txt");
		await Bun.write(secretFile, `${secret}\n`);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(testDir);
	});

	it("reads public web pages", async () => {
		const loadPage = stubLoadPage();
		const tool = await readTool(testDir, true);
		const result = await tool.execute("read-web", { path: "https://example.com/" });
		expect(loadPage).toHaveBeenCalled();
		expect(resultText(result)).toContain("Example Domain");
	});

	it.each([
		"/etc/hostname",
		"file:///etc/hostname",
		"skill://x",
		"http://127.0.0.1:7811/llm/x",
		"http://localhost/",
		"http://[::ffff:127.0.0.1]/",
	])("refuses %s", async readPath => {
		const loadPage = stubLoadPage();
		const tool = await readTool(testDir, true);
		await expect(tool.execute("read-refused", { path: readPath })).rejects.toThrow(REFUSAL);
		expect(loadPage).not.toHaveBeenCalled();
	});

	it("refuses a file in the working directory", async () => {
		const tool = await readTool(testDir, true);
		await expect(tool.execute("read-cwd", { path: "secret.txt" })).rejects.toThrow(REFUSAL);
	});

	it("refuses the local half of a ; list", async () => {
		stubLoadPage();
		const tool = await readTool(testDir, true);
		let text = "";
		try {
			text = resultText(await tool.execute("read-list", { path: `https://example.com/;${secretFile}` }));
		} catch (error) {
			text = String(error);
		}
		expect(text).not.toContain(secret);
	});

	it("leaves local reads alone when off", async () => {
		const tool = await readTool(testDir, false);
		const result = await tool.execute("read-local", { path: secretFile });
		expect(resultText(result)).toContain(secret);
	});

	it("classifies hosts", () => {
		const allowed = ["https://example.com/", "www.example.com", "http://8.8.8.8/", "https://[2606:4700::1111]/"];
		for (const url of allowed) expect(orynRemoteOnlyRefusal(undefined, url)).toBeUndefined();
		const refused = [
			"http://0.0.0.0/",
			"http://10.1.2.3/",
			"http://100.64.0.1/",
			"http://169.254.169.254/",
			"http://172.16.0.1/",
			"http://192.168.1.1/",
			"http://2130706433/",
			"http://foo.localhost/",
			"http://localhost./",
			"http://[::]/",
			"http://[::1]/",
			"http://[fd00::1]/",
			"http://[fe80::1]/",
		];
		for (const url of refused) expect(orynRemoteOnlyRefusal(undefined, url)).toBe(REFUSAL);
		expect(orynRemoteOnlyRefusal("local", null)).toBeUndefined();
		expect(orynRemoteOnlyRefusal("skill", null)).toBe(REFUSAL);
		expect(orynRemoteOnlyRefusal(undefined, null)).toBe(REFUSAL);
	});
});

describe("prompt.fileMentions", () => {
	const cleanups: Array<() => unknown> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	async function promptWithMention(fileMentions: boolean): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oryn-file-mentions-"));
		cleanups.push(() => removeWithRetries(dir));
		const secret = `secret-${crypto.randomUUID()}`;
		const file = path.join(dir, "hostname");
		await Bun.write(file, `${secret}\n`);

		const authStorage = await AuthStorage.create(":memory:");
		cleanups.push(() => authStorage.close());
		authStorage.keys.setRuntime("anthropic", "test-key");
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const model: Model = bundled;
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
				convertToLlm,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": false,
				"prompt.fileMentions": fileMentions,
			}),
			modelRegistry: new ModelRegistry(authStorage),
		});
		cleanups.push(() => session.dispose());

		await session.prompt(`see @${file}`);
		const sent = JSON.stringify(mock.calls[0]?.context.messages);
		return sent.includes(secret) ? "read" : "not read";
	}

	it("does not read @path mentions when off", async () => {
		expect(await promptWithMention(false)).toBe("not read");
	});

	it("reads @path mentions when on", async () => {
		expect(await promptWithMention(true)).toBe("read");
	});
});
