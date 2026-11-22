import { describe, expect, test } from "bun:test";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { buildRpcUsageResult } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-extensions";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/**
 * get_usage projection contract (#72): rows carry the account the REPORT belongs
 * to, and routing-specific copies of one shared quota arrive collapsed exactly
 * as the TUI dashboard and CLI present them.
 */

function limit(id: string, sharedGroup?: string): UsageLimit {
	return {
		id,
		label: `Weekly ${id}`,
		scope: { provider: "anthropic", ...(sharedGroup ? { sharedGroup } : {}) },
		amount: { used: 10, limit: 100, unit: "percent", usedFraction: 0.1, remainingFraction: 0.9 },
	};
}

function report(email: string | undefined, limits: UsageLimit[]): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: 1,
		limits,
		...(email ? { metadata: { email } } : {}),
	};
}

function identifiedReport(metadata: Record<string, unknown>, limits: UsageLimit[]): UsageReport {
	return { provider: "anthropic", fetchedAt: 1, limits, metadata };
}

function sessionWith(reports: UsageReport[] | null, sessionEmail: string): AgentSession {
	return {
		sessionId: "s1",
		model: { provider: "anthropic" },
		fetchUsageReports: async () => reports,
		modelRegistry: {
			authStorage: { oauth: { identity: () => ({ email: sessionEmail }) } },
		},
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as AgentSession;
}

describe("buildRpcUsageResult account attribution", () => {
	test("labels each report with its own account, not the session's identity", async () => {
		const session = sessionWith(
			[report("first@example.com", [limit("a")]), report("second@example.com", [limit("b")])],
			"first@example.com",
		);

		const { reports } = await buildRpcUsageResult(session);

		expect(reports.map(row => row.account)).toEqual(["first@example.com", "second@example.com"]);
	});

	test("falls back to the session identity only when a report carries no account of its own", async () => {
		const session = sessionWith([report(undefined, [limit("a")])], "session@example.com");

		const { reports } = await buildRpcUsageResult(session);

		expect(reports[0]?.account).toBe("session@example.com");
	});

	test("keeps an accountId-only report's own account instead of the session identity", async () => {
		const session = sessionWith(
			[identifiedReport({ accountId: "kiro-account-7" }, [limit("a")])],
			"session@example.com",
		);

		const { reports } = await buildRpcUsageResult(session);

		expect(reports[0]?.account).toBe("kiro-account-7");
	});

	test("labels accounts in the CLI dashboard's order: email, then accountId, then org", async () => {
		const session = sessionWith(
			[
				identifiedReport({ email: "me@example.com", accountId: "acct-1", orgName: "Acme" }, [limit("a")]),
				identifiedReport({ accountId: "acct-2", orgName: "Acme" }, [limit("b")]),
				identifiedReport({ orgName: "Acme" }, [limit("c")]),
			],
			"session@example.com",
		);

		const { reports } = await buildRpcUsageResult(session);

		expect(reports.map(row => row.account)).toEqual(["me@example.com", "acct-2", "Acme"]);
	});
});

describe("buildRpcUsageResult shared-quota collapsing", () => {
	test("collapses routing copies of one shared quota to a single limit", async () => {
		const session = sessionWith(
			[report("first@example.com", [limit("api", "anthropic:7d"), limit("v1", "anthropic:7d")])],
			"first@example.com",
		);

		const { reports } = await buildRpcUsageResult(session);

		expect(reports[0]?.limits.map(row => row.id)).toEqual(["api"]);
	});

	test("keeps limits of distinct quotas separate", async () => {
		const session = sessionWith(
			[report("first@example.com", [limit("weekly", "anthropic:7d"), limit("opus", "anthropic:7d:opus")])],
			"first@example.com",
		);

		const { reports } = await buildRpcUsageResult(session);

		expect(reports[0]?.limits.map(row => row.id)).toEqual(["weekly", "opus"]);
	});
});
