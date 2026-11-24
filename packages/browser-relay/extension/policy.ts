/**
 * Oryn 云端模式本机安全策略引擎（M27 Rev 1）。
 *
 * 纯状态机设计（不直接依赖 chrome.*），负责在本机侧执行全部安全裁决：
 * 1. 未被用户点选共享的现有标签页，其元数据（hello / tabCreated / tabUpdated / tabRemoved）绝不发往云端；
 * 2. 针对未在授权集合内 tabId 的任意操作一律拒绝；
 * 3. 新建标签页（createTab）不做域名白名单限制，但默认走【非阻塞两阶段审批】：
 *    因 bridge.ts RPC_TIMEOUT_MS = 20_000 且 createTab 注册了 onLateResult 关页回调，
 *    绝不挂起 RPC 等待人类点击，而是立即返回 ORYN_APPROVAL_REQUIRED 结束原 RPC；
 *    用户任意时间批准后仅写入本机放行票据（oneTimeGrants）或会话白名单，绝不事后执行过期旧 RPC，
 *    待通知线程由 agent 发起新一次重试时命中放行；
 * 4. 高危 CDP（凭据读取/嗅探、Target.* / Browser.* / SystemInfo.*）、file:// 以及已共享现有 Tab
 *    跨主域名导航同样走非阻塞两阶段审批；远端 reload 静默丢弃、findDownload 与浏览器内置页直接拒绝。
 */
import type {
	ExtToRelayMessage,
	RelayRpcRequest,
	TabSnapshot,
} from "../../coding-agent/src/tools/browser/relay/protocol";

export type ApprovalCategory =
	| "create_tab"
	| "file_url"
	| "cross_origin_nav"
	| "sensitive_cdp"
	| "browser_target_cdp";

export type ApprovalDecision = "approved_once" | "approved_session" | "denied";

export interface SharedTabRecord {
	tabId: number;
	source: "shared" | "created";
	initialHost: string;
	url: string;
	title: string;
}

export interface PendingApproval {
	id: string;
	threadId: string;
	category: ApprovalCategory;
	fingerprint: string;
	summary: string;
	url?: string;
	tabId?: number;
	method?: string;
	createdAt: number;
	expiresAt: number;
}

export interface SessionPolicySummary {
	threadId: string;
	sharedTabs: SharedTabRecord[];
	pendingApprovals: PendingApproval[];
	autoApproveCreateTab: boolean;
	autoApproveCategories: ApprovalCategory[];
}

export type RpcAuthDecision =
	| { kind: "allow" }
	| { kind: "deny"; reason: string }
	| { kind: "require_approval"; approval: PendingApproval; errorMessage: string };

interface OneTimeGrant {
	expiresAt: number;
}

interface ThreadSessionPolicy {
	threadId: string;
	sharedTabs: Map<number, SharedTabRecord>;
	autoApproveCreateTab: boolean;
	autoApproveCategories: Set<ApprovalCategory>;
	oneTimeGrants: Map<string, OneTimeGrant>;
	pendingApprovals: Map<string, PendingApproval>;
}

export const APPROVAL_TTL_MS = 5 * 60_000;
export const ONE_TIME_GRANT_TTL_MS = 5 * 60_000;

const BLOCKED_SCHEME_RE = /^(chrome|chrome-extension|devtools|edge|view-source|chrome-untrusted|chrome-search):/i;
const SENSITIVE_CDP_METHODS = new Set([
	"Storage.getCookies",
	"Network.getAllCookies",
	"Network.getCookies",
	"Network.requestWillBeSentExtraInfo",
	"Network.responseReceivedExtraInfo",
]);

function isBlockedUrl(raw: string): boolean {
	const u = raw.trim();
	if (!u) return false;
	if (BLOCKED_SCHEME_RE.test(u)) return true;
	if (/^about:/i.test(u) && u.toLowerCase() !== "about:blank") return true;
	return false;
}

