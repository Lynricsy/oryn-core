import { describe, expect, it } from "bun:test";
import type { ExtToRelayMessage, TabSnapshot } from "../../coding-agent/src/tools/browser/relay/protocol";
import { CloudPolicyEngine, registrableDomain } from "./policy";

function makeTab(tabId: number, url: string, title = `Tab ${tabId}`): TabSnapshot {
	return {
		tabId,
		url,
		title,
		active: false,
		discarded: false,
		windowId: 1,
		pinned: false,
		groupId: -1,
	};
}

describe("CloudPolicyEngine (M27 Rev 1)", () => {
	it("彻底过滤未共享的现有标签页元数据并剥离 downloadsProtocol", () => {
		const engine = new CloudPolicyEngine();
		const shared = makeTab(10, "https://app.example.com/dashboard", "Dashboard");
		const secret = makeTab(20, "https://bank.secret.com/account", "Bank");
		engine.shareTab("thr_1", shared);

		const fullHello: Extract<ExtToRelayMessage, { t: "hello" }> = {
			t: "hello",
			userAgent: "Chrome/136",
			browserVersion: "Chrome/136.0.0.0",
			tabs: [shared, secret],
			attachedTabIds: [10, 20],
			downloadsProtocol: 1,
		};
		const filtered = engine.filterHello("thr_1", fullHello);
		expect(filtered.tabs).toEqual([shared]);
		expect(filtered.attachedTabIds).toEqual([10]);
		expect(filtered.downloadsProtocol).toBeUndefined();

		expect(engine.filterTabEvent("thr_1", { t: "tabUpdated", tab: secret })).toBeNull();
		expect(engine.filterTabEvent("thr_1", { t: "tabCreated", tab: secret })).toBeNull();
		expect(engine.filterTabEvent("thr_1", { t: "tabRemoved", tabId: 20 })).toBeNull();
		expect(engine.filterTabEvent("thr_1", { t: "tabUpdated", tab: shared })).not.toBeNull();
	});

	it("对未共享 tabId 发起的所有 RPC 一律拒绝", () => {
		const engine = new CloudPolicyEngine();
		engine.shareTab("thr_1", makeTab(10, "https://example.com"));

		for (const rpc of [
			{ op: "attach" as const, tabId: 99 },
			{ op: "send" as const, tabId: 99, method: "Runtime.evaluate", params: { expression: "1+1" } },
			{ op: "removeTab" as const, tabId: 99 },
			{ op: "activateTab" as const, tabId: 99 },
			{ op: "group" as const, tabIds: [10, 99], title: "omp", color: "cyan" },
		]) {
			const res = engine.authorizeRpc("thr_1", rpc, 1000);
			expect(res.kind).toBe("deny");
		}
	});

	it("createTab 默认立即返回 ORYN_APPROVAL_REQUIRED；第 30s 批准后单次票据支持重试且只消费一次", () => {
		const engine = new CloudPolicyEngine();
		const t0 = 1_000_000;
		const req = { op: "createTab" as const, url: "https://any-domain.org/page", active: false };

		// 第 0s：不阻塞，立刻返回需要审批
		const first = engine.authorizeRpc("thr_1", req, t0);
		expect(first.kind).toBe("require_approval");
		if (first.kind !== "require_approval") throw new Error("expected require_approval");
		expect(first.errorMessage).toContain(`ORYN_APPROVAL_REQUIRED(${first.approval.id})`);

		// 第 30s（跨过 bridge.ts 20s 超时窗）：用户点允许一次，只写票据不回放旧 RPC
		const t30 = t0 + 30_000;
		const resolved = engine.resolveApproval("thr_1", first.approval.id, "approved_once", t30);
		expect(resolved?.decision).toBe("approved_once");
		expect(engine.getSummary("thr_1", t30).pendingApprovals).toHaveLength(0);

		// 第 31s：agent 重试同一 createTab → 命中单次放行票据并消费
		const retry = engine.authorizeRpc("thr_1", req, t30 + 1000);
		expect(retry.kind).toBe("allow");

		// 再次调用同一 createTab → 单次票据已消费，重新要求审批
		const third = engine.authorizeRpc("thr_1", req, t30 + 2000);
		expect(third.kind).toBe("require_approval");
	});

	it("approve_session 后本会话新建 Tab 均直接放行，且新建 Tab 跨域名导航不受限", () => {
		const engine = new CloudPolicyEngine();
		const r1 = engine.authorizeRpc("thr_1", { op: "createTab", url: "https://a.example.com" }, 1000);
		expect(r1.kind).toBe("require_approval");
		if (r1.kind !== "require_approval") throw new Error("expected require_approval");

		engine.resolveApproval("thr_1", r1.approval.id, "approved_session", 2000);
		expect(engine.authorizeRpc("thr_1", { op: "createTab", url: "https://totally-other.dev" }, 3000).kind).toBe("allow");

		// 新建 Tab 加入集合后，任意跨域名 Page.navigate 直接放行
		engine.registerCreatedTab("thr_1", makeTab(55, "https://totally-other.dev"));
		const nav = engine.authorizeRpc(
			"thr_1",
			{ op: "send", tabId: 55, method: "Page.navigate", params: { url: "https://another.net/login" } },
			4000,
		);
		expect(nav.kind).toBe("allow");
	});

	it("共享现有 Tab 跨主域名导航、敏感凭据 CDP、Target/Browser CDP 与 file:// 走非阻塞审批；chrome:// 与 findDownload 硬拒绝", () => {
		const engine = new CloudPolicyEngine();
		engine.shareTab("thr_1", makeTab(10, "https://app.example.com/home"));

		// 同主域名子域跳转直接放行
		expect(
			engine.authorizeRpc(
				"thr_1",
				{ op: "send", tabId: 10, method: "Page.navigate", params: { url: "https://auth.example.com/sso" } },
				1000,
			).kind,
		).toBe("allow");

		// 跨主域名跳转需审批
		const cross = engine.authorizeRpc(
			"thr_1",
			{ op: "send", tabId: 10, method: "Page.navigate", params: { url: "https://evil-or-other.com/" } },
			1000,
		);
		expect(cross.kind).toBe("require_approval");

		// 凭据读取与跨目标 CDP 需审批
		expect(engine.authorizeRpc("thr_1", { op: "send", tabId: 10, method: "Storage.getCookies" }, 1000).kind).toBe(
			"require_approval",
		);
		expect(
			engine.authorizeRpc("thr_1", { op: "send", tabId: 10, method: "Network.requestWillBeSentExtraInfo" }, 1000).kind,
		).toBe("require_approval");
		expect(engine.authorizeRpc("thr_1", { op: "send", tabId: 10, method: "Target.createTarget" }, 1000).kind).toBe(
			"require_approval",
		);
		expect(engine.authorizeRpc("thr_1", { op: "createTab", url: "file:///etc/hosts" }, 1000).kind).toBe(
			"require_approval",
		);

		// chrome:// 与 findDownload 硬拒绝
		expect(engine.authorizeRpc("thr_1", { op: "createTab", url: "chrome://settings" }, 1000).kind).toBe("deny");
		expect(engine.authorizeRpc("thr_1", { op: "findDownload", guid: "g1" }, 1000).kind).toBe("deny");
	});

	it("clearSession 立即清空共享集合、待审批项与未消费票据", () => {
		const engine = new CloudPolicyEngine();
		engine.shareTab("thr_1", makeTab(10, "https://example.com"));
		const r = engine.authorizeRpc("thr_1", { op: "createTab", url: "https://example.com/new" }, 1000);
		if (r.kind === "require_approval") {
			engine.resolveApproval("thr_1", r.approval.id, "approved_once", 1500);
		}
		const detached = engine.clearSession("thr_1");
		expect(detached).toEqual([10]);
		expect(engine.authorizeRpc("thr_1", { op: "attach", tabId: 10 }, 2000).kind).toBe("deny");
		expect(engine.authorizeRpc("thr_1", { op: "createTab", url: "https://example.com/new" }, 2000).kind).toBe(
			"require_approval",
		);
	});

	it("registrableDomain 正确识别常规与二级公共后缀域名", () => {
		expect(registrableDomain("https://sub.app.example.com/path")).toBe("example.com");
		expect(registrableDomain("https://a.b.example.com.cn/path")).toBe("example.com.cn");
		expect(registrableDomain("http://localhost:3000/test")).toBe("localhost");
	});
});
