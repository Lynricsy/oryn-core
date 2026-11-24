/**
 * Oryn 云端模式客户端（M27 Rev 1）。
 *
 * 职责：
 * 1. 配对管理（复用 Oryn 现有 POST /api/v1/devices/pair/start|poll，kind = "browser_extension"）；
 * 2. 持设备令牌换一次性 POST /api/v1/ws-ticket，直连 /api/v1/browser-relay/ws；
 * 3. 单连接承载多个线程会话，所有来自远端的 RPC 强制经 CloudPolicyEngine 裁决：
 *    - 远端 reload 静默丢弃；
 *    - 需要审批的动作立即返回 ORYN_APPROVAL_REQUIRED 并通知用户（绝不挂起超过 bridge.ts 20s 超时）；
 *    - 用户批准后仅更新本机放行票据并发 session.approval_resolved 通知线程重试，绝不事后执行过期旧 RPC。
 */
import type {
	ExtToRelayMessage,
	RelayRpcRequest,
	RelayToExtMessage,
	TabSnapshot,
} from "../../coding-agent/src/tools/browser/relay/protocol";
import {
	type ApprovalDecision,
	CloudPolicyEngine,
	type PendingApproval,
	type SessionPolicySummary,
} from "./policy";

export type ExtensionMode = "local" | "oryn";

export interface OrynCloudConfig {
	mode: ExtensionMode;
	orynServerUrl: string;
	orynDeviceToken: string;
	orynDeviceId: string;
	orynDeviceName: string;
}

export interface ThreadSummary {
	threadId: string;
	title: string;
	projectName?: string;
	state: string;
}

export interface PairingState {
	serverUrl: string;
	code: string;
	verifier: string;
	verifyUrl: string;
	expiresAt: number;
}

export interface CloudPopupSnapshot {
	mode: ExtensionMode;
	serverUrl: string;
	paired: boolean;
	deviceId: string;
	deviceName: string;
	connected: boolean;
	lastError: string;
	pairing: PairingState | null;
	threads: ThreadSummary[];
	activeThreadIds: string[];
	sessions: Record<string, SessionPolicySummary>;
	pendingApprovals: PendingApproval[];
}

export interface CloudHostBridge {
	buildFullHello(): Promise<Extract<ExtToRelayMessage, { t: "hello" }>>;
	executeRpc(rpc: RelayRpcRequest): Promise<unknown>;
	detachAndUngroup(tabId: number): Promise<void>;
	snapshotTab(tabId: number): Promise<TabSnapshot | null>;
	setBadge(text: string, color: string): Promise<void>;
}

const CLOUD_PING_MS = 20_000;
const RECONNECT_MIN_MS = 1_500;
const RECONNECT_MAX_MS = 15_000;
const CLOSE_REVOKED = 4401;
const NOTIFICATION_ICON =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2S8AAAAASUVORK5CYII=";

export function normalizeServerUrl(raw: string): string {
	const trimmed = raw.trim().replace(/\/+$/, "");
	if (!trimmed) return "";
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(trimmed)) return `http://${trimmed}`;
	return `https://${trimmed}`;
}

function toWebSocketUrl(baseHttpUrl: string, pathWithQuery: string): string {
	const u = new URL(pathWithQuery, `${baseHttpUrl}/`);
	u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
	return u.toString();
}

export async function loadCloudConfig(): Promise<OrynCloudConfig> {
	const stored = await chrome.storage.local.get({
		mode: "local",
		orynServerUrl: "",
		orynDeviceToken: "",
		orynDeviceId: "",
		orynDeviceName: "",
	});
	return {
		mode: stored.mode === "oryn" ? "oryn" : "local",
		orynServerUrl: typeof stored.orynServerUrl === "string" ? stored.orynServerUrl : "",
		orynDeviceToken: typeof stored.orynDeviceToken === "string" ? stored.orynDeviceToken : "",
		orynDeviceId: typeof stored.orynDeviceId === "string" ? stored.orynDeviceId : "",
		orynDeviceName: typeof stored.orynDeviceName === "string" ? stored.orynDeviceName : "",
	};
}

interface CloudServerMessage {
	t: string;
	deviceId?: string;
	deviceName?: string;
	threads?: ThreadSummary[];
	threadId?: string;
	threadTitle?: string;
	projectName?: string;
	reason?: string;
	payload?: RelayToExtMessage;
}

