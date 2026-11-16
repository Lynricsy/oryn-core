/**
 * Oryn：`ORYN_HINDSIGHT_PROJECT` 覆盖 Hindsight 的项目标签（见 ORYN.md「例外清单」）。
 * orb 里所有项目的 cwd 相同，标签与 mental model 的 id 后缀必须改由控制面的项目 ID 决定。
 */
import { afterEach, describe, expect, it } from "bun:test";
import { computeBankScope } from "@oh-my-pi/pi-coding-agent/hindsight/bank";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { resolveSeedsForScope } from "@oh-my-pi/pi-coding-agent/hindsight/mental-models";
import { ORYN_HINDSIGHT_PROJECT_ENV } from "@oh-my-pi/pi-coding-agent/hindsight/oryn-project";

const saved = process.env[ORYN_HINDSIGHT_PROJECT_ENV];

afterEach(() => {
	if (saved === undefined) delete process.env[ORYN_HINDSIGHT_PROJECT_ENV];
	else process.env[ORYN_HINDSIGHT_PROJECT_ENV] = saved;
});

const config = (scoping: HindsightConfig["scoping"]): HindsightConfig => ({
	hindsightApiUrl: "http://localhost:8888",
	hindsightApiToken: null,
	bankId: "oryn",
	bankIdPrefix: "",
	scoping,
	globalScope: false,
	bankMission: "",
	retainMission: null,
	autoRecall: true,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 3,
	retainOverlapTurns: 2,
	retainContext: "omp",
	recallBudget: "mid",
	recallMaxTokens: 1024,
	recallTypes: ["world", "experience"],
	recallContextTurns: 1,
	recallMaxQueryChars: 800,
	recallPromptPreamble: "preamble",
	debug: false,
	requestTimeoutMs: 30_000,
	reflectTimeoutMs: 120_000,
	recallTimeoutMs: 30_000,
	retainTimeoutMs: 60_000,
	mentalModelsEnabled: true,
	mentalModelAutoSeed: true,
	mentalModelMaxRenderChars: 16_000,
});

describe("ORYN_HINDSIGHT_PROJECT", () => {
	it("设置后项目标签与 mental model id 后缀都取控制面的项目 ID（转小写），不看 cwd", () => {
		process.env[ORYN_HINDSIGHT_PROJECT_ENV] = "  PRJ_01ABC  ";
		const scope = computeBankScope(config("per-project-tagged"), "/home/oryn/workspace/repo");
		expect(scope).toEqual({
			bankId: "oryn",
			retainTags: ["project:prj_01abc"],
			recallTags: ["project:prj_01abc"],
			recallTagsMatch: "any",
		});
		const ids = resolveSeedsForScope(scope, "per-project-tagged").map(seed => seed.id);
		expect(ids).toContain("project-conventions-prj_01abc");
		expect(ids).toContain("user-preferences");
		expect(computeBankScope(config("per-project"), "/home/oryn/workspace/repo").bankId).toBe("oryn-prj_01abc");
	});

	it("未设置时按 cwd 推导，行为与上游相同", () => {
		delete process.env[ORYN_HINDSIGHT_PROJECT_ENV];
		expect(computeBankScope(config("per-project-tagged"), "/work/General").retainTags).toEqual(["project:general"]);
	});

	it("只有空白时视为未设置", () => {
		process.env[ORYN_HINDSIGHT_PROJECT_ENV] = "   ";
		expect(computeBankScope(config("per-project-tagged"), "/work/proj").retainTags).toEqual(["project:proj"]);
	});
});