function isFileUrl(raw: string): boolean {
	return /^file:/i.test(raw.trim());
}

function parseHostname(raw: string): string {
	try {
		return new URL(raw).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/**
 * 提取主域名（近似 eTLD+1）：同主域名内的子域跳转（如 app.example.com ↔ auth.example.com）视为同站；
 * 常见双段公共后缀（co.uk / com.cn / com.hk / com.tw / com.au / co.jp / org.cn / gov.cn）保留三段。
 */
export function registrableDomain(rawUrl: string): string {
	const host = parseHostname(rawUrl);
	if (!host) return "";
	if (host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
		return host;
	}
	const parts = host.split(".").filter(Boolean);
	if (parts.length <= 2) return host;
	const lastTwo = parts.slice(-2).join(".");
	const secondLevelPublic = new Set(["co.uk", "com.cn", "org.cn", "gov.cn", "net.cn", "com.hk", "com.tw", "com.au", "co.jp"]);
	if (secondLevelPublic.has(lastTwo) && parts.length >= 3) {
		return parts.slice(-3).join(".");
	}
	return lastTwo;
}

function normalizeUrlForFingerprint(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "about:blank";
	try {
		const u = new URL(trimmed);
		u.hash = "";
		return u.toString();
	} catch {
		return trimmed;
	}
}

export class CloudPolicyEngine {
	#sessions = new Map<string, ThreadSessionPolicy>();
	#seq = 0;

	#ensure(threadId: string): ThreadSessionPolicy {
		let s = this.#sessions.get(threadId);
		if (!s) {
			s = {
				threadId,
				sharedTabs: new Map(),
				autoApproveCreateTab: false,
				autoApproveCategories: new Set(),
				oneTimeGrants: new Map(),
				pendingApprovals: new Map(),
			};
			this.#sessions.set(threadId, s);
		}
		return s;
	}

	#pruneExpired(s: ThreadSessionPolicy, now: number): void {
		for (const [fp, g] of s.oneTimeGrants) {
			if (g.expiresAt <= now) s.oneTimeGrants.delete(fp);
		}
		for (const [id, p] of s.pendingApprovals) {
			if (p.expiresAt <= now) s.pendingApprovals.delete(id);
		}
	}

	/** 用户主动点选共享一个现有标签页。 */
	shareTab(threadId: string, snap: TabSnapshot): SharedTabRecord {
		const s = this.#ensure(threadId);
		const rec: SharedTabRecord = {
			tabId: snap.tabId,
			source: "shared",
			initialHost: registrableDomain(snap.url),
			url: snap.url,
			title: snap.title,
		};
		s.sharedTabs.set(snap.tabId, rec);
		return rec;
	}

	/** 记录由本会话获批 createTab 新建的标签页（不限制后续导航域名）。 */
	registerCreatedTab(threadId: string, snap: TabSnapshot): SharedTabRecord {
		const s = this.#ensure(threadId);
		const rec: SharedTabRecord = {
			tabId: snap.tabId,
			source: "created",
			initialHost: registrableDomain(snap.url),
			url: snap.url,
			title: snap.title,
		};
		s.sharedTabs.set(snap.tabId, rec);
		return rec;
	}

	/** 用户取消共享（或标签页被关闭）时移出授权集合。 */
	unshareTab(threadId: string, tabId: number): boolean {
		const s = this.#sessions.get(threadId);
		if (!s) return false;
		return s.sharedTabs.delete(tabId);
	}

	/** 同步标签页最新标题/URL（仅对已授权标签页生效）。 */
	updateKnownTab(threadId: string, snap: TabSnapshot): boolean {
		const s = this.#sessions.get(threadId);
		const rec = s?.sharedTabs.get(snap.tabId);
		if (!rec) return false;
		rec.url = snap.url;
		rec.title = snap.title;
		if (!rec.initialHost && snap.url) {
			rec.initialHost = registrableDomain(snap.url);
		}
		return true;
	}

	/** 列出共享了某个 tabId 的所有会话（标签关闭/取消时清理）。 */
	sessionsHoldingTab(tabId: number): string[] {
		const out: string[] = [];
		for (const [tid, s] of this.#sessions) {
			if (s.sharedTabs.has(tabId)) out.push(tid);
		}
		return out;
	}

	/** 清理某线程的全部授权状态、待审批与一次性放行票据，返回需立即 detach 的 tabId 列表。 */
	clearSession(threadId: string): number[] {
		const s = this.#sessions.get(threadId);
		if (!s) return [];
		const tabs = [...s.sharedTabs.keys()];
		this.#sessions.delete(threadId);
		return tabs;
	}

	/** 清空全部会话（一键熔断/断开），返回全部需 detach 的 tabId（去重）。 */
	clearAll(): number[] {
		const all = new Set<number>();
		for (const s of this.#sessions.values()) {
			for (const id of s.sharedTabs.keys()) all.add(id);
		}
		this.#sessions.clear();
		return [...all];
	}

	/** 过滤 hello 消息：只暴露本会话授权集合中的标签页，且剥离 downloadsProtocol 防止暴露本机路径。 */
	filterHello(
		threadId: string,
		fullHello: Extract<ExtToRelayMessage, { t: "hello" }>,
	): Extract<ExtToRelayMessage, { t: "hello" }> {
		const s = this.#sessions.get(threadId);
		if (!s || s.sharedTabs.size === 0) {
			return {
				...fullHello,
				downloadsProtocol: undefined,
				tabs: [],
				attachedTabIds: [],
			};
		}
		const tabs = fullHello.tabs.filter(tab => s.sharedTabs.has(tab.tabId));
		const attachedTabIds = fullHello.attachedTabIds.filter(id => s.sharedTabs.has(id));
		return {
			...fullHello,
			downloadsProtocol: undefined,
			tabs,
			attachedTabIds,
		};
	}

	/** 过滤标签页生命周期事件：未在授权集合中的普通标签页绝不向云端上报。 */
	filterTabEvent(
		threadId: string,
		ev: Extract<ExtToRelayMessage, { t: "tabCreated" | "tabUpdated" | "tabRemoved" }>,
	): Extract<ExtToRelayMessage, { t: "tabCreated" | "tabUpdated" | "tabRemoved" }> | null {
		const s = this.#sessions.get(threadId);
		if (!s) return null;
		const tabId = ev.t === "tabRemoved" ? ev.tabId : ev.tab.tabId;
		if (!s.sharedTabs.has(tabId)) return null;
		if (ev.t !== "tabRemoved") {
			this.updateKnownTab(threadId, ev.tab);
		}
		return ev;
	}

	/**
	 * 对一条来自远端 orb 的 RPC 做纯同步安全裁决（绝不挂起等待用户点击）。
	 */
	authorizeRpc(threadId: string, rpc: RelayRpcRequest, now = Date.now()): RpcAuthDecision {
		const s = this.#ensure(threadId);
		this.#pruneExpired(s, now);

		if (rpc.op === "findDownload") {
			return { kind: "deny", reason: "Oryn cloud relay disables findDownload to avoid exposing local file paths." };
		}

		if (rpc.op === "createTab") {
			const url = rpc.url ?? "";
			if (isBlockedUrl(url)) {
				return { kind: "deny", reason: `Blocked internal browser URL: ${url}` };
			}
			const isFile = isFileUrl(url);
			const category: ApprovalCategory = isFile ? "file_url" : "create_tab";
			const fp = `${category}:${normalizeUrlForFingerprint(url)}`;
			if (!isFile && s.autoApproveCreateTab) return { kind: "allow" };
			if (isFile && s.autoApproveCategories.has("file_url")) return { kind: "allow" };
			if (this.#consumeOneTimeGrant(s, fp, now)) return { kind: "allow" };

			const summary = isFile
				? `打开本地文件页面 ${url}`
				: `新建标签页 ${url || "about:blank"}`;
			return this.#requireApproval(s, { category, fingerprint: fp, summary, url }, now);
		}

		if (rpc.op === "group" || rpc.op === "ungroup") {
			for (const id of rpc.tabIds) {
				if (!s.sharedTabs.has(id)) {
					return { kind: "deny", reason: `Tab ${id} is not shared with this Oryn thread.` };
				}
			}
			return { kind: "allow" };
		}

		// attach / detach / send / removeTab / activateTab 均必须针对已授权 tabId
		const tabRec = s.sharedTabs.get(rpc.tabId);
		if (!tabRec) {
			return {
				kind: "deny",
				reason: `Tab ${rpc.tabId} is not shared with this Oryn thread. Ask the user to share it in the Chrome extension popup.`,
			};
		}

		if (rpc.op !== "send") {
			return { kind: "allow" };
		}

		const method = rpc.method;
		// 1. 跨目标 / 浏览器级 CDP
		if (method.startsWith("Target.") || method.startsWith("Browser.") || method.startsWith("SystemInfo.")) {
			const category: ApprovalCategory = "browser_target_cdp";
			const fp = `${category}:${rpc.tabId}:${method}`;
			if (s.autoApproveCategories.has(category) || this.#consumeOneTimeGrant(s, fp, now)) {
				return { kind: "allow" };
			}
			return this.#requireApproval(
				s,
				{ category, fingerprint: fp, summary: `执行浏览器级 CDP 命令 ${method}`, tabId: rpc.tabId, method },
				now,
			);
		}

		// 2. 凭据批量读取 / 嗅探类 CDP
		if (SENSITIVE_CDP_METHODS.has(method)) {
			const category: ApprovalCategory = "sensitive_cdp";
			const fp = `${category}:${rpc.tabId}:${method}`;
			if (s.autoApproveCategories.has(category) || this.#consumeOneTimeGrant(s, fp, now)) {
				return { kind: "allow" };
			}
			return this.#requireApproval(
				s,
				{ category, fingerprint: fp, summary: `读取标签页凭据/请求头（${method}）`, tabId: rpc.tabId, method },
				now,
			);
		}

		// 3. Page.navigate URL 边界检查
		if (method === "Page.navigate") {
			const targetUrl = typeof rpc.params?.url === "string" ? rpc.params.url : "";
			if (isBlockedUrl(targetUrl)) {
				return { kind: "deny", reason: `Blocked internal browser URL: ${targetUrl}` };
			}
			if (isFileUrl(targetUrl)) {
				const category: ApprovalCategory = "file_url";
				const fp = `${category}:${rpc.tabId}:${normalizeUrlForFingerprint(targetUrl)}`;
				if (s.autoApproveCategories.has(category) || this.#consumeOneTimeGrant(s, fp, now)) {
					return { kind: "allow" };
				}
				return this.#requireApproval(
					s,
					{ category, fingerprint: fp, summary: `导航到本地文件 ${targetUrl}`, tabId: rpc.tabId, url: targetUrl, method },
					now,
				);
			}
			// 仅对用户共享的现有 Tab 检查是否跳离初始主域名；新建 Tab（source === "created"）不限导航域名
			if (tabRec.source === "shared" && targetUrl) {
				const nextDomain = registrableDomain(targetUrl);
				if (tabRec.initialHost && nextDomain && nextDomain !== tabRec.initialHost) {
					const category: ApprovalCategory = "cross_origin_nav";
					const fp = `${category}:${rpc.tabId}:${nextDomain}`;
					if (s.autoApproveCategories.has(category) || this.#consumeOneTimeGrant(s, fp, now)) {
						return { kind: "allow" };
					}
					return this.#requireApproval(
						s,
						{
							category,
							fingerprint: fp,
							summary: `共享标签页跨站跳转到 ${nextDomain}（原域名 ${tabRec.initialHost}）`,
							tabId: rpc.tabId,
							url: targetUrl,
							method,
						},
						now,
					);
				}
			}
		}

		return { kind: "allow" };
	}

	/**
	 * 处理用户在 Popup 点选的审批决议。
	 * 重要：绝不事后执行已过期的旧 RPC，只更新本机放行票据/会话白名单并返回决议摘要供通知线程重试。
	 */
	resolveApproval(
		threadId: string,
		approvalId: string,
		decision: ApprovalDecision,
		now = Date.now(),
	): { approval: PendingApproval; decision: ApprovalDecision } | null {
		const s = this.#sessions.get(threadId);
		if (!s) return null;
		this.#pruneExpired(s, now);
		const approval = s.pendingApprovals.get(approvalId);
		if (!approval) return null;
		s.pendingApprovals.delete(approvalId);

		if (decision === "approved_once") {
			s.oneTimeGrants.set(approval.fingerprint, { expiresAt: now + ONE_TIME_GRANT_TTL_MS });
		} else if (decision === "approved_session") {
			if (approval.category === "create_tab") {
				s.autoApproveCreateTab = true;
			} else {
				s.autoApproveCategories.add(approval.category);
			}
			// 同类别待审批项一并清理
			for (const [id, p] of s.pendingApprovals) {
				if (p.category === approval.category) s.pendingApprovals.delete(id);
			}
		}
		return { approval, decision };
	}

	setAutoApproveCreateTab(threadId: string, enabled: boolean): void {
		const s = this.#ensure(threadId);
		s.autoApproveCreateTab = enabled;
	}

	getSummary(threadId: string, now = Date.now()): SessionPolicySummary {
		const s = this.#sessions.get(threadId);
		if (!s) {
			return {
				threadId,
				sharedTabs: [],
				pendingApprovals: [],
				autoApproveCreateTab: false,
				autoApproveCategories: [],
			};
		}
		this.#pruneExpired(s, now);
		return {
			threadId,
			sharedTabs: [...s.sharedTabs.values()],
			pendingApprovals: [...s.pendingApprovals.values()],
			autoApproveCreateTab: s.autoApproveCreateTab,
			autoApproveCategories: [...s.autoApproveCategories],
		};
	}

	totalPendingApprovals(now = Date.now()): number {
		let total = 0;
		for (const s of this.#sessions.values()) {
			this.#pruneExpired(s, now);
			total += s.pendingApprovals.size;
		}
		return total;
	}

	#consumeOneTimeGrant(s: ThreadSessionPolicy, fingerprint: string, now: number): boolean {
		const grant = s.oneTimeGrants.get(fingerprint);
		if (!grant) return false;
		s.oneTimeGrants.delete(fingerprint);
		return grant.expiresAt > now;
	}

	#requireApproval(
		s: ThreadSessionPolicy,
		req: { category: ApprovalCategory; fingerprint: string; summary: string; url?: string; tabId?: number; method?: string },
		now: number,
	): RpcAuthDecision {
		// 同指纹幂等复用，避免短时间内重复刷出多张审批卡
		let existing: PendingApproval | undefined;
		for (const p of s.pendingApprovals.values()) {
			if (p.fingerprint === req.fingerprint) {
				existing = p;
				break;
			}
		}
		const approval: PendingApproval = existing ?? {
			id: `apr_${++this.#seq}_${now}`,
			threadId: s.threadId,
			category: req.category,
			fingerprint: req.fingerprint,
			summary: req.summary,
			url: req.url,
			tabId: req.tabId,
			method: req.method,
			createdAt: now,
			expiresAt: now + APPROVAL_TTL_MS,
		};
		if (!existing) {
			s.pendingApprovals.set(approval.id, approval);
		}
		return {
			kind: "require_approval",
			approval,
			errorMessage: `ORYN_APPROVAL_REQUIRED(${approval.id}): 等待用户在 Chrome 扩展中确认授权（${approval.summary}）。请暂停重复调用，等用户批准后再重试同一操作。`,
		};
	}
}