export class OrynCloudClient {
	readonly policy = new CloudPolicyEngine();
	#host: CloudHostBridge;
	#ws: WebSocket | null = null;
	#pingTimer: NodeJS.Timeout | null = null;
	#reconnectTimer: NodeJS.Timeout | null = null;
	#reconnectDelay = RECONNECT_MIN_MS;
	#stopped = true;
	#connected = false;
	#lastError = "";
	#config: OrynCloudConfig = {
		mode: "local",
		orynServerUrl: "",
		orynDeviceToken: "",
		orynDeviceId: "",
		orynDeviceName: "",
	};
	#pairing: PairingState | null = null;
	#threads: ThreadSummary[] = [];
	#openSessions = new Map<string, { threadTitle: string; projectName: string }>();

	constructor(host: CloudHostBridge) {
		this.#host = host;
	}

	get active(): boolean {
		return !this.#stopped && this.#config.mode === "oryn";
	}

	async syncConfig(): Promise<void> {
		this.#config = await loadCloudConfig();
	}

	async start(): Promise<void> {
		this.#config = await loadCloudConfig();
		if (this.#config.mode !== "oryn") {
			await this.stop();
			return;
		}
		this.#stopped = false;
		await this.connect();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		this.#clearTimers();
		if (this.#ws) {
			const old = this.#ws;
			this.#ws = null;
			old.close();
		}
		this.#connected = false;
		const tabIds = this.policy.clearAll();
		this.#openSessions.clear();
		await Promise.all(tabIds.map(id => this.#host.detachAndUngroup(id).catch(() => {})));
		await this.#refreshBadge();
	}

	async connect(): Promise<void> {
		if (this.#stopped || this.#config.mode !== "oryn") return;
		if (this.#ws && (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING)) return;
		const base = normalizeServerUrl(this.#config.orynServerUrl);
		const token = this.#config.orynDeviceToken.trim();
		if (!base || !token) {
			this.#connected = false;
			await this.#refreshBadge();
			return;
		}
		try {
			const ticketResp = await fetch(`${base}/api/v1/ws-ticket`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
			});
			if (ticketResp.status === 401 || ticketResp.status === 403) {
				await this.#handleRevoked("设备令牌已失效或被吊销，请重新配对");
				return;
			}
			if (!ticketResp.ok) {
				throw new Error(`ws-ticket HTTP ${ticketResp.status}`);
			}
			const { ticket } = (await ticketResp.json()) as { ticket?: string };
			if (!ticket) throw new Error("empty ws-ticket");

			const wsUrl = toWebSocketUrl(base, `/api/v1/browser-relay/ws?ticket=${encodeURIComponent(ticket)}`);
			const socket = new WebSocket(wsUrl);
			this.#ws = socket;

			socket.onopen = () => {
				if (this.#ws !== socket) return;
				this.#reconnectDelay = RECONNECT_MIN_MS;
				this.#connected = true;
				this.#lastError = "";
				void this.#sendRegister();
				void this.#refreshBadge();
				clearInterval(this.#pingTimer ?? undefined);
				this.#pingTimer = setInterval(() => this.#send({ t: "ping" }), CLOUD_PING_MS);
			};

			socket.onmessage = ev => {
				if (this.#ws !== socket || typeof ev.data !== "string") return;
				void this.#handleServerMessage(ev.data);
			};

			socket.onclose = ev => {
				if (this.#ws !== socket) return;
				this.#ws = null;
				this.#connected = false;
				clearInterval(this.#pingTimer ?? undefined);
				this.#pingTimer = null;
				if (ev.code === CLOSE_REVOKED) {
					void this.#handleRevoked("设备已被吊销，请重新配对");
					return;
				}
				void this.#refreshBadge();
				if (!this.#stopped) this.#scheduleReconnect();
			};

			socket.onerror = () => {
				this.#lastError = "无法连接到 Oryn 服务器";
				socket.close();
			};
		} catch (err) {
			this.#connected = false;
			this.#lastError = err instanceof Error ? err.message : String(err);
			await this.#refreshBadge();
			if (!this.#stopped) this.#scheduleReconnect();
		}
	}

	async startPairing(rawServerUrl: string, deviceName?: string): Promise<PairingState> {
		const serverUrl = normalizeServerUrl(rawServerUrl);
		if (!serverUrl) throw new Error("请输入有效的 Oryn 服务器地址");
		const name = deviceName?.trim() || "Chrome Extension";
		const resp = await fetch(`${serverUrl}/api/v1/devices/pair/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, kind: "browser_extension", platform: "chrome" }),
		});
		if (!resp.ok) {
			throw new Error(`配对请求失败（HTTP ${resp.status}）`);
		}
		const data = (await resp.json()) as {
			code: string;
			verifier: string;
			verifyUrl: string;
			expiresAt: number;
		};
		this.#pairing = {
			serverUrl,
			code: data.code,
			verifier: data.verifier,
			verifyUrl: data.verifyUrl,
			expiresAt: data.expiresAt,
		};
		await chrome.storage.local.set({ mode: "oryn", orynServerUrl: serverUrl });
		this.#config = await loadCloudConfig();
		if (data.verifyUrl) {
			await chrome.tabs.create({ url: data.verifyUrl, active: true }).catch(() => {});
		}
		return this.#pairing;
	}

	async pollPairingOnce(): Promise<{ approved: boolean; expired?: boolean }> {
		if (!this.#pairing) return { approved: false };
		const p = this.#pairing;
		if (Date.now() >= p.expiresAt) {
			this.#pairing = null;
			return { approved: false, expired: true };
		}
		const resp = await fetch(`${p.serverUrl}/api/v1/devices/pair/poll`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code: p.code, verifier: p.verifier }),
		});
		if (resp.status === 202) return { approved: false };
		if (resp.status === 404 || resp.status === 410) {
			this.#pairing = null;
			return { approved: false, expired: true };
		}
		if (!resp.ok) {
			throw new Error(`轮询配对失败（HTTP ${resp.status}）`);
		}
		const data = (await resp.json()) as {
			deviceToken: string;
			device: { id: string; name: string };
		};
		this.#pairing = null;
		await chrome.storage.local.set({
			mode: "oryn",
			orynServerUrl: p.serverUrl,
			orynDeviceToken: data.deviceToken,
			orynDeviceId: data.device.id,
			orynDeviceName: data.device.name,
		});
		this.#config = await loadCloudConfig();
		this.#stopped = false;
		await this.connect();
		return { approved: true };
	}

	async unpair(): Promise<void> {
		this.#pairing = null;
		await this.stop();
		await chrome.storage.local.set({
			orynDeviceToken: "",
			orynDeviceId: "",
			orynDeviceName: "",
		});
		this.#config = await loadCloudConfig();
		await this.#refreshBadge();
	}

	async bindThread(threadId: string): Promise<void> {
		this.#send({ t: "session.bind", threadId });
	}

	async unbindThread(threadId: string): Promise<void> {
		const tabs = this.policy.clearSession(threadId);
		this.#openSessions.delete(threadId);
		await Promise.all(tabs.map(id => this.#host.detachAndUngroup(id).catch(() => {})));
		this.#send({ t: "session.unbind", threadId });
		this.#sendSessionState(threadId);
		await this.#refreshBadge();
	}

	async shareTab(threadId: string, tabId: number): Promise<void> {
		const snap = await this.#host.snapshotTab(tabId);
		if (!snap) throw new Error("无法读取该标签页信息");
		this.policy.shareTab(threadId, snap);
		if (this.#openSessions.has(threadId)) {
			this.#sendFrame(threadId, { t: "tabCreated", tab: snap });
		}
		this.#sendSessionState(threadId);
		await this.#refreshBadge();
	}

	async unshareTab(threadId: string, tabId: number): Promise<void> {
		const removed = this.policy.unshareTab(threadId, tabId);
		if (!removed) return;
		await this.#host.detachAndUngroup(tabId).catch(() => {});
		if (this.#openSessions.has(threadId)) {
			this.#sendFrame(threadId, { t: "tabRemoved", tabId });
		}
		this.#sendSessionState(threadId);
		await this.#refreshBadge();
	}

	async resolveApproval(threadId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
		const res = this.policy.resolveApproval(threadId, approvalId, decision);
		if (!res) return;
		this.#send({
			t: "session.approval_resolved",
			threadId,
			approvalId,
			decision,
			summary: res.approval.summary,
		});
		this.#sendSessionState(threadId);
		await this.#refreshBadge();
	}

	async emergencyDisconnectAll(): Promise<void> {
		const openIds = [...this.#openSessions.keys()];
		const allTabs = this.policy.clearAll();
		this.#openSessions.clear();
		await Promise.all(allTabs.map(id => this.#host.detachAndUngroup(id).catch(() => {})));
		for (const tid of openIds) {
			this.#send({ t: "session.unbind", threadId: tid });
		}
		await this.#refreshBadge();
	}

	onTabEvent(ev: Extract<ExtToRelayMessage, { t: "tabCreated" | "tabUpdated" | "tabRemoved" }>): void {
		if (!this.active || !this.#connected) return;
		const tabId = ev.t === "tabRemoved" ? ev.tabId : ev.tab.tabId;
		for (const threadId of this.#openSessions.keys()) {
			const filtered = this.policy.filterTabEvent(threadId, ev);
			if (!filtered) continue;
			if (ev.t === "tabRemoved") {
				this.policy.unshareTab(threadId, tabId);
				this.#sendSessionState(threadId);
			}
			this.#sendFrame(threadId, filtered);
		}
	}

	onDebuggerEvent(ev: Extract<ExtToRelayMessage, { t: "cdpEvent" | "detached" | "framesHidden" }>): void {
		if (!this.active || !this.#connected) return;
		const holders = this.policy.sessionsHoldingTab(ev.tabId);
		for (const threadId of holders) {
			if (this.#openSessions.has(threadId)) {
				this.#sendFrame(threadId, ev);
			}
		}
	}

	requestThreadsRefresh(): void {
		if (this.#connected) this.#send({ t: "threads.list" });
	}

	getPopupSnapshot(): CloudPopupSnapshot {
		const sessions: Record<string, SessionPolicySummary> = {};
		const pendingApprovals: PendingApproval[] = [];
		for (const tid of this.#openSessions.keys()) {
			const sum = this.policy.getSummary(tid);
			sessions[tid] = sum;
			pendingApprovals.push(...sum.pendingApprovals);
		}
		return {
			mode: this.#config.mode,
			serverUrl: this.#config.orynServerUrl,
			paired: Boolean(this.#config.orynDeviceToken),
			deviceId: this.#config.orynDeviceId,
			deviceName: this.#config.orynDeviceName,
			connected: this.#connected,
			lastError: this.#lastError,
			pairing: this.#pairing,
			threads: this.#threads,
			activeThreadIds: [...this.#openSessions.keys()],
			sessions,
			pendingApprovals,
		};
	}

	async #sendRegister(): Promise<void> {
		const hello = await this.#host.buildFullHello();
		// register 绝不包含任何未共享 tabs
		this.#send({
			t: "register",
			instanceId: hello.instanceId ?? "",
			browserSession: hello.browserSession ?? "",
			browserVersion: hello.browserVersion,
			userAgent: hello.userAgent,
			extVersion: hello.ompVersion ?? "0.2.0",
		});
	}

	async #handleServerMessage(raw: string): Promise<void> {
		let msg: CloudServerMessage;
		try {
			msg = JSON.parse(raw) as CloudServerMessage;
		} catch {
			return;
		}
		switch (msg.t) {
			case "pong":
				return;
			case "registered":
				if (Array.isArray(msg.threads)) this.#threads = msg.threads;
				this.#notifyPopup();
				return;
			case "threads.update": {
				if (Array.isArray(msg.threads)) {
					const changed = JSON.stringify(this.#threads) !== JSON.stringify(msg.threads);
					this.#threads = msg.threads;
					if (changed) this.#notifyPopup();
				}
				return;
			}
			case "session.open": {
				if (!msg.threadId) return;
				this.#openSessions.set(msg.threadId, {
					threadTitle: msg.threadTitle ?? msg.threadId,
					projectName: msg.projectName ?? "",
				});
				const fullHello = await this.#host.buildFullHello();
				const filtered = this.policy.filterHello(msg.threadId, fullHello);
				this.#sendFrame(msg.threadId, filtered);
				this.#sendSessionState(msg.threadId);
				await this.#refreshBadge();
				this.#notifyPopup();
				return;
			}
			case "session.close": {
				if (!msg.threadId) return;
				this.#openSessions.delete(msg.threadId);
				if (msg.reason === "unbound" || msg.reason === "revoked" || msg.reason === "rebound") {
					const tabs = this.policy.clearSession(msg.threadId);
					await Promise.all(tabs.map(id => this.#host.detachAndUngroup(id).catch(() => {})));
				}
				await this.#refreshBadge();
				this.#notifyPopup();
				return;
			}
			case "session.frame": {
				if (!msg.threadId || !msg.payload) return;
				await this.#handleRelayPayload(msg.threadId, msg.payload);
				return;
			}
		}
	}

	async #handleRelayPayload(threadId: string, payload: RelayToExtMessage): Promise<void> {
		// 远端 reload 静默丢弃（禁止云端触发本机扩展重载）
		if (payload.t === "reload" || payload.t === "pong") return;

		const decision = this.policy.authorizeRpc(threadId, payload);
		if (decision.kind === "deny") {
			this.#sendFrame(threadId, { t: "rpcResult", id: payload.id, ok: false, error: decision.reason });
			return;
		}
		if (decision.kind === "require_approval") {
			// 非阻塞：立即回传明确待审批错误，绝不挂起超过 bridge.ts 20s 超时
			this.#sendFrame(threadId, { t: "rpcResult", id: payload.id, ok: false, error: decision.errorMessage });
			this.#sendSessionState(threadId);
			await this.#refreshBadge();
			this.#notifyPopup();
			await this.#notifyApproval(threadId, decision.approval);
			return;
		}
		try {
			const result = await this.#host.executeRpc(payload);
			if (payload.op === "createTab" && result && typeof result === "object" && "tab" in result) {
				const maybeTab = result.tab;
				if (maybeTab && typeof maybeTab === "object" && "tabId" in maybeTab && typeof maybeTab.tabId === "number") {
					this.policy.registerCreatedTab(threadId, maybeTab as TabSnapshot);
					this.#sendSessionState(threadId);
				}
			}
			this.#sendFrame(threadId, { t: "rpcResult", id: payload.id, ok: true, result });
		} catch (err) {
			this.#sendFrame(threadId, {
				t: "rpcResult",
				id: payload.id,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async #notifyApproval(threadId: string, approval: PendingApproval): Promise<void> {
		const meta = this.#openSessions.get(threadId);
		const title = `Oryn 授权请求（${meta?.threadTitle ?? threadId}）`;
		try {
			await chrome.notifications?.create(approval.id, {
				type: "basic",
				iconUrl: NOTIFICATION_ICON,
				title,
				message: `${approval.summary} — 点击浏览器右上角 Oryn 扩展图标确认`,
				priority: 2,
			});
		} catch {
			// 通知权限缺失时静默降级
		}
	}

	#notifyPopup(): void {
		void chrome.runtime.sendMessage({ t: "cloud.changed" }).catch(() => {});
	}

	async #handleRevoked(reason: string): Promise<void> {
		this.#lastError = reason;
		await this.unpair();
	}

	#sendSessionState(threadId: string): void {
		const sum = this.policy.getSummary(threadId);
		this.#send({
			t: "session.state",
			threadId,
			sharedTabCount: sum.sharedTabs.length,
			pendingApprovals: sum.pendingApprovals.length,
			autoApproveCreateTab: sum.autoApproveCreateTab,
		});
	}

	#sendFrame(threadId: string, payload: ExtToRelayMessage): void {
		this.#send({ t: "session.frame", threadId, payload });
	}

	#send(msg: Record<string, unknown>): void {
		if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
			this.#ws.send(JSON.stringify(msg));
		}
	}

	async #refreshBadge(): Promise<void> {
		const pending = this.policy.totalPendingApprovals();
		if (pending > 0) {
			await this.#host.setBadge("!", "#d97706");
			return;
		}
		if (this.#connected) {
			await this.#host.setBadge("on", "#1a7f37");
			return;
		}
		await this.#host.setBadge("off", "#8b8b8b");
	}

	#scheduleReconnect(): void {
		if (this.#reconnectTimer) return;
		const delay = this.#reconnectDelay;
		this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, RECONNECT_MAX_MS);
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = null;
			void this.connect();
		}, delay);
	}

	#clearTimers(): void {
		clearInterval(this.#pingTimer ?? undefined);
		this.#pingTimer = null;
		clearTimeout(this.#reconnectTimer ?? undefined);
		this.#reconnectTimer = null;
	}
}
